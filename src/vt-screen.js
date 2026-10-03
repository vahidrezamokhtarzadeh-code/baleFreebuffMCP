// VT100/XTerm Screen Buffer Emulator
// Tracks virtual screen content by processing escape sequences.
//
// Beyond the visible screen it keeps a bounded *scrollback* of every line that
// scrolled off the top. Without it, a Freebuff reply longer than the visible
// conversation area would be silently truncated — the caller can now read the
// whole linear transcript (scrollback + visible rows) via getTranscriptText().
//
// It also honours DECSTBM scrolling regions (CSI r), which real TUIs use to
// scroll only their conversation pane while leaving logo/status chrome pinned.

const DEFAULT_SCROLLBACK_LIMIT = 2000;

export class VTScreen {
  constructor(cols = 120, rows = 40, scrollbackLimit = DEFAULT_SCROLLBACK_LIMIT) {
    this.cols = cols;
    this.rows = rows;
    this.scrollbackLimit = scrollbackLimit;

    this.cursorRow = 0;   // 0-indexed
    this.cursorCol = 0;
    this.buffer = [];

    // Scroll region (DECSTBM), inclusive 0-indexed rows.
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;

    this.scrollback = [];
    this._initBuffer();
    this.dirty = false;   // true if screen changed since last check
  }

  _initBuffer() {
    this.buffer = [];
    for (let r = 0; r < this.rows; r++) {
      this.buffer.push(this._blankRow());
    }
  }

  _blankRow() {
    const row = [];
    for (let c = 0; c < this.cols; c++) {
      row.push({ char: ' ', fg: null, bg: null });
    }
    return row;
  }

  // Reset screen state (clears scrollback too — a fresh session starts blank)
  reset() {
    this._initBuffer();
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.scrollback = [];
    this.dirty = false;
  }

  // Process a chunk of raw terminal output
  process(data) {
    let i = 0;
    const len = data.length;

    while (i < len) {
      const ch = data[i];

      if (ch === '\x1b') {
        // Escape sequence
        i = this._processEscape(data, i + 1);
      } else if (ch === '\r') {
        this.cursorCol = 0;
        i++;
      } else if (ch === '\n') {
        this._lineFeed();
        i++;
      } else if (ch === '\t') {
        // Tab — advance to next tab stop (every 8 cols)
        this.cursorCol = Math.min(this.cursorCol + 8 - (this.cursorCol % 8), this.cols - 1);
        i++;
      } else if (ch === '\b') {
        // Backspace
        if (this.cursorCol > 0) this.cursorCol--;
        i++;
      } else if (ch === '\x07') {
        // Bell — ignore
        i++;
      } else if (ch.charCodeAt(0) < 0x20) {
        // Other control characters — skip
        i++;
      } else {
        // Printable character
        this._writeChar(ch);
        i++;
      }
    }
  }

  _processEscape(data, i) {
    if (i >= data.length) return i;
    const ch = data[i];

    if (ch === '[') {
      // CSI sequence: ESC [ ... final_byte
      return this._processCSI(data, i + 1);
    } else if (ch === ']') {
      // OSC sequence: ESC ] ... ESC \ or BEL
      return this._processOSC(data, i + 1);
    } else if (ch === '(' || ch === ')') {
      // Charset selection — skip 1 more char
      return i + 2;
    } else if (ch === 'M') {
      // Reverse index
      if (this.cursorRow > this.scrollTop) {
        this.cursorRow--;
      } else {
        this._scrollDown();
      }
      return i + 1;
    } else if (ch === 'D') {
      // Index (line feed)
      this._lineFeed();
      return i + 1;
    } else if (ch === 'c') {
      // Full reset
      this.reset();
      return i + 1;
    } else if (ch === '7') {
      // Save cursor
      this._savedRow = this.cursorRow;
      this._savedCol = this.cursorCol;
      return i + 1;
    } else if (ch === '8') {
      // Restore cursor
      if (this._savedRow !== undefined) {
        this.cursorRow = this._savedRow;
        this.cursorCol = this._savedCol;
      }
      return i + 1;
    }

    // Unknown escape — skip
    return i + 1;
  }

  _processCSI(data, i) {
    // Parse parameter bytes and intermediate bytes until final byte
    let params = '';
    while (i < data.length) {
      const ch = data[i];
      // Parameter bytes: 0x30–0x3F (0-9 ; < = > ?)
      if (ch >= '0' && ch <= '9' || ch === ';' || ch === '?' ||
          ch === '<' || ch === '=' || ch === '>') {
        params += ch;
        i++;
      } else if (ch >= '0x20' && ch <= '0x2F') {
        // Intermediate bytes — skip
        i++;
      } else {
        // Final byte
        this._handleCSI(params, ch);
        return i + 1;
      }
    }
    return i;
  }

  _handleCSI(params, final) {
    const nums = params.replace(/^\?/, '').split(';').map(s => parseInt(s) || 0);
    const arg = (n, fallback) => (nums[n] ? nums[n] : fallback);

    switch (final) {
      case 'H': // Cursor Position (CUP)
      case 'f': { // HVP
        const r = arg(0, 1) - 1;  // 1-indexed to 0-indexed
        const c = arg(1, 1) - 1;
        this.cursorRow = this._clampRow(r);
        this.cursorCol = Math.max(0, Math.min(c, this.cols - 1));
        break;
      }
      case 'A': // Cursor Up
        this.cursorRow = Math.max(0, this.cursorRow - arg(0, 1));
        break;
      case 'B': // Cursor Down
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + arg(0, 1));
        break;
      case 'C': // Cursor Forward
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + arg(0, 1));
        break;
      case 'D': // Cursor Back
        this.cursorCol = Math.max(0, this.cursorCol - arg(0, 1));
        break;
      case 'E': // Cursor Next Line
        this.cursorCol = 0;
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + arg(0, 1));
        break;
      case 'F': // Cursor Previous Line
        this.cursorCol = 0;
        this.cursorRow = Math.max(0, this.cursorRow - arg(0, 1));
        break;
      case 'G': // Cursor Horizontal Absolute
        this.cursorCol = Math.max(0, Math.min(arg(0, 1) - 1, this.cols - 1));
        break;
      case 'd': { // Vertical Position Absolute (VPA)
        this.cursorRow = this._clampRow(arg(0, 1) - 1);
        break;
      }
      case 'r': { // DECSTBM — set scrolling region
        const top = arg(0, 1) - 1;
        const bottom = arg(1, this.rows) - 1;
        if (top < bottom && bottom < this.rows) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
          this.cursorRow = this._clampRow(top);
          this.cursorCol = 0;
        } else {
          this.scrollTop = 0;
          this.scrollBottom = this.rows - 1;
        }
        break;
      }
      case 'J': { // Erase in Display
        const mode = nums[0] || 0;
        if (mode === 0) {
          // Erase from cursor to end
          this._eraseCells(this.cursorRow, this.cursorCol, this.cols - 1);
          for (let r = this.cursorRow + 1; r < this.rows; r++) {
            this.buffer[r] = this._blankRow();
          }
        } else if (mode === 1) {
          // Erase from start to cursor
          for (let r = 0; r < this.cursorRow; r++) {
            this.buffer[r] = this._blankRow();
          }
          this._eraseCells(this.cursorRow, 0, this.cursorCol);
        } else if (mode === 2) {
          // Erase entire screen. Per terminal semantics this leaves the
          // scrollback alone — an app that wants it gone sends CSI 3 J.
          this._initBuffer();
        } else if (mode === 3) {
          // Erase saved lines — scrollback only, screen untouched
          this.scrollback = [];
        }
        this.dirty = true;
        break;
      }
      case 'K': { // Erase in Line
        const mode = nums[0] || 0;
        if (mode === 0) {
          this._eraseCells(this.cursorRow, this.cursorCol, this.cols - 1);
        } else if (mode === 1) {
          this._eraseCells(this.cursorRow, 0, this.cursorCol);
        } else if (mode === 2) {
          this._eraseCells(this.cursorRow, 0, this.cols - 1);
        }
        this.dirty = true;
        break;
      }
      case 'L': { // Insert Lines
        const count = arg(0, 1);
        for (let i = this.rows - 1; i >= this.cursorRow + count; i--) {
          this.buffer[i] = this.buffer[i - count].map(c => ({ ...c }));
        }
        for (let i = this.cursorRow; i < this.cursorRow + count && i < this.rows; i++) {
          this.buffer[i] = this._blankRow();
        }
        this.dirty = true;
        break;
      }
      case 'M': { // Delete Lines
        const count = arg(0, 1);
        for (let i = this.cursorRow; i < this.rows - count; i++) {
          this.buffer[i] = this.buffer[i + count].map(c => ({ ...c }));
        }
        for (let i = this.rows - count; i < this.rows; i++) {
          this.buffer[i] = this._blankRow();
        }
        this.dirty = true;
        break;
      }
      case 'S': { // Scroll Up (SU)
        for (let n = 0; n < arg(0, 1); n++) {
          this._scrollUp();
        }
        this.dirty = true;
        break;
      }
      case 'T': { // Scroll Down (SD)
        for (let n = 0; n < arg(0, 1); n++) {
          this._scrollDown();
        }
        this.dirty = true;
        break;
      }
      case 'X': { // Erase Characters
        const count = arg(0, 1);
        this._eraseCells(this.cursorRow, this.cursorCol, Math.min(this.cursorCol + count - 1, this.cols - 1));
        this.dirty = true;
        break;
      }
      case 'P': { // Delete Characters
        const count = arg(0, 1);
        const row = this.buffer[this.cursorRow];
        for (let c = this.cursorCol; c < this.cols - count; c++) {
          row[c] = row[c + count] || { char: ' ', fg: null, bg: null };
        }
        for (let c = this.cols - count; c < this.cols; c++) {
          row[c] = { char: ' ', fg: null, bg: null };
        }
        this.dirty = true;
        break;
      }
      case '@': { // Insert Characters
        const count = arg(0, 1);
        const row = this.buffer[this.cursorRow];
        for (let c = this.cols - 1; c >= this.cursorCol + count; c--) {
          row[c] = { ...(row[c - count] || { char: ' ', fg: null, bg: null }) };
        }
        for (let c = this.cursorCol; c < this.cursorCol + count && c < this.cols; c++) {
          row[c] = { char: ' ', fg: null, bg: null };
        }
        this.dirty = true;
        break;
      }
      case 'm': // SGR (Select Graphic Rendition) — we don't track colors
      case 'h': // Set Mode (incl. DEC private modes)
      case 'l': // Reset Mode
      case 'n': // Device Status Report — ignore
      case 'c': // Device Attributes — ignore
        break;
      default:
        // Unknown CSI — ignore
        break;
    }
  }

  _processOSC(data, i) {
    // OSC: ESC ] Ps ; Pt ST or BEL
    while (i < data.length) {
      if (data[i] === '\x07') {
        return i + 1;
      }
      if (data[i] === '\x1b' && i + 1 < data.length && data[i + 1] === '\\') {
        return i + 2;
      }
      i++;
    }
    return i;
  }

  // ─── Cursor / scrolling primitives ────────────────────────────────

  _clampRow(row) {
    return Math.max(0, Math.min(row, this.rows - 1));
  }

  _eraseCells(row, fromCol, toCol) {
    const target = this.buffer[row];
    if (!target) return;
    for (let c = Math.max(0, fromCol); c <= Math.min(toCol, this.cols - 1); c++) {
      target[c] = { char: ' ', fg: null, bg: null };
    }
  }

  _lineFeed() {
    if (this.cursorRow === this.scrollBottom) {
      this._scrollUp();
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    }
  }

  _writeChar(ch) {
    if (this.cursorRow >= 0 && this.cursorRow < this.rows &&
        this.cursorCol >= 0 && this.cursorCol < this.cols) {
      this.buffer[this.cursorRow][this.cursorCol] = {
        char: ch,
        fg: null,
        bg: null,
      };
      this.dirty = true;
    }
    this.cursorCol++;
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this._lineFeed();
    }
  }

  // Scroll the active region up by one line. The row leaving the top of the
  // region is pushed to scrollback so it stays part of the transcript.
  _scrollUp() {
    if (this.scrollbackLimit > 0) {
      this.scrollback.push(this.buffer[this.scrollTop]);
      if (this.scrollback.length > this.scrollbackLimit) {
        this.scrollback.shift();
      }
    }
    this.buffer.splice(this.scrollTop, 1);
    this.buffer.splice(this.scrollBottom, 0, this._blankRow());
    this.dirty = true;
  }

  // Scroll the active region down by one line, pulling the most recent
  // scrollback line back onto the screen (xterm behaviour at region top).
  _scrollDown() {
    this.buffer.splice(this.scrollBottom, 1);
    if (this.scrollback.length > 0) {
      this.buffer.splice(this.scrollTop, 0, this.scrollback.pop());
    } else {
      this.buffer.splice(this.scrollTop, 0, this._blankRow());
    }
    this.dirty = true;
  }

  // ─── Scrollback API ───────────────────────────────────────────────

  getScrollbackLength() {
    return this.scrollback.length;
  }

  // Absolute line index of the cursor in the linear transcript
  // (scrollback lines + visible rows). Stable across scrolling, which makes
  // it usable as a cheap "where was I" marker.
  getStreamIndex() {
    return this.scrollback.length + this.cursorRow;
  }

  getScrollbackText() {
    return this.scrollback.map(row => this._rowToText(row)).join('\n');
  }

  // Full linear transcript: every line that scrolled off, then the visible
  // rows from 0 up to (but excluding) endRow. This is what response
  // extraction works on — unlike a bare screen read it is not limited to
  // whatever currently fits on screen.
  getTranscriptText(endRow = this.rows) {
    return this.getTranscriptLines(endRow).join('\n');
  }

  // Same as getTranscriptText but as an array, for callers that need to reason
  // about individual rows (see conversationText in extract.js).
  getTranscriptLines(endRow = this.rows) {
    const parts = [];
    for (const row of this.scrollback) {
      parts.push(this._rowToText(row));
    }
    const limit = Math.min(endRow, this.rows);
    for (let r = 0; r < limit; r++) {
      parts.push(this._rowToText(this.buffer[r]));
    }
    while (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    return parts;
  }

  _rowToText(row) {
    let line = '';
    let lastNonSpace = -1;
    for (let c = 0; c < this.cols; c++) {
      const cell = row[c];
      if (!cell) continue;
      line += cell.char;
      if (cell.char !== ' ') lastNonSpace = c;
    }
    return lastNonSpace >= 0 ? line.substring(0, lastNonSpace + 1) : '';
  }

  // ─── Output Methods ──────────────────────────────────────────────

  // Get visible text from screen buffer (line by line)
  getText() {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      lines.push(this._rowToText(this.buffer[r]));
    }

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  // Check if a specific character exists anywhere on screen
  hasChar(ch) {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.buffer[r][c].char === ch) return true;
      }
    }
    return false;
  }

  // Get content of a specific row (trimmed)
  getRow(row) {
    if (row < 0 || row >= this.rows) return '';
    return this._rowToText(this.buffer[row]);
  }

  // Get content from a region of the screen
  getRegion(startRow, endRow) {
    const lines = [];
    for (let r = startRow; r < endRow && r < this.rows; r++) {
      lines.push(this.getRow(r));
    }
    return lines.join('\n');
  }

  // Cell-level filtering: extract clean text avoiding TUI chrome per cell
  getCleanText() {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      const line = this._rowToText(this.buffer[r]);

      if (line === '') {
        lines.push('');
        continue;
      }

      // Check if this row has any box-drawing/border characters
      if (/[╔╗╚╝═║┌┐└┘─│├┤┬┴┼╭╮╰╯█]/.test(line)) {
        // Split into segments between border chars, keep only text segments
        const segments = line.split(/[╔╗╚╝═║┌┐└┘─│├┤┬┴┼╭╮╰╯█]+/);
        const textParts = segments
          .map(s => s.trim())
          .filter(s => s.length > 1 && /[a-zA-Z0-9\u0600-\u06FF]/.test(s));

        if (textParts.length > 0) {
          lines.push(textParts.join(' '));
        } else {
          lines.push('');
        }
      } else {
        lines.push(line);
      }
    }

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  // Get a snapshot of screen content (for diffing)
  snapshot() {
    return this.getText();
  }

  // Compare two snapshots
  static snapshotsDifferent(a, b) {
    return a !== b;
  }
}