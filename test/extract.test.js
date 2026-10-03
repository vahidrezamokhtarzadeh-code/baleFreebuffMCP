import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractResponse,
  filterNoise,
  findSentinel,
  normalizeForSentinel,
  digest,
} from '../src/extract.js';

test('filterNoise drops TUI chrome and blank lines', () => {
  const lines = [
    '╔══════════════════╗',
    '║   F R E E B U F F ║',
    '',
    '3.2 of 5 sessions  ·  DeepSeek 2.1  ·  12m left',
    'Ask Freebuff to do something',
    'the actual answer',
  ];
  const kept = filterNoise(lines);
  assert.deepEqual(kept, ['the actual answer']);
});

test('filterNoise keeps ASCII pipe tables', () => {
  const kept = filterNoise(['| file | size |', '| a | 1 |']);
  assert.deepEqual(kept, ['| file | size |', '| a | 1 |']);
});

test('normalizeForSentinel strips the TUI frame around an echoed prompt', () => {
  assert.equal(normalizeForSentinel('❯ list the files'), 'list the files');
  assert.equal(normalizeForSentinel('▌ list the files'), 'list the files');
  assert.equal(normalizeForSentinel('│ list the files │'), 'list the files');
  assert.equal(normalizeForSentinel('   list the files'), 'list the files');
});

test('findSentinel matches through decoration but not unrelated lines', () => {
  const lines = ['list the files', '❯ list the files', 'unrelated question'];
  assert.equal(findSentinel(lines, 'list the files'), 1);
  assert.equal(findSentinel(lines, 'something else entirely'), -1);
});

test('findSentinel prefers the last echo so the input box cannot shadow it', () => {
  const lines = ['❯ do the thing', '❯ do the thing'];
  assert.equal(findSentinel(lines, 'do the thing'), 1);
});

test('extractResponse cuts the reply at the echoed prompt', () => {
  const transcript = [
    'earlier conversation',
    '❯ list the files',
    'here are the files',
    'src/index.js',
  ].join('\n');

  const result = extractResponse({ before: 'earlier conversation', after: transcript, sentinel: 'list the files' });
  assert.equal(result.strategy, 'sentinel');
  assert.equal(result.text, 'here are the files\nsrc/index.js');
});

test('extractResponse falls back to a diff when the prompt is not echoed', () => {
  const before = 'earlier conversation';
  const after = ['earlier conversation', 'here are the files', 'src/index.js'].join('\n');

  const result = extractResponse({ before, after, sentinel: 'list the files' });
  assert.equal(result.strategy, 'diff');
  assert.equal(result.text, 'here are the files\nsrc/index.js');
});

test('extractResponse returns empty text when nothing was added', () => {
  const transcript = '❯ do nothing\n';
  const result = extractResponse({ before: '', after: transcript, sentinel: 'do nothing' });
  assert.equal(result.text, '');
});

test('thinking headers and their indented reasoning are dropped', () => {
  const transcript = [
    '❯ explain',
    '▸ Thinking',
    '  the user probably wants an overview',
    '  reading a few more lines here',
    'Here is the overview.',
  ].join('\n');

  const result = extractResponse({ before: '', after: transcript, sentinel: 'explain' });
  assert.equal(result.text, 'Here is the overview.');
});

test('a reply indented at the header level survives the thinking block', () => {
  // The shape Freebuff actually renders: reasoning is indented deeper than the
  // "• Thinking" header, and the answer that follows sits at the header's level.
  const transcript = [
    '  what files are in src ⎘',
    '  • Thinking',
    '    weighing the options before answering',
    '  Here is the answer.',
    '  Second line.',
    '                    ⎘ • 4s • △▽',
  ].join('\n');

  const result = extractResponse({ before: '', after: transcript, sentinel: 'what files are in src' });
  assert.equal(result.text, '  Here is the answer.\n  Second line.');
});

test('tool-call headers and the duration footer are chrome, not reply', () => {
  const transcript = [
    '  do it ⎘',
    '  • Thinking',
    '    working it out',
    '  • List src',
    '  Done.',
    '                    ⎘ • 13s • △▽   ▄',
  ].join('\n');

  const result = extractResponse({ before: '', after: transcript, sentinel: 'do it' });
  assert.equal(result.text, '  Done.');
});

test('indented content that is not preceded by a thinking header survives', () => {
  const transcript = ['❯ list', '  index.js', '  bridge.js'].join('\n');
  const result = extractResponse({ before: '', after: transcript, sentinel: 'list' });
  assert.equal(result.text, '  index.js\n  bridge.js');
});

test('digest changes with content, including same-length edits', () => {
  const a = 'the answer is 42';
  const b = 'the answer is 43';
  assert.equal(a.length, b.length);
  assert.notEqual(digest(a), digest(b));
  assert.equal(digest(a), digest(a));
});