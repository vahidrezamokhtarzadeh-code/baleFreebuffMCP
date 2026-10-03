import test from 'node:test';
import assert from 'node:assert/strict';
import { VTScreen } from '../src/vt-screen.js';

const ESC = '\x1b';

test('plain text lands on screen and is trimmed per row', () => {
  const screen = new VTScreen(20, 5);
  screen.process('hello');
  assert.equal(screen.getRow(0), 'hello');
});

test('scrolling pushes lines into scrollback and keeps the transcript complete', () => {
  const screen = new VTScreen(20, 5);
  screen.process(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\r\n'));

  // 7 lines into 5 rows leaves the first 2 scrolled off into scrollback
  assert.equal(screen.getScrollbackLength(), 2);
  const transcript = screen.getTranscriptText(5).split('\n');
  assert.deepEqual(transcript, ['one', 'two', 'three', 'four', 'five', 'six', 'seven']);
});

test('scrollback is bounded by scrollbackLimit', () => {
  const screen = new VTScreen(10, 3, 4);
  for (let i = 0; i < 50; i++) {
    screen.process(`line${i}\r\n`);
  }
  assert.equal(screen.getScrollbackLength(), 4);

  const transcript = screen.getTranscriptText(3).split('\n');
  assert.ok(transcript.length <= 7, 'scrollback must be capped');
  assert.equal(transcript[transcript.length - 1], 'line49');
});

test('reset clears scrollback as well as the screen', () => {
  const screen = new VTScreen(10, 2);
  screen.process('a\r\nb\r\nc\r\nd\r\n');
  assert.ok(screen.getScrollbackLength() > 0);

  screen.reset();
  assert.equal(screen.getScrollbackLength(), 0);
  assert.equal(screen.getText(), '');
});

test('getTranscriptText respects endRow so the status bar is excluded', () => {
  const screen = new VTScreen(30, 6);
  screen.process(`${ESC}[1;1Hconversation line${ESC}[4;1Hstatus bar`);
  assert.equal(screen.getTranscriptText(3), 'conversation line');
});

test('a scrolling region scrolls independently and still fills scrollback', () => {
  const screen = new VTScreen(20, 6);
  // The logo sits above the region and must stay put while the pane scrolls.
  screen.process(`${ESC}[1;1Hlogo stays`);
  screen.process(`${ESC}[2;4r`); // rows 2..4 become the scrolling pane
  screen.process(`${ESC}[2;1Ha\r\nb\r\nc\r\nd\r\n`);

  assert.equal(screen.getRow(0), 'logo stays');
  // The trailing newline scrolls once more, so the pane holds the last 2 lines
  // and 'a' and 'b' have moved into scrollback.
  assert.equal(screen.getRow(1), 'c');
  assert.equal(screen.getRow(2), 'd');
  const transcript = screen.getTranscriptText(6);
  assert.ok(transcript.includes('a'), 'scrolled-off line a must survive in the transcript');
  assert.ok(transcript.includes('b'), 'scrolled-off line b must survive in the transcript');
});

test('cursor addressing repaints in place without scrolling', () => {
  const screen = new VTScreen(20, 4);
  screen.process(`${ESC}[1;1Hfirst`);
  screen.process(`${ESC}[1;1HXXXXX`); // overwrite, same length
  assert.equal(screen.getRow(0), 'XXXXX');
  assert.equal(screen.getScrollbackLength(), 0);
});

test('erase-in-line clears the tail of the cursor row', () => {
  const screen = new VTScreen(20, 2);
  screen.process(`abcdefghij`);
  screen.process(`${ESC}[1;4H${ESC}[K`);
  assert.equal(screen.getRow(0), 'abc');
});

test('getStreamIndex advances as content scrolls away', () => {
  const screen = new VTScreen(10, 3);
  screen.process('a\r\n');
  const before = screen.getStreamIndex();
  screen.process('b\r\nc\r\nd\r\n');
  assert.ok(screen.getStreamIndex() > before);
});

test('malformed escape sequences do not hang or throw', () => {
  const screen = new VTScreen(10, 3);
  screen.process(`${ESC}[38;5;`);
  screen.process(`${ESC}${ESC}${ESC}]0;title`);
  screen.process(`${ESC}[999;1Hok`);
  // Out-of-range row clamps instead of throwing
  assert.equal(screen.getRow(2), 'ok');
});