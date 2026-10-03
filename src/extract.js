// Response extraction from a Freebuff TUI transcript.
//
// This module is deliberately pure: it takes text in and returns text out,
// with no PTY, timers or I/O. That lets the whole extraction pipeline be
// tested offline against fixtures recorded from a real session
// (see tools/record-session.js and test/).

// ─── Noise Patterns ───────────────────────────────────────────────
// Lines matching these are TUI chrome (logo, status bar, input box) and are
// never part of a reply.

export const NOISE_PATTERNS = [
  // Box drawing / border chars (exact match only)
  /^[╔╗╚╝═║┌┐└┘█─│├┤┬┴┼╭╮╰╯░▒▓▀▄▌▐▲▼◀►◄△▽✦✧✕⎘◆◇○●□■썸│]+$/,

  // Freebuff logo lines (mixed chars but mostly box-drawing)
  /[╔╗╚╝═║█╔╗╚╝█╗║╔╝╚]{3,}/,
  /^\s*[╔╗╚╝═║█]{5,}/,
  /[╔╗╚╝═║█╗║╔╝╚]{2,}.*[╔╗╚╝═║█╗║╔╝╚]/,
  // Text framed between two vertical borders, e.g. "║  F R E E B U F F  ║".
  // Only Unicode bars — ASCII "|" is left alone so markdown tables survive.
  /^\s*[║│┃]\s.*\S\s*[║│┃]\s*$/,
  // Reply footer metadata: "⎘ • 4s • △▽". Anchored to the whole line on purpose:
  // Freebuff also appends a bare "⎘" to the line it echoes for the user, and an
  // unanchored match here would delete the sentinel we search for.
  /^\s*⎘(?:\s*[•·]\s*\d+\s*[sm]\s*[•·])?\s*[△▽]*\s*[▄▀█▌▐▁▂▃▄▅▆▇]*\s*$/,

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
  /^\s*---\s*$/,

  // NOTE: thinking/action headers ("▸ Thinking") are deliberately NOT listed
  // here. postProcess() drops them *and* the indented reasoning that follows.
  // Filtering them out earlier would orphan that reasoning and leak it into
  // the reply.

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

const BOX_CHARS_ONLY = /^[╔╗╚╝═║┌┐└┘█─│├┤┬┴┼╭╮╰╯░▒▓▀▄▌▐▲▼◀►◄△▽✦✧✕⎘◆◇○●□■썸│]+$/;
const LOGO_CHAR_RUN = /[╔╗╚╝═║█]{3,}/;

// ─── Noise filtering ──────────────────────────────────────────────

// Drop blank lines and TUI chrome from a transcript split into lines.
export function filterNoise(lines) {
  return lines
    .map(l => l.trimEnd())
    .filter(l => {
      const trimmed = l.trim();
      return !NOISE_PATTERNS.some(re => re.test(trimmed));
    });
}

// ─── Layout ──────────────────────────────────────────────────────

// Freebuff's TUI layout shifts between versions and terminal sizes, so the
// status bar is located by its content rather than a hardcoded row number.
// Getting this right matters twice over: it keeps chrome out of the reply, and
// it keeps the "has output stopped?" check stable, since the status bar
// re-renders its countdown every minute.
const STATUS_ROW_PATTERNS = [
  /✕\s*End session/i,
  /\d+\s*m\s+left\b/i,
  /^\s*\d+\.?\d*\s+of\s+\d+\s+sessions/i,
  /\d+K\s*\(\d+%\)/,
];

// Rows of the transcript above the status bar: scrollback plus the visible
// conversation. Logo, stats box and input box are filtered later by pattern.
export function conversationText(screen, { fallbackEndRow = 30 } = {}) {
  const lines = screen.getTranscriptLines();
  const visibleStart = Math.max(0, lines.length - screen.rows);

  let statusRow = -1;
  for (let i = lines.length - 1; i >= visibleStart; i--) {
    if (STATUS_ROW_PATTERNS.some(re => re.test(lines[i]))) {
      statusRow = i;
      break;
    }
  }

  if (statusRow === -1) statusRow = visibleStart + fallbackEndRow;
  return lines.slice(0, Math.max(statusRow, 0)).join('\n');
}

// ─── Sentinel matching ────────────────────────────────────────────

// Strip the decorative frame a TUI wraps an echoed prompt in, so that
// "❯ list the files" / "▌ list the files" / "  list the files ⎘" all compare
// equal. The trailing glyphs matter: Freebuff appends a ⎘ marker to every
// line it echoes, including the user's own message.
export function normalizeForSentinel(line) {
  return String(line)
    .replace(/^[\s❯▸▹>▌▍•·⎘┃│║┆┊─┌┐└┘├┤┬┴┼╭╮╰╯]+/, '')
    .replace(/^(user|you|ask)\s*[:›]\s*/i, '')
    .replace(/[│┃|]+$/, '')
    .replace(/[\s⎘△▽•·]+$/, '')
    .trim();
}

// Index of the line that echoes `sentinel`, or -1. The *last* match wins so a
// prompt repeated in the visible input box does not shadow the real echo.
export function findSentinel(lines, sentinel) {
  if (!sentinel) return -1;
  const target = normalizeForSentinel(sentinel);
  if (!target) return -1;

  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    const candidate = normalizeForSentinel(lines[i]);
    if (!candidate) continue;

    if (candidate === target) {
      found = i;
      continue;
    }
    // The TUI may wrap or truncate the echoed prompt — accept a prefix match
    // on reasonably long text only, to avoid matching unrelated short lines.
    if (target.length >= 8 && candidate.length >= 8 &&
        (candidate.startsWith(target) || target.startsWith(candidate))) {
      found = i;
    }
  }
  return found;
}

// ─── Post-processing ──────────────────────────────────────────────

export function postProcess(lines) {
  const filtered = [];
  let skipThinking = false;
  let thinkingIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed.length === 0) {
      skipThinking = false;
      continue;
    }

    // Skip thinking blocks and tool-call headers, e.g. "• Thinking", "• List src",
    // "▸ Read src/index.js". Freebuff renders both as a bullet-prefixed header
    // followed by deeper-indented detail.
    if (/^[▸▹•·]?\s*(Thinking|Reading|Editing|Planning|Searching|Running|Analyzing|Mapping|Checking|Building|Inspecting|Writing|Fixing|Refactoring|Exploring|Connecting|List|Read|Write|Grep|Fetch|Search|Apply|Patch|Create|Delete|Install|Running|Executing|Compiling|Testing)/i.test(trimmed)) {
      skipThinking = true;
      thinkingIndent = indent;
      continue;
    }

    if (skipThinking) {
      // Reasoning is indented deeper than the header that introduced it, while
      // the answer that follows sits at the header's own level. Blank lines
      // between them are gone by now (filterNoise strips them), so indentation
      // is the only signal left.
      if (indent > thinkingIndent && trimmed.length < 400) continue;
      skipThinking = false;
    }

    // Skip box drawing (exact match only)
    if (BOX_CHARS_ONLY.test(trimmed)) continue;

    // Skip lines that are just separators
    if (/^[-=]{3,}$/.test(trimmed)) continue;

    // Skip very short fragments
    if (trimmed.length < 2) continue;

    filtered.push(line.trimEnd());
  }

  // Drop leading/trailing blank lines but keep each line's indentation — a
  // blanket trim() would strip the leading spaces of the first reply line,
  // which matters when the reply is a code block or a nested list.
  const collapsed = collapseBlankLines(filtered);
  while (collapsed.length > 0 && collapsed[0].trim() === '') collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === '') collapsed.pop();
  return collapsed.join('\n');
}

function collapseBlankLines(lines) {
  const result = [];
  let seenBlank = false;
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (seenBlank) continue;
      seenBlank = true;
      result.push('');
    } else {
      seenBlank = false;
      result.push(line);
    }
  }
  return result;
}

// ─── Completion signal ───────────────────────────────────────────

// Freebuff stamps a finished reply with a duration footer, e.g. "⎘ • 4s • △▽".
// That is a far better completion signal than silence: the model pauses for
// several seconds between tool calls, so "output stopped" alone truncates long
// replies mid-way. Returns true only if the footer appears *after* the
// sentinel, so a previous reply's footer cannot end the current request.
export function hasCompletionFooter(transcript, sentinelIndex = -1) {
  const candidate = sentinelIndex >= 0
    ? transcript.slice(sentinelIndex)
    : transcript;
  return /⎘\s*[•·]\s*\d+\s*[sm]\s*[•·]/.test(candidate);
}

// ─── Diff fallback ────────────────────────────────────────────────

// Number of leading lines shared by both arrays.
function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// ─── Main entry point ─────────────────────────────────────────────

/**
 * Extract the assistant's reply from a transcript.
 *
 * @param {object} opts
 * @param {string} opts.before  transcript captured before input was written
 * @param {string} opts.after   transcript captured after the reply arrived
 * @param {string} [opts.sentinel] the prompt text, echoed back by the TUI
 * @returns {{ text: string, strategy: 'sentinel'|'diff', index: number }}
 *
 * Strategy 1 — sentinel: the prompt is echoed into the transcript, so
 * everything after that echo is the reply. Robust even when the transcript
 * scrolled and old lines are identical.
 *
 * Strategy 2 — diff: when the prompt is not echoed (or was scrolled out of
 * the scrollback window), fall back to the lines appended after the longest
 * common prefix of the before/after transcripts.
 */
export function extractResponse({ before = '', after = '', sentinel = null } = {}) {
  const afterLines = filterNoise(String(after).split('\n'));

  const sentinelIndex = findSentinel(afterLines, sentinel);
  if (sentinelIndex >= 0) {
    return {
      text: postProcess(afterLines.slice(sentinelIndex + 1)),
      strategy: 'sentinel',
      index: sentinelIndex,
    };
  }

  const beforeLines = filterNoise(String(before).split('\n'));
  const shared = commonPrefixLength(beforeLines, afterLines);
  return {
    text: postProcess(afterLines.slice(shared)),
    strategy: 'diff',
    index: shared,
  };
}

// ─── Helpers used by the session layer ────────────────────────────

// FNV-1a over the transcript. Response completion is detected by watching this
// digest stop changing, which also catches in-place edits that a length-based
// check would miss.
export function digest(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export { LOGO_CHAR_RUN };