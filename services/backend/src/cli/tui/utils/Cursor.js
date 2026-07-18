'use strict';

/**
 * Cursor — immutable value object over a (possibly multi-line) input string and
 * a caret offset. Modelled on Claude Code's utils/Cursor.ts but scoped to what
 * the KHY TUI needs.
 *
 * All mutating methods return a NEW Cursor; the original is never changed. This
 * makes editing operations easy to reason about and test in isolation.
 *
 * Offsets are measured in UTF-16 code units over the raw text (newlines
 * included). Rendering helpers translate the flat offset into line/column.
 */

const WORD_BOUNDARY = /[\s,.;:!?'"`(){}\[\]<>/\\|@#$%^&*+=~-]/;

function isWordChar(ch) {
  return ch !== undefined && !WORD_BOUNDARY.test(ch);
}

// Grapheme-aware caret stepping (code-point granularity). Offsets are UTF-16
// code units, but a single Backspace / arrow / Delete over an astral character
// (emoji 😀, 𝕏, CJK ext-B 𠀀 — all surrogate pairs) must move/delete the WHOLE
// pair. Stepping ±1 code unit tears the pair, leaving a lone surrogate that
// UTF-8-encodes to U+FFFD (efbfbd) — i.e. silent 乱码 in the user's own typed
// text before it ever reaches the model. Mirrors the sibling VimCursor's
// firstGrapheme/lastGrapheme approach (cli/tui/vim/cursor.js). Gated by
// KHY_CURSOR_GRAPHEME (default on); off → legacy ±1 code-unit stepping,
// byte-identical for all-BMP text (the overwhelming common case).
const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _graphemeStepEnabled() {
  return !OFF_VALUES.includes(
    String((process.env && process.env.KHY_CURSOR_GRAPHEME) || '').trim().toLowerCase());
}

// Length in code units of the code point ending at `offset` (1 for BMP, 2 for a
// trailing low surrogate that pairs with the preceding high surrogate).
function _prevStep(text, offset) {
  if (offset <= 0) return 0;
  if (!_graphemeStepEnabled()) return 1;
  const lo = text.charCodeAt(offset - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && offset >= 2) {
    const hi = text.charCodeAt(offset - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return 2;
  }
  return 1;
}

// Length in code units of the code point starting at `offset` (1 for BMP, 2 for
// a leading high surrogate followed by a low surrogate).
function _nextStep(text, offset) {
  if (offset >= text.length) return 0;
  if (!_graphemeStepEnabled()) return 1;
  const hi = text.charCodeAt(offset);
  if (hi >= 0xd800 && hi <= 0xdbff && offset + 1 < text.length) {
    const lo = text.charCodeAt(offset + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

class Cursor {
  /**
   * @param {string} text  Full buffer contents (may contain "\n").
   * @param {number} offset Caret position in [0, text.length].
   */
  constructor(text = '', offset = 0) {
    this.text = text;
    this.offset = Math.max(0, Math.min(offset, text.length));
  }

  static from(text, offset) {
    return new Cursor(text, offset);
  }

  // ── Introspection ────────────────────────────────────────────────────────

  get length() {
    return this.text.length;
  }

  equals(other) {
    return other instanceof Cursor && other.text === this.text && other.offset === this.offset;
  }

  /** Split into logical lines (by "\n"). */
  lines() {
    return this.text.split('\n');
  }

  /** Zero-based line index of the caret. */
  line() {
    return this.text.slice(0, this.offset).split('\n').length - 1;
  }

  /** Zero-based column of the caret within its line. */
  column() {
    const nl = this.text.lastIndexOf('\n', this.offset - 1);
    return this.offset - (nl + 1);
  }

  // ── Horizontal movement ───────────────────────────────────────────────────

  left() {
    return new Cursor(this.text, this.offset - _prevStep(this.text, this.offset));
  }

  right() {
    return new Cursor(this.text, this.offset + _nextStep(this.text, this.offset));
  }

  startOfLine() {
    const nl = this.text.lastIndexOf('\n', this.offset - 1);
    return new Cursor(this.text, nl + 1);
  }

  endOfLine() {
    const nl = this.text.indexOf('\n', this.offset);
    return new Cursor(this.text, nl === -1 ? this.text.length : nl);
  }

  start() {
    return new Cursor(this.text, 0);
  }

  end() {
    return new Cursor(this.text, this.text.length);
  }

  // ── Vertical movement (preserves column where possible) ───────────────────

  up() {
    const lines = this.lines();
    const ln = this.line();
    if (ln === 0) return this.start();
    const col = this.column();
    const targetLen = lines[ln - 1].length;
    let off = 0;
    for (let i = 0; i < ln - 1; i++) off += lines[i].length + 1;
    return new Cursor(this.text, off + Math.min(col, targetLen));
  }

  down() {
    const lines = this.lines();
    const ln = this.line();
    if (ln >= lines.length - 1) return this.end();
    const col = this.column();
    const targetLen = lines[ln + 1].length;
    let off = 0;
    for (let i = 0; i <= ln; i++) off += lines[i].length + 1;
    return new Cursor(this.text, off + Math.min(col, targetLen));
  }

  // ── Word movement ─────────────────────────────────────────────────────────

  wordLeft() {
    let i = this.offset;
    while (i > 0 && !isWordChar(this.text[i - 1])) i--;
    while (i > 0 && isWordChar(this.text[i - 1])) i--;
    return new Cursor(this.text, i);
  }

  wordRight() {
    let i = this.offset;
    const n = this.text.length;
    while (i < n && !isWordChar(this.text[i])) i++;
    while (i < n && isWordChar(this.text[i])) i++;
    return new Cursor(this.text, i);
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  insert(str) {
    if (!str) return this;
    const next = this.text.slice(0, this.offset) + str + this.text.slice(this.offset);
    return new Cursor(next, this.offset + str.length);
  }

  /** Delete the character before the caret (Backspace). */
  backspace() {
    if (this.offset === 0) return this;
    const step = _prevStep(this.text, this.offset);
    const next = this.text.slice(0, this.offset - step) + this.text.slice(this.offset);
    return new Cursor(next, this.offset - step);
  }

  /** Delete the character at the caret (forward Delete). */
  del() {
    if (this.offset >= this.text.length) return this;
    const step = _nextStep(this.text, this.offset);
    const next = this.text.slice(0, this.offset) + this.text.slice(this.offset + step);
    return new Cursor(next, this.offset);
  }

  /** Delete from caret to end of line (Ctrl+K). Returns {cursor, killed}. */
  deleteToLineEnd() {
    const eol = this.endOfLine().offset;
    const killed = this.text.slice(this.offset, eol);
    const next = this.text.slice(0, this.offset) + this.text.slice(eol);
    return { cursor: new Cursor(next, this.offset), killed };
  }

  /** Delete from start of line to caret (Ctrl+U). Returns {cursor, killed}. */
  deleteToLineStart() {
    const bol = this.startOfLine().offset;
    const killed = this.text.slice(bol, this.offset);
    const next = this.text.slice(0, bol) + this.text.slice(this.offset);
    return { cursor: new Cursor(next, bol), killed };
  }

  /** Delete the word before the caret (Ctrl+W / Meta+Backspace). */
  deleteWordBefore() {
    const target = this.wordLeft().offset;
    const killed = this.text.slice(target, this.offset);
    const next = this.text.slice(0, target) + this.text.slice(this.offset);
    return { cursor: new Cursor(next, target), killed };
  }

  /** Delete the word after the caret (Meta+D). */
  deleteWordAfter() {
    const target = this.wordRight().offset;
    const killed = this.text.slice(this.offset, target);
    const next = this.text.slice(0, this.offset) + this.text.slice(target);
    return { cursor: new Cursor(next, this.offset), killed };
  }
}

module.exports = { Cursor, isWordChar, _graphemeStepEnabled, _prevStep, _nextStep };
