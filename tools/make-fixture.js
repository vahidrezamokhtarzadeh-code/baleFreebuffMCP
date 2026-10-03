// Synthetic fixture generator.
//
// Real captures come from tools/record-session.js, but CI (and anyone without
// a Freebuff install) still needs something to test against. This writes
// fixtures that mirror the real Freebuff layout recorded on 2026-10-03:
// a persistent block-character splash, a bordered stats box, the conversation
// pane, a status bar with a live countdown, an input box, and a model bar.
//
// The layout matters: extraction cuts the transcript just above the status bar,
// and only a fixture that *has* a status bar exercises that detection.
//
// Scenarios generated:
//   short-reply  — fits on screen, prompt echoed
//   long-reply   — 60 lines, overflows the pane into scrollback, prompt echoed
//   no-echo      — prompt is not echoed, forcing the diff fallback
//
// Usage: node tools/make-fixture.js [--out fixtures]

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { INPUT_MARKER } from '../src/replay.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ESC = '\x1b';
const COLS = 120;
const ROWS = 40;

// Row geometry (1-indexed, as a real terminal sees it)
const CONVO_TOP = 19;
const CONVO_BOTTOM = 32;
const STATUS_ROW = 33;
const INPUT_TOP = 34;
const INPUT_BOTTOM = 38;
const MODEL_ROW = 39;
const HINTS_ROW = 40;

const logoLines = [
  ' ███████████                        ██                 ▄████  ▄██',
  ' ███▀▀▀▀▀▀▀▀                        ██                 ██    ██▀',
  ' ███ █████  ██████ ▄█████   ▄████▄  ██████▄  ██   ██ ████████████',
  ' ███ ███▀▀  ██▀   ███▄▄▄██ ██▄▄▄███ ██   ▀██ ██   ██   ██    ██',
  ' ███ ███    ███   ███▀▀▀▀▀ ██▀▀▀▀▀  ██▄  ▄██ ██▄  ██   ██    ██',
  ' ███ ██▀    ██▀    ▀█████   ▀████▀  ██████▀   ▀████▀   ██    ██',
];

const statsBox = [
  ' ┌──────────────────────────────────────────────────────────────────┐',
  ' │ Your first message starts the session.                           │',
  ' │ 15/25 Freebucks remaining                                        │',
  ' └──────────────────────────────────────────────────────────────────┘',
];

// The status bar re-renders its countdown every minute, so extraction must cut
// above it or the "has output stopped?" check never settles.
const statusBar = (remaining, usage) =>
  ` ${remaining} left${usage ? ` · ${usage}` : '                                                    '}` +
  `                      ✕ End session`;

function paint(row, text) {
  return `${ESC}[${row};1H${text}`;
}

// Paint the persistent chrome, then stream the conversation downward.
//
// Real Freebuff emits no scrolling region (no CSI r in the recorded session) and
// lets output run to the bottom of the terminal, scrolling the whole screen
// when it wraps. Streaming it the same way here is what makes the fixture
// exercise scrollback the way production does — stopping at the pane bottom
// would silently overwrite lines instead.
function streamIntoPane(lines) {
  // 3J drops the scrollback as well as 2J's screen clear, so each frame starts
  // from a clean transcript instead of duplicating the previous one.
  let out = `${ESC}[2J${ESC}[3J${ESC}[H`;

  logoLines.forEach((line, i) => { out += paint(i + 1, line); });
  statsBox.forEach((line, i) => { out += paint(i + 8, line); });

  out += paint(CONVO_TOP, '');
  for (const line of lines) {
    out += `${line}\r\n`;
  }

  // Scroll the overflow into scrollback so the pane's last lines end up sitting
  // just above the status bar. Without this, the chrome repaint below would
  // overwrite the tail of the reply — which is the whole point of scrollback.
  const paneHeight = CONVO_BOTTOM - CONVO_TOP + 1;
  const overflow = Math.max(0, lines.length - paneHeight);
  if (overflow > 0) {
    out += paint(STATUS_ROW, '') + '\n'.repeat(overflow);
  }
  return out;
}

// Repaint the chrome that sits below the conversation, over whatever streamed
// past it. Also used to stamp the status bar before the prompt is sent.
function paintFooterChrome({ remaining, usage = '', footer = '' } = {}) {
  let out = '';
  if (footer) out += paint(CONVO_BOTTOM, `${' '.repeat(COLS - footer.length - 1)}${footer}`);
  out += paint(STATUS_ROW, statusBar(remaining, usage));
  out += paintInputArea();
  out += paint(MODEL_ROW, ' MiMo 2.6 Flash · ~/repo · /model to change · Chat: New chat');
  out += paint(HINTS_ROW, ' ← for history · ? for help');
  return out;
}

function paintInputArea(placeholder = 'Enter a coding task or / for commands') {
  let out = paint(INPUT_TOP, '╭────────────────────────────────────────────────────────────────────────────────────────╮');
  for (let r = INPUT_TOP + 1; r <= INPUT_BOTTOM - 1; r++) {
    out += paint(r, `│${' '.repeat(COLS - 2)}│`);
  }
  out += paint(INPUT_BOTTOM, '╰────────────────────────────────────────────────────────────────────────────────────────╯');
  out += paint(INPUT_TOP + 2, `│  ▍${placeholder}${' '.repeat(20)}│`);
  return out;
}

function buildFixture({ name, input, echoPrompt, replyLines, thinkingLines = [], detailLines = [] }) {
  const chunks = [];
  let t = 0;

  // Everything the user sees before their prompt is submitted
  chunks.push({ t, data: streamIntoPane([]) + paintFooterChrome({ remaining: '45m' }) });
  t += 120;

  chunks.push({ t, marker: INPUT_MARKER });

  t += 60;
  const pane = [];
  if (echoPrompt) pane.push(`   ${input} ⎘`);
  pane.push(...thinkingLines);
  pane.push(...detailLines);
  pane.push(...replyLines);
  chunks.push({ t, data: streamIntoPane(pane) });

  // A finished reply carries a duration footer; the status bar then ticks over
  // with token usage, exactly like the real TUI.
  t += 4000;
  chunks.push({
    t,
    data: paintFooterChrome({ remaining: '44m', usage: '11.9K (9%)', footer: '⎘ • 4s • △▽   ▄' }),
  });

  return {
    version: 1,
    name,
    recordedAt: '2026-01-01T00:00:00.000Z',
    synthetic: true,
    meta: {
      cols: COLS,
      rows: ROWS,
      cwd: '/synthetic',
      freebuffPath: 'freebuff',
      input,
      platform: 'synthetic',
    },
    chunks,
  };
}

// ─── Scenarios ───────────────────────────────────────────────────

const SHORT_INPUT = 'what files are in src';

const shortReply = [
  '',
  '  The src directory contains 7 modules:',
  '  index.js        — entry point',
  '  bridge.js       — message routing',
  '  bale.js         — Bale API client',
  '  freebuff.js     — PTY wrapper',
  '  extract.js      — response extraction',
  '  replay.js       — fixture replay',
  '  vt-screen.js    — terminal emulator',
];

// 60 lines: far more than the visible conversation pane, so most of this
// reply only exists in scrollback.
const longReply = Array.from({ length: 60 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `  LINE-${n} explanation of the architecture at step ${i + 1}`;
});

const thinkingLines = ['  • Thinking'];
// Reasoning is indented deeper than the header — that is what marks it as
// reasoning rather than part of the answer.
const detailLines = ['    weighing the options before answering'];

const FIXTURES = [
  buildFixture({
    name: 'short-reply',
    input: SHORT_INPUT,
    echoPrompt: true,
    thinkingLines,
    replyLines: shortReply,
  }),
  buildFixture({
    name: 'long-reply',
    input: SHORT_INPUT,
    echoPrompt: true,
    thinkingLines,
    replyLines: longReply,
  }),
  buildFixture({
    name: 'no-echo',
    input: SHORT_INPUT,
    echoPrompt: false,
    thinkingLines,
    replyLines: shortReply,
  }),
];

// ─── Main ────────────────────────────────────────────────────────

const outArg = process.argv.indexOf('--out');
const outDir = resolve(PROJECT_ROOT, outArg !== -1 ? process.argv[outArg + 1] : 'fixtures');
mkdirSync(outDir, { recursive: true });

for (const fixture of FIXTURES) {
  const file = join(outDir, `${fixture.name}.json`);
  writeFileSync(file, `${JSON.stringify(fixture)}\n`, 'utf-8');
  console.log(`[fixtures] wrote ${file}`);
}

console.log(`\nRecord real sessions with:`);
console.log(`  node tools/record-session.js --input "your prompt" --name real-session`);