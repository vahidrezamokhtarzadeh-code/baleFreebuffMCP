// End-to-end extraction tests: recorded fixtures in, clean reply out.
//
// These run the same code path production uses (VTScreen + extractResponse),
// minus the PTY. Re-record fixtures with:
//   node tools/record-session.js --input "your prompt" --name <name> --text
// Regenerate the synthetic ones with:
//   node tools/make-fixture.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { replayFixture } from '../src/replay.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(PROJECT_ROOT, 'fixtures');

function loadFixture(name) {
  const file = join(FIXTURE_DIR, `${name}.json`);
  assert.ok(existsSync(file), `missing fixture: ${name}.json — run: node tools/make-fixture.js`);
  return JSON.parse(readFileSync(file, 'utf-8'));
}

test('short reply is extracted via the echoed prompt', () => {
  const result = replayFixture(loadFixture('short-reply'));

  assert.equal(result.strategy, 'sentinel');
  assert.match(result.text, /The src directory contains 7 modules/);
  assert.match(result.text, /vt-screen\.js\s+— terminal emulator/);
});

test('a reply longer than the screen is recovered in full from scrollback', () => {
  const result = replayFixture(loadFixture('long-reply'));

  // Every one of the 60 reply lines must survive, not just the ~14 that fit
  // on screen. This is the regression that scrollback exists for.
  const lines = result.text.split('\n').map(l => l.trim()).filter(l => l.startsWith('LINE-'));
  assert.equal(lines.length, 60, 'expected all 60 reply lines');
  assert.equal(lines[0], 'LINE-01 explanation of the architecture at step 1');
  assert.equal(lines[59], 'LINE-60 explanation of the architecture at step 60');
  assert.ok(result.scrollbackLines > 0, 'fixture should have exercised scrollback');
});

test('an un-echoed prompt still yields the reply through the diff fallback', () => {
  const result = replayFixture(loadFixture('no-echo'));

  assert.equal(result.strategy, 'diff');
  assert.match(result.text, /The src directory contains 7 modules/);
});

test('a real Freebuff session yields its reply and nothing else', () => {
  const result = replayFixture(loadFixture('real-hello'));

  assert.equal(result.strategy, 'sentinel');
  // The exact wording is the model's business, not ours; assert the shape.
  assert.match(result.text, /Freebuff/);
  assert.ok(result.text.split('\n').length <= 3, `expected a short reply, got:\n${result.text}`);
  // The real splash, stats box, input box and model bar must all be gone.
  assert.doesNotMatch(result.text, /Freebucks remaining|3 day streak/);
  assert.doesNotMatch(result.text, /Enter a coding task|MiMo 2\.6/);
  assert.doesNotMatch(result.text, /⎘/);
});

test('a real multi-step session keeps its reasoning out and its answer in', () => {
  const result = replayFixture(loadFixture('real-long'));

  assert.ok(result.text.length > 400, `reply too short: ${result.text.length} chars`);
  assert.match(result.text, /There's no\s+src\s+directory/);
  // Narration and tool calls are chrome, not answer.
  assert.doesNotMatch(result.text, /•\s*(Thinking|List|Read)/);
});

test('TUI chrome never leaks into an extracted reply', () => {
  for (const name of ['short-reply', 'long-reply', 'no-echo']) {
    const { text } = replayFixture(loadFixture(name));
    assert.doesNotMatch(text, /F R E E B U F F/, `${name}: logo leaked`);
    assert.doesNotMatch(text, /of 5 sessions/, `${name}: status bar leaked`);
    assert.doesNotMatch(text, /▸ (Thinking|Reading)/, `${name}: thinking header leaked`);
    assert.doesNotMatch(text, /^╔|^║|^╚/m, `${name}: border leaked`);
  }
});

test('every fixture on disk replays without throwing', () => {
  const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
  assert.ok(files.length > 0, 'no fixtures found');

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8'));
    const result = replayFixture(fixture);
    assert.equal(typeof result.text, 'string', file);
    assert.ok(['sentinel', 'diff'].includes(result.strategy), file);
  }
});

test('the status bar and everything below it is never part of a reply', () => {
  // The status bar re-renders its countdown every minute, so a reply that
  // included it would never look "settled" and would ship the countdown.
  for (const name of ['short-reply', 'real-hello']) {
    const { transcript } = replayFixture(loadFixture(name));
    assert.doesNotMatch(transcript, /End session/, `${name}: status bar in transcript`);
    assert.doesNotMatch(transcript, /Enter a coding task/, `${name}: input box in transcript`);
  }
});