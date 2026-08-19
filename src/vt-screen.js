// VT100/XTerm Screen Buffer Emulator
// Tracks virtual screen content by processing escape sequences
// Used for prompt detection in Freebuff's TUI (cursor-positioned content)

export class VTScreen {
  constructor(cols = 120, rows = 40) {
    this.cols = cols;
    this.rows = rows;
    this.cursorRow = 0;   // 0-indexed
    this.cursorCol = 0;
    this.buffer = [];
    this._initBuffer();
    this.dirty = false;   // true if screen changed since last check
  }

  _initBuffer() {
    this.buffer = [];
    for (let r = 0; r < this.rows; r++) {
      const row = [];
      for (let c = 0; c < this.cols; c++) {
        row.push({ char: ' ', fg: null, bg: null });
      }
      this.buffer.push(row);
    }
  }

  // Reset screen state
  reset() {
    this._initBuffer();
    this.cursorRow = 0;
    this.cursorCol = 0;
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
        this.cursorRow++;
        if (this.cursorRow >= this.rows) {
          this._scrollUp();
          this.cursorRow = this.rows - 1;
        }
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
      if (this.cursorRow > 0) {
        this.cursorRow--;
      } else {
        this._scrollDown();
      }
      return i + 1;
    } else if (ch === 'D') {
      // Index (line feed)
      this.cursorRow++;
      if (this.cursorRow >= this.rows) {
        this._scrollUp();
        this.cursorRow = this.rows - 1;
      }
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
    const isQuestion = params.startsWith('?');
    const nums = params.replace('?', '').split(';').map(s => parseInt(s) || 0);

    switch (final) {
      case 'H': // Cursor Position (CUP)
      case 'f': {
        const r = (nums[0] || 1) - 1;  // 1-indexed to 0-indexed
        const c = (nums[1] || 1) - 1;
        this.cursorRow = Math.max(0, Math.min(r, this.rows - 1));
        this.cursorCol = Math.max(0, Math.min(c, this.cols - 1));
        break;
      }
      case 'A': // Cursor Up
        this.cursorRow = Math.max(0, this.cursorRow - (nums[0] || 1));
        break;
      case 'B': // Cursor Down
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (nums[0] || 1));
        break;
      case 'C': // Cursor Forward
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (nums[0] || 1));
        break;
      case 'D': // Cursor Back
        this.cursorCol = Math.max(0, this.cursorCol - (nums[0] || 1));
        break;
      case 'E': // Cursor Next Line
        this.cursorCol = 0;
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (nums[0] || 1));
        break;
      case 'F': // Cursor Previous Line
        this.cursorCol = 0;
        this.cursorRow = Math.max(0, this.cursorRow - (nums[0] || 1));
        break;
      case 'G': // Cursor Horizontal Absolute
        this.cursorCol = Math.max(0, Math.min((nums[0] || 1) - 1, this.cols - 1));
        break;
      case 'J': { // Erase in Display
        const mode = nums[0] || 0;
        if (mode === 0) {
          // Erase from cursor to end
          for (let c = this.cursorCol; c < this.cols; c++) {
            this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
          }
          for (let r = this.cursorRow + 1; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
              this.buffer[r][c] = { char: ' ', fg: null, bg: null };
            }
          }
        } else if (mode === 1) {
          // Erase from start to cursor
          for (let r = 0; r < this.cursorRow; r++) {
            for (let c = 0; c < this.cols; c++) {
              this.buffer[r][c] = { char: ' ', fg: null, bg: null };
            }
          }
          for (let c = 0; c <= this.cursorCol; c++) {
            this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
          }
        } else if (mode === 2 || mode === 3) {
          // Erase entire screen
          this._initBuffer();
        }
        this.dirty = true;
        break;
      }
      case 'K': { // Erase in Line
        const mode = nums[0] || 0;
        if (mode === 0) {
          for (let c = this.cursorCol; c < this.cols; c++) {
            this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
          }
        } else if (mode === 1) {
          for (let c = 0; c <= this.cursorCol; c++) {
            this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
          }
        } else if (mode === 2) {
          for (let c = 0; c < this.cols; c++) {
            this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
          }
        }
        this.dirty = true;
        break;
      }
      case 'L': { // Insert Lines
        const count = nums[0] || 1;
        for (let i = this.rows - 1; i >= this.cursorRow + count; i--) {
          this.buffer[i] = this.buffer[i - count].map(c => ({ ...c }));
        }
        for (let i = this.cursorRow; i < this.cursorRow + count && i < this.rows; i++) {
          this.buffer[i] = [];
          for (let c = 0; c < this.cols; c++) {
            this.buffer[i].push({ char: ' ', fg: null, bg: null });
          }
        }
        this.dirty = true;
        break;
      }
      case 'M': { // Delete Lines
        const count = nums[0] || 1;
        for (let i = this.cursorRow; i < this.rows - count; i++) {
          this.buffer[i] = this.buffer[i + count].map(c => ({ ...c }));
        }
        for (let i = this.rows - count; i < this.rows; i++) {
          this.buffer[i] = [];
          for (let c = 0; c < this.cols; c++) {
            this.buffer[i].push({ char: ' ', fg: null, bg: null });
          }
        }
        this.dirty = true;
        break;
      }
      case 'S': { // Scroll Up (SU)
        const count = nums[0] || 1;
        for (let n = 0; n < count; n++) {
          this._scrollUp();
        }
        this.dirty = true;
        break;
      }
      case 'T': { // Scroll Down (SD)
        const count = nums[0] || 1;
        for (let n = 0; n < count; n++) {
          this._scrollDown();
        }
        this.dirty = true;
        break;
      }
      case 'X': { // Erase Characters
        const count = nums[0] || 1;
        for (let c = this.cursorCol; c < this.cursorCol + count && c < this.cols; c++) {
          this.buffer[this.cursorRow][c] = { char: ' ', fg: null, bg: null };
        }
        this.dirty = true;
        break;
      }
      case 'P': { // Delete Characters
        const count = nums[0] || 1;
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
      case 'd': { // Vertical Position Absolute (VPA)
        this.cursorRow = Math.max(0, Math.min((nums[0] || 1) - 1, this.rows - 1));
        break;
      }
      case 'm': { // SGR (Select Graphic Rendition) — colors/styles
        // We don't track colors for prompt detection, just ignore
        break;
      }
      case 'h': // Set Mode
      case 'l': // Reset Mode
        // DEC private modes like ?2026h/l — ignore
        break;
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
      this.cursorRow++;
      if (this.cursorRow >= this.rows) {
        this._scrollUp();
        this.cursorRow = this.rows - 1;
      }
    }
  }

  _scrollUp() {
    this.buffer.shift();
    const newRow = [];
    for (let c = 0; c < this.cols; c++) {
      newRow.push({ char: ' ', fg: null, bg: null });
    }
    this.buffer.push(newRow);
    this.dirty = true;
  }

  _scrollDown() {
    this.buffer.pop();
    const newRow = [];
    for (let c = 0; c < this.cols; c++) {
      newRow.push({ char: ' ', fg: null, bg: null });
    }
    this.buffer.unshift(newRow);
    this.dirty = true;
  }

  // ─── Output Methods ──────────────────────────────────────────────

  // Get visible text from screen buffer (line by line)
  getText() {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      let lastNonSpace = -1;

      for (let c = 0; c < this.cols; c++) {
        const cell = this.buffer[r][c];
        line += cell.char;
        if (cell.char !== ' ') lastNonSpace = c;
      }

      if (lastNonSpace >= 0) {
        line = line.substring(0, lastNonSpace + 1);
      } else {
        line = '';
      }

      lines.push(line);
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
    let line = '';
    let lastNonSpace = -1;
    for (let c = 0; c < this.cols; c++) {
      line += this.buffer[row][c].char;
      if (this.buffer[row][c].char !== ' ') lastNonSpace = c;
    }
    return lastNonSpace >= 0 ? line.substring(0, lastNonSpace + 1) : '';
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
  // This is the key method — removes box-drawing at cell level
  getCleanText() {
    const lines = [];
    for (let r = 0; r < this.rows; r++) {
      let line = '';
      let lastNonSpace = -1;

      for (let c = 0; c < this.cols; c++) {
        const ch = this.buffer[r][c].char;
        line += ch;
        if (ch !== ' ') lastNonSpace = c;
      }

      if (lastNonSpace < 0) {
        lines.push('');
        continue;
      }

      line = line.substring(0, lastNonSpace + 1);

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
