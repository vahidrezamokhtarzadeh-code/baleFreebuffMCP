// Freebuff CLI PTY Wrapper — transcript-based response extraction
//
// Freebuff is a TUI, so there is no API to read from: we mirror its terminal
// into a VTScreen and read back the resulting transcript. Two properties make
// this workable:
//
//   1. Scrollback. VTScreen keeps every line that scrolls off the top, so a
//      reply longer than the visible pane is no longer truncated.
//   2. A sentinel. The TUI echoes the prompt into the transcript, so we can
//      cut the reply at the echo instead of guessing with heuristics.
//
// Completion is detected by hashing the transcript: when the digest stops
// changing for STABLE_MS, Freebuff has finished. That catches in-place edits,
// which a length-based check misses.

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { VTScreen } from './vt-screen.js';
import { extractResponse, conversationText, hasCompletionFooter, digest } from './extract.js';

// ─── State Machine ────────────────────────────────────────────────

const STATE = {
  STARTING: 'starting',
  IDLE: 'idle',
  PROCESSING: 'processing',
};

// ─── Freebuff TUI Layout ──────────────────────────────────────────
// Freebuff paints a splash/logo and a stats box at the top, the conversation
// in the middle, then a status bar, an input box and a model bar at the
// bottom. The row where the conversation ends moves with the terminal size and
// the Freebuff version, so it is detected from the status bar's own content
// (see conversationText in extract.js) rather than hardcoded.
//
// FALLBACK_CONVO_END_ROW is only used if no status bar is on screen at all.

const FALLBACK_CONVO_END_ROW = 30;

const SCREEN_COLS = 120;
const SCREEN_ROWS = 40;

// ─── Response detection tuning ────────────────────────────────────

const POLL_MS = 1_000;        // how often we look at the screen
const MIN_WAIT_MS = 8_000;    // never accept a reply faster than this
const STABLE_MS = 8_000;      // fallback: transcript unchanged for this long
const PROGRESS_INTERVAL_MS = 5_000;

const DEBUG = !!process.env.FREEBUFF_DEBUG;
const debug = (...args) => { if (DEBUG) console.log(...args); };

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

    this.screen = new VTScreen(SCREEN_COLS, SCREEN_ROWS);

    // Per-request extraction state
    this._preInputTranscript = '';
    this._sentinel = null;

    // Config
    this.startupTimeout = 45_000;
    this.responseWaitMs = responseWaitMs;
    this.maxIdleMs = 30 * 60 * 1000;

    // Timers
    this._startupTimer = null;
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
        cols: SCREEN_COLS,
        rows: SCREEN_ROWS,
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
        debug(`📦 [PTY] startup chunk #${this._chunkCount}...`);
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

    // Snapshot the transcript and remember the prompt as a sentinel.
    this._preInputTranscript = this._getTranscript();
    this._sentinel = text.trim().split('\n')[0];
    this._chunkCount = 0;

    debug(`📸 [SEND] Pre-input transcript (${this._preInputTranscript.length} chars), ` +
      `scrollback=${this.screen.getScrollbackLength()}`);

    // Write input then Enter
    this.ptyProcess.write(text);
    await new Promise(r => setTimeout(r, 50));
    const enterKey = process.platform === 'win32' ? '\r' : '\n';
    this.ptyProcess.write(enterKey);

    await this._waitForResponse();
  }

  // ─── Response Detection ──────────────────────────────────────────
  // Wait until the transcript stops changing (Freebuff is done) or we run out
  // of patience.

  async _waitForResponse() {
    const maxWaitMs = this.responseWaitMs;
    let lastDigest = digest(this._getTranscript());
    let stableSince = Date.now();
    let sawReply = false;
    let done = false;
    let nextProgressAt = PROGRESS_INTERVAL_MS;
    const startedAt = Date.now();

    console.log(`⏱️  [WAIT] Watching transcript (max ${maxWaitMs / 1000}s, ` +
      `stable ${STABLE_MS / 1000}s)`);

    while (Date.now() - startedAt < maxWaitMs) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const elapsed = Date.now() - startedAt;

      const transcript = this._getTranscript();
      const currentDigest = digest(transcript);

      if (currentDigest !== lastDigest) {
        lastDigest = currentDigest;
        stableSince = Date.now();
        debug(`📊 [WAIT] transcript changed at ${elapsed / 1000}s (${transcript.length} chars)`);
      }

      // Don't declare victory on an unchanged-but-empty screen: require that
      // something was actually extracted for this request.
      let extracted = null;
      if (!sawReply || !done) {
        extracted = extractResponse({
          before: this._preInputTranscript,
          after: transcript,
          sentinel: this._sentinel,
        });
        if (extracted.text) sawReply = true;

        // Freebuff stamps finished replies with a duration footer. Prefer it:
        // the model pauses for several seconds between tool calls, so silence
        // alone would cut a multi-step reply short.
        if (extracted.text && hasCompletionFooter(transcript, extracted.index)) {
          console.log(`✅ [WAIT] Completion footer seen at ${Math.floor(elapsed / 1000)}s`);
          done = true;
          break;
        }
      }

      if (elapsed >= nextProgressAt) {
        nextProgressAt += PROGRESS_INTERVAL_MS;
        this.emit('progress', {
          elapsed: Math.floor(elapsed / 1000),
          maxWait: Math.floor(maxWaitMs / 1000),
          contentLength: transcript.length,
        });
      }

      const stableFor = Date.now() - stableSince;
      if (stableFor >= STABLE_MS && elapsed >= MIN_WAIT_MS && sawReply && !done) {
        console.log(`✅ [WAIT] Reply complete after ${Math.floor(elapsed / 1000)}s ` +
          `(stable for ${Math.floor(stableFor / 1000)}s, no footer)`);
        this._grabAndFlush();
        return;
      }
    }

    console.log(`⏱️  [WAIT] Max wait reached (${maxWaitMs / 1000}s), grabbing what we have`);
    this._grabAndFlush();
  }

  // ─── Transcript ────────────────────────────────────────────────

  // Scrollback + the visible rows above the status bar. Reading the transcript
  // rather than a fixed screen region is what lets long replies survive.
  _getTranscript() {
    return conversationText(this.screen, { fallbackEndRow: FALLBACK_CONVO_END_ROW });
  }

  _grabAndFlush() {
    if (this.state !== STATE.PROCESSING) {
      console.log(`⚠️  [GRAB] Ignored — state is ${this.state}`);
      return;
    }

    const transcript = this._getTranscript();
    const { text, strategy, index } = extractResponse({
      before: this._preInputTranscript,
      after: transcript,
      sentinel: this._sentinel,
    });

    console.log(`📥 [GRAB] ${text.length} chars via ${strategy} (cut at line ${index}), ` +
      `${this._chunkCount} chunks, scrollback=${this.screen.getScrollbackLength()}`);
    debug(`📥 [GRAB] Transcript:\n---\n${transcript}\n---\n📥 [GRAB] Reply:\n${text}`);

    this._setState(STATE.IDLE);

    if (text.length > 0) {
      this.emit('response', text);
    } else {
      this.emit('response_empty');
    }
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

  getStatus() {
    const uptime = Math.floor((Date.now() - this.sessionStartTime) / 60000);
    return {
      state: this.state,
      uptime,
      cwd: this.cwd,
      pid: this.ptyProcess?.pid,
    };
  }

  destroy() {
    this.destroyed = true;
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._idleTimer) clearTimeout(this._idleTimer);

    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch {}
      this.ptyProcess = null;
    }
    this.emit('destroyed');
  }
}