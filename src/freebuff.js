// Freebuff CLI PTY Wrapper — Region-based Screen Extraction
// Extracts response from Freebuff's conversation area only (middle rows)
// Ignores TUI chrome: logo (top), status bar (bottom), input area

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { VTScreen } from './vt-screen.js';

// ─── State Machine ────────────────────────────────────────────────

const STATE = {
  STARTING: 'starting',
  IDLE: 'idle',
  PROCESSING: 'processing',
};

// ─── Freebuff TUI Layout ──────────────────────────────────────────
// Rows 0-8:   Logo / branding
// Rows 9-30:  Conversation content (scrollable)
// Rows 31-36: Status bar (sessions used, model, time)
// Rows 37-39: Input area (prompt)

const CONVO_START_ROW = 9;   // Skip logo/branding
const CONVO_END_ROW = 31;    // Skip status bar/input

// ─── Noise Patterns ───────────────────────────────────────────────
// Lines matching these are ALWAYS filtered out (TUI chrome)

const NOISE_PATTERNS = [
  // Box drawing / border chars
  /^[╔╗╚╝═║┌┐└┘█─│├┤┬┴┼╭╮╰╯░▒▓▀▄▌▐▲▼◀►◄△▽✦✧✕⎘◆◇○●□■썸│]+$/,

  // Freebuff status bar
  /^\s*\d+\.?\d*\s+of\s+\d+\s+sessions/,
  /^\s*sessions\s+used/,
  /^\s*resets\s+in\s+\d+[hm]/,
  /^\s*\d+[hm]\s+left/,
  /^\s*(MiMo|DeepSeek|MiniMax|GPT|Gemini|Claude)\s+[\d.]+/i,
  /^\s*End\s+session/i,
  /^\s*✕\s*End/,

  // Timestamps
  /^\s*\[[\d:.]+\s*[AP]M\]\s*$/,

  // Freebuff chrome
  /^\s*Freebuff will run/,
  /^\s*Directory\s+~/,
  /^\s*Ask Freebuff/,
  /^\s*sandbox\s+running/,
  /^\s*dev server/,

  // Thinking / action indicators
  /^\s*[▸▹•·]?\s*(Thinking|Reading|Editing|Planning|Searching|Running|Analyzing|Mapping|Checking|Building|Inspecting|Writing|Fixing|Refactoring|Exploring|Connecting)/i,

  // Prompt lines
  /^\s*❯\s*$/,
  /^\s*>\s*$/,
  /^\s*▍/,
  /^\s*Enter a coding task/,
  /^\s*coding task or/,

  // Metadata symbols
  /^\s*⎘\s*$/,
  /^\s*△▽\s*$/,
  /^\s*✕\s*$/,
  /^\s*[•·]\s*\d+s\s*[•·]/,

  // Empty / whitespace only
  /^\s*$/,
];

// ─── FreebuffSession ──────────────────────────────────────────────

export class FreebuffSession extends EventEmitter {
  constructor({
    freebuffPath = 'freebuff',
    cwd = process.cwd(),
    sessionTimeoutMs = 30 * 60 * 1000,
    responseWaitMs = 60_000,
  } = {}) {
    super();
    this.freebuffPath = freebuffPath;
    this.cwd = cwd;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.ptyProcess = null;
    this.state = STATE.STARTING;
    this.sessionStartTime = 0;
    this.destroyed = false;

    // VT screen for content extraction
    this.screen = new VTScreen(120, 40);
    this._preInputConvo = ''; // Conversation area BEFORE input

    // Config
    this.startupTimeout = 45_000;
    this.responseWaitMs = responseWaitMs;
    this.maxIdleMs = 30 * 60 * 1000;

    // Timers
    this._startupTimer = null;
    this._responseTimer = null;
    this._idleTimer = null;

    this._chunkCount = 0;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  spawn() {
    if (this.ptyProcess) return;

    this.sessionStartTime = Date.now();
    this.state = STATE.STARTING;
    this.screen.reset();
    this._chunkCount = 0;

    console.log(`🚀 [SESSION] Spawning Freebuff in ${this.cwd}`);
    console.log(`🚀 [SESSION] Freebuff path: ${this.freebuffPath}`);

    let command = this.freebuffPath;
    let args = [];

    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/c', this.freebuffPath];
      console.log(`🚀 [SESSION] Windows: using cmd.exe /c`);
    }

    try {
      this.ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          NO_COLOR: '1',
          CI: '1',
        },
      });
    } catch (err) {
      console.error(`❌ [SESSION] Failed to spawn PTY: ${err.message}`);
      this.emit('exit', { exitCode: -1 });
      return;
    }

    console.log(`✅ [SESSION] PTY spawned (pid=${this.ptyProcess.pid})`);

    this.ptyProcess.onData((data) => {
      if (this.destroyed) return;
      this._chunkCount++;
      this.screen.process(data);

      if (this.state === STATE.STARTING && this._chunkCount % 100 === 0) {
        console.log(`📦 [PTY] startup chunk #${this._chunkCount}...`);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`🔴 [SESSION] Freebuff exited (code=${exitCode}, signal=${signal})`);
      this.state = STATE.STARTING;
      this.emit('exit', { exitCode });
    });

    this._startupTimer = setTimeout(() => {
      if (this.state === STATE.STARTING) {
        console.log(`✅ [SESSION] Startup complete (after ${this.startupTimeout / 1000}s)`);
        this._setState(STATE.IDLE);
      }
    }, this.startupTimeout);
  }

  // ─── State Management ─────────────────────────────────────────

  _setState(newState) {
    const old = this.state;
    this.state = newState;
    console.log(`🔄 [STATE] ${old} → ${newState}`);

    if (this._startupTimer) { clearTimeout(this._startupTimer); this._startupTimer = null; }

    if (newState === STATE.IDLE) {
      this._resetIdleTimer();
      if (old === STATE.STARTING) {
        this.emit('ready');
      }
    }
  }

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.state === STATE.IDLE) {
        console.log(`⏰ [SESSION] Idle timeout, destroying session`);
        this.emit('exit', { exitCode: 0 });
        this.destroy();
      }
    }, this.maxIdleMs);
  }

  // ─── Input / Response ─────────────────────────────────────────

  async sendInput(text) {
    if (this.destroyed || !this.ptyProcess) {
      throw new Error('Session is not running');
    }
    if (this.state !== STATE.IDLE) {
      throw new Error(`Cannot send input in state: ${this.state}`);
    }

    console.log(`📤 [SEND] Input: "${text.substring(0, 100)}"`);
    this.state = STATE.PROCESSING;
    console.log(`📤 [SEND] State → PROCESSING`);

    // Snapshot conversation area BEFORE sending input
    this._preInputConvo = this._getConvoArea();
    console.log(`📸 [SEND] Pre-input convo snapshot (${this._preInputConvo.length} chars)`);
    this._chunkCount = 0;

    // Write input then Enter
    this.ptyProcess.write(text);
    await new Promise(r => setTimeout(r, 50));
    const enterKey = process.platform === 'win32' ? '\r' : '\n';
    this.ptyProcess.write(enterKey);
    console.log(`📤 [SEND] Input + Enter written to PTY`);

    // Wait for response
    console.log(`⏱️  [SEND] Waiting ${this.responseWaitMs / 1000}s for response...`);
    await new Promise(r => setTimeout(r, this.responseWaitMs));

    // Grab the response
    this._grabAndFlush();
  }

  // ─── Screen Region Extraction ─────────────────────────────────

  // Get only the conversation area rows (skip logo, status bar, input)
  _getConvoArea() {
    return this.screen.getRegion(CONVO_START_ROW, CONVO_END_ROW);
  }

  _grabAndFlush() {
    if (this.state !== STATE.PROCESSING) {
      console.log(`⚠️  [GRAB] Ignored — state is ${this.state}`);
      return;
    }

    const postConvo = this._getConvoArea();
    console.log(`📥 [GRAB] Post-input convo area: ${postConvo.length} chars, ${this._chunkCount} chunks`);

    // Log the raw convo for debugging
    console.log(`📥 [GRAB] Raw convo area:\n---\n${postConvo}\n---`);

    // Extract response by diffing conversation areas
    const responseText = this._extractResponse(this._preInputConvo, postConvo);

    console.log(`📥 [GRAB] Extracted response length: ${responseText.length}`);
    console.log(`📥 [GRAB] Response:\n"${responseText}"`);

    this._setState(STATE.IDLE);

    if (responseText.length > 0) {
      console.log(`✅ [GRAB] Emitting response (${responseText.length} chars)`);
      this.emit('response', responseText);
    } else {
      console.log(`⚠️  [GRAB] Empty response`);
      this.emit('response_empty');
    }
  }

  // ─── Response Extraction ──────────────────────────────────────

  _extractResponse(beforeText, afterText) {
    const beforeLines = this._filterNoise(beforeText.split('\n'));
    const afterLines = this._filterNoise(afterText.split('\n'));

    console.log(`🔍 [EXTRACT] Before: ${beforeLines.length} lines, After: ${afterLines.length} lines`);

    // Strategy: find lines in "after" that are NOT in "before"
    // These are the new response lines
    const beforeSet = new Set(beforeLines);

    // Find the start of new content
    // New content starts after the last line that matches "before"
    let lastMatchIdx = -1;
    for (let i = 0; i < afterLines.length; i++) {
      if (beforeSet.has(afterLines[i]) && afterLines[i].length > 5) {
        lastMatchIdx = i;
      }
    }

    // New content is everything after the last matching line
    const newLines = afterLines.slice(lastMatchIdx + 1);

    // Post-process the new lines
    return this._postProcessResponse(newLines);
  }

  _filterNoise(lines) {
    return lines
      .map(l => l.trimEnd())
      .filter(l => {
        const trimmed = l.trim();
        return !NOISE_PATTERNS.some(re => re.test(trimmed));
      });
  }

  _postProcessResponse(lines) {
    const filtered = [];
    let skipThinking = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty
      if (trimmed.length === 0) continue;

      // Handle thinking blocks: skip indented reasoning after ▸ Thinking
      if (/^[▸▹]?\s*(Thinking|Reading|Editing|Planning|Searching|Running|Analyzing|Mapping|Checking|Building|Inspecting|Writing|Fixing|Refactoring|Exploring)/i.test(trimmed)) {
        skipThinking = true;
        continue;
      }

      if (skipThinking) {
        // Skip lines that look like reasoning (indented, short, descriptive)
        if (/^(\s{2,}|\t)/.test(line) && trimmed.length < 200) {
          continue;
        }
        skipThinking = false;
      }

      // Skip box drawing
      if (/^[╔╗╚╝═║┌┐└┘█─│├┤┬┴┼╭╮╰╯░▒▓▀▄▌▐▲▼◀►◄△▽✦✧✕⎘◆◇○●□■썸│]+$/.test(trimmed)) continue;

      // Skip very short fragments
      if (trimmed.length < 2) continue;

      filtered.push(line);
    }

    // Collapse multiple blank lines
    const result = [];
    let blanks = 0;
    for (const line of filtered) {
      if (line.trim().length === 0) {
        blanks++;
        if (blanks <= 1) result.push(line);
      } else {
        blanks = 0;
        result.push(line);
      }
    }

    return result.join('\n').trim();
  }

  // ─── Status ───────────────────────────────────────────────────

  isAlive() {
    if (!this.ptyProcess) return false;
    if (Date.now() - this.sessionStartTime > this.sessionTimeoutMs) return false;
    return true;
  }

  isIdle() {
    return this.state === STATE.IDLE;
  }

  destroy() {
    this.destroyed = true;
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._responseTimer) clearTimeout(this._responseTimer);
    if (this._idleTimer) clearTimeout(this._idleTimer);

    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch {}
      this.ptyProcess = null;
    }
    this.emit('destroyed');
  }
}
