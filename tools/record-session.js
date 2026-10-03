// Session recorder — captures a real Freebuff PTY session to a fixture file.
//
// The extraction pipeline (src/vt-screen.js + src/extract.js) is the part of
// this bot most likely to break, because it depends on how Freebuff's TUI
// happens to paint its screen. Recording real sessions lets us test and tune
// that pipeline offline, without spawning Freebuff or talking to the API.
//
// The recorder deliberately uses the *same* screen mirroring, readiness check
// and reply-stability check as src/freebuff.js, so a fixture records what
// production would actually have seen.
//
// Usage:
//   node tools/record-session.js --input "list the files in src" --name list-files
//   node tools/record-session.js --input "explain this repo" --out fixtures/long.json
//   node tools/record-session.js --replay fixtures/long.json        # no PTY, prints reply
//
// Options:
//   --input <text>     prompt to type (required unless --replay)
//   --name <name>      fixture name; file goes to fixtures/<name>.json
//   --out <file>       explicit output path
//   --cwd <dir>        working directory for Freebuff (default: cwd)
//   --freebuff <path>  freebuff executable (default: freebuff)
//   --cols/--rows      terminal size (default: 120x40)
//   --startup <ms>     max wait for Freebuff to become ready (default: 120000)
//   --settle <ms>      max wait for the reply to stop changing (default: 120000)
//   --send-delay <ms>  pause between typing and Enter (default: 800)
//   --replay <file>    replay a fixture instead of spawning Freebuff
//   --text             also write a human-readable .txt next to the fixture

import * as pty from 'node-pty';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { VTScreen } from '../src/vt-screen.js';
import { conversationText, hasCompletionFooter, extractResponse, digest } from '../src/extract.js';
import { replayFixture, INPUT_MARKER } from '../src/replay.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(PROJECT_ROOT, 'fixtures');

// Freebuff draws this placeholder in the input box once it is accepting input.
const READY_MARKER = /Enter a coding task/i;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const STABLE_MS = 8_000;
const POLL_MS = 500;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Recorder ─────────────────────────────────────────────────────

class Recorder {
  constructor({ cols, rows, cwd, freebuffPath, startupMs, settleMs, sendDelayMs }) {
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.freebuffPath = freebuffPath;
    this.startupMs = startupMs;
    this.settleMs = settleMs;
    this.sendDelayMs = sendDelayMs;

    this.screen = new VTScreen(cols, rows);
    this.chunks = [];
    this.startTime = Date.now();
  }

  start() {
    // On Windows, Freebuff is a .cmd shim, so it has to be launched via cmd.exe.
    let command = this.freebuffPath;
    let argv = [];
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      argv = ['/c', this.freebuffPath];
    }

    try {
      this.proc = pty.spawn(command, argv, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', CI: '1' },
      });
    } catch (err) {
      throw new Error(
        `Could not spawn "${this.freebuffPath}": ${err.message}\n` +
        `Is Freebuff installed? Check with: ${this.freebuffPath} --version`
      );
    }

    this.proc.onData(data => {
      this.chunks.push({ t: Date.now() - this.startTime, data });
      this.screen.process(data);
    });
    this.proc.onExit(({ exitCode }) => {
      console.log(`\n[rec] Freebuff exited (code=${exitCode})`);
      this.exited = true;
    });

    console.log(`[rec] spawned ${this.freebuffPath} (pid=${this.proc.pid}) in ${this.cwd}`);
  }

  // Freebuff animates its splash continuously, so "output stopped" is never
  // true during startup. Wait for the input box placeholder instead — that is
  // the first moment keystrokes are actually accepted.
  async waitUntilReady() {
    const deadline = Date.now() + this.startupMs;
    let lastLogged = 0;

    while (Date.now() < deadline && !this.exited) {
      if (READY_MARKER.test(this.screen.getText())) {
        console.log(`[rec] Freebuff ready after ${Math.round((Date.now() - this.startTime) / 1000)}s`);
        return true;
      }
      if (Date.now() - lastLogged > 5000) {
        lastLogged = Date.now();
        process.stdout.write('.');
      }
      await sleep(POLL_MS);
    }

    console.log('\n[rec] WARNING: never saw the ready marker; sending anyway');
    return false;
  }

  async send(text) {
    console.log(`[rec] sending: ${JSON.stringify(text)}`);
    // Mark the boundary so replay knows where the prior conversation ends.
    this.chunks.push({ t: Date.now() - this.startTime, marker: INPUT_MARKER });
    this.before = conversationText(this.screen);
    this.input = text;

    // Typing and Enter are separate writes: sending them in the same tick gets
    // swallowed by the TUI's input handler on some platforms.
    this.proc.write(text);
    await sleep(this.sendDelayMs);
    this.proc.write(process.platform === 'win32' ? '\r' : '\n');
  }

  // Wait until the reply is finished, using the same two signals as the live
  // session: the duration footer Freebuff stamps on completed replies, and a
  // fallback stability check for replies that never get one.
  async waitForReply() {
    const deadline = Date.now() + this.settleMs;
    let lastDigest = digest(conversationText(this.screen));
    let stableSince = Date.now();
    let sawReply = false;

    while (Date.now() < deadline && !this.exited) {
      await sleep(POLL_MS);

      const conversation = conversationText(this.screen);
      const current = digest(conversation);
      if (current !== lastDigest) {
        lastDigest = current;
        stableSince = Date.now();
        process.stdout.write('.');
      }

      // Silence is not completion. The model pauses for several seconds before
      // the first token, so require actual extracted reply text before letting
      // the stability fallback fire — otherwise the fixture captures a prompt
      // echo and nothing else.
      const { text, index } = extractResponse({
        before: this.before,
        after: conversation,
        sentinel: this.input,
      });
      if (text) sawReply = true;

      if (text && hasCompletionFooter(conversation, index)) {
        console.log(`\n[rec] completion footer at ${Math.round((Date.now() - this.startTime) / 1000)}s`);
        return true;
      }

      if (sawReply && Date.now() - stableSince >= STABLE_MS) {
        console.log(`\n[rec] reply settled after ${Math.round((Date.now() - this.startTime) / 1000)}s`);
        return true;
      }
    }

    console.log('\n[rec] WARNING: reply never settled; recording anyway');
    return false;
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  toFixture(name, input) {
    return {
      version: 1,
      name,
      recordedAt: new Date().toISOString(),
      meta: {
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        freebuffPath: this.freebuffPath,
        input,
        platform: process.platform,
      },
      chunks: this.chunks,
    };
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.replay) {
    const file = resolve(PROJECT_ROOT, args.replay);
    if (!existsSync(file)) {
      console.error(`No such fixture: ${file}`);
      process.exit(1);
    }
    const fixture = JSON.parse(readFileSync(file, 'utf-8'));
    const result = replayFixture(fixture);
    console.log(`\n--- conversation ---\n${result.transcript}`);
    console.log(`\n--- reply (${result.strategy}) ---\n${result.text}\n`);
    console.log(`strategy=${result.strategy} chars=${result.text.length} ` +
      `scrollback=${result.scrollbackLines}`);
    return;
  }

  if (!args.input) {
    console.error('Usage: node tools/record-session.js --input "<prompt>" [--name <name>]');
    console.error('       node tools/record-session.js --replay <fixture.json>');
    process.exit(1);
  }

  const name = args.name || `session-${Date.now()}`;
  const outFile = args.out
    ? resolve(PROJECT_ROOT, args.out)
    : join(FIXTURE_DIR, `${name}.json`);

  const recorder = new Recorder({
    cols: Number(args.cols) || DEFAULT_COLS,
    rows: Number(args.rows) || DEFAULT_ROWS,
    cwd: args.cwd ? resolve(PROJECT_ROOT, args.cwd) : process.cwd(),
    freebuffPath: args.freebuff || 'freebuff',
    startupMs: Number(args.startup) || 120_000,
    settleMs: Number(args.settle) || 120_000,
    sendDelayMs: Number(args['send-delay']) || 800,
  });

  const shutdown = () => { recorder.stop(); process.exit(130); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Killing a ConPTY process races with node-pty's console-list agent on
  // Windows; the fixture is already on disk by then, so ignore it.
  process.on('uncaughtException', (err) => {
    if (/AttachConsole failed/.test(err.message)) {
      console.error('[rec] ignoring node-pty teardown error:', err.message);
      return;
    }
    console.error('[rec] fatal:', err);
    process.exit(1);
  });

  recorder.start();
  await recorder.waitUntilReady();
  await recorder.send(args.input);
  await recorder.waitForReply();

  recorder.stop();

  const fixture = recorder.toFixture(name, args.input);
  mkdirSync(dirname(outFile), { recursive: true });
  // Compact: raw escape sequences make these files large and a pretty-printed
  // wall of \u001b[ does not help anyone reading a diff.
  writeFileSync(outFile, `${JSON.stringify(fixture)}\n`, 'utf-8');
  console.log(`[rec] wrote ${outFile} (${fixture.chunks.length} chunks)`);

  const result = replayFixture(fixture);
  console.log(`[rec] extracted ${result.text.length} chars via ${result.strategy} ` +
    `(scrollback ${result.scrollbackLines} lines)`);

  if (args.text) {
    const txtFile = outFile.replace(/\.json$/, '.txt');
    writeFileSync(txtFile,
      `${result.transcript}\n\n--- reply ---\n${result.text}\n`, 'utf-8');
    console.log(`[rec] wrote ${txtFile}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(err => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}