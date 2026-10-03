// Diagnostic: what terminal size does a process actually see inside our PTY?
//
// node-pty is given cols/rows, but ConPTY (Windows) can ignore them in favour of
// the real console size. If Freebuff renders at a different width than we
// emulate, every line past our column limit is silently dropped — which shows
// up as garbled, half-word output. Run this to compare.
//
// Usage: node tools/probe-size.js [command...]      e.g. node tools/probe-size.js freebuff

import * as pty from 'node-pty';

const COLS = Number(process.env.PROBE_COLS) || 120;
const ROWS = Number(process.env.PROBE_ROWS) || 40;

const command = process.argv[2] || process.execPath;
const args = process.argv.slice(3);

console.log(`command: ${command} ${args.join(' ')}`);
console.log(`pty requested size: ${COLS}x${ROWS}`);
console.log(`host process.stdout: ${process.stdout.columns}x${process.stdout.rows}`);

const childArgs = args.length ? args : [
  '-e',
  'console.log("child sees: " + process.stdout.columns + "x" + process.stdout.rows)',
];

const proc = pty.spawn(command, childArgs, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', CI: '1' },
});

let out = '';
proc.onData(data => { out += data; });

setTimeout(() => {
  try { proc.kill(); } catch {}
  console.log('\n--- child output ---');
  console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim() || '(nothing)');
  process.exit(0);
}, 8000);