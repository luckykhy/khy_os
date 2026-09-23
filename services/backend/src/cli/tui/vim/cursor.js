'use strict';

/**
 * VimCursor — adapter that presents KHY's flat (text, offset) buffer with the
 * method surface Claude Code's vim engine (motions/operators/transitions/
 * textObjects, ported in the sibling files) expects from its own utils/Cursor.
 *
 * KHY's prompt Cursor (../utils/Cursor) is intentionally lean; rather than bolt
 * ~20 vim-specific methods onto it, this self-contained value object implements
 * exactly what the ported engine calls, over plain UTF-16 text. There is no
 * line wrapping in the prompt, so "logical line" and "display line" coincide.
 *
 * Grapheme handling is code-point based (Array.from / codePointAt), which is
 * correct for surrogate pairs; full grapheme-cluster segmentation (CC uses
 * Intl.Segmenter) is intentionally omitted as overkill for prompt editing.
 */

// ── Character classification (vim word semantics) ──────────────────────────
function isVimWhitespace(ch) {
  return ch === undefined || ch === '' || /\s/.test(ch);
}

function isVimWordChar(ch) {
  return ch !== undefined && ch !== '' && /[\p{L}\p{N}_]/u.test(ch);
}

function isVimPunctuation(ch) {
  return !isVimWhitespace(ch) && !isVimWordChar(ch);
}

// 'ws' | 'word' | 'punct' for small words; for WORD, punct collapses into word.
function smallClass(ch) {
  if (isVimWhitespace(ch)) {
    return 'ws';
  }
  if (isVimWordChar(ch)) {
    return 'word';
  }
  return 'punct';
}

function bigClass(ch) {
  return isVimWhitespace(ch) ? 'ws' : 'word';
}

// ── Grapheme helpers (code-point granularity) ──────────────────────────────
function firstGrapheme(s) {
  if (!s) {
    return '';
  }
  return Array.from(s)[0] || '';
}

function lastGrapheme(s) {
  if (!s) {
    return '';
  }
  const a = Array.from(s);
  return a[a.length - 1] || '';
}

function countCharInString(s, ch) {
  if (!s) {
    return 0;
  }
  return s.split(ch).length - 1;
}

class VimCursor {
  constructor(text = '', offset = 0) {
    this.text = text;
    this.offset = Math.max(0, Math.min(offset, text.length));
  }

  static fromText(text, offset) {
    return new VimCursor(text || '', offset || 0);
  }

  equals(other) {
    return other instanceof VimCursor && other.text === this.text && other.offset === this.offset;
  }

  isAtEnd() {
    return this.offset >= this.text.length;
  }

  // measuredText: grapheme-aware offset stepping (CC's MeasuredText surface).
  get measuredText() {
    const text = this.text;
    return {
      nextOffset: (o) => {
        if (o >= text.length) {
          return text.length;
        }
        const g = firstGrapheme(text.slice(o));
        return o + (g.length || 1);
      },
      prevOffset: (o) => {
        if (o <= 0) {
          return 0;
        }
        const g = lastGrapheme(text.slice(0, o));
        return o - (g.length || 1);
      },
    };
  }

  // ── Horizontal ───────────────────────────────────────────────────────────
  // Step by grapheme, not by UTF-16 code unit (BUG-95). These back `h`/`l`
  // (motions.js) and the →/← arrow aliases (useVimInput maps them to l/h),
  // plus `executeX` bounds its delete with right() — a code-unit step there
  // would bisect an astral char (emoji) and leave a lone surrogate in the
  // buffer. The grapheme-aware steppers already exist below (measuredText);
  // left/right simply must route through them rather than raw offset±1.
  left() {
    return new VimCursor(this.text, this.measuredText.prevOffset(this.offset));
  }
  right() {
    return new VimCursor(this.text, this.measuredText.nextOffset(this.offset));
  }

  // ── Position / line geometry ───────────────────────────────────────────────
  getPosition() {
    const before = this.text.slice(0, this.offset);
    const line = before.split('\n').length - 1;
    const nl = this.text.lastIndexOf('\n', this.offset - 1);
    const column = this.offset - (nl + 1);
    return { line, column };
  }

  _lineStartOffset() {
    return this.text.lastIndexOf('\n', this.offset - 1) + 1;
  }
  _lineEndOffset() {
    const nl = this.text.indexOf('\n', this.offset);
    return nl === -1 ? this.text.length : nl;
  }

  startOfLogicalLine() {
    return new VimCursor(this.text, this._lineStartOffset());
  }
  endOfLogicalLine() {
    return new VimCursor(this.text, this._lineEndOffset());
  }

  firstNonBlankInLogicalLine() {
    const start = this._lineStartOffset();
    const end = this._lineEndOffset();
    let i = start;
    while (i < end && /\s/.test(this.text[i])) {
      i++;
    }
    return new VimCursor(this.text, i);
  }

  startOfFirstLine() {
    return new VimCursor(this.text, 0);
  }

  startOfLastLine() {
    const lastNl = this.text.lastIndexOf('\n');
    return new VimCursor(this.text, lastNl === -1 ? 0 : lastNl + 1);
  }

  // 1-based line number; clamps into range.
  goToLine(n) {
    const lines = this.text.split('\n');
    const target = Math.max(0, Math.min(n - 1, lines.length - 1));
    let off = 0;
    for (let i = 0; i < target; i++) {
      off += lines[i].length + 1;
    }
    return new VimCursor(this.text, off);
  }

  // ── Vertical (no wrapping → logical == display) ────────────────────────────
  _verticalMove(delta) {
    const lines = this.text.split('\n');
    const { line, column } = this.getPosition();
    const targetLine = line + delta;
    if (targetLine < 0) {
      return new VimCursor(this.text, 0);
    }
    if (targetLine > lines.length - 1) {
      return new VimCursor(this.text, this.text.length);
    }
    let off = 0;
    for (let i = 0; i < targetLine; i++) {
      off += lines[i].length + 1;
    }
    // `column` is a code-unit count and lines can carry astral chars, so the
    // raw landing offset may sit on a surrogate pair's LOW half (BUG-96, vertical
    // half) — e.g. `k` from a pure-ASCII line onto "ab😀cd" parks on the emoji's
    // second unit. From there x/d/backspace tear the pair into 乱码. Snap the
    // landing back to the grapheme start; valid boundaries are left untouched.
    const target = off + Math.min(column, lines[targetLine].length);
    return new VimCursor(this.text, this._alignGrapheme(target, 'back'));
  }
  upLogicalLine() {
    return this._verticalMove(-1);
  }
  downLogicalLine() {
    return this._verticalMove(1);
  }
  up() {
    return this._verticalMove(-1);
  }
  down() {
    return this._verticalMove(1);
  }

  // ── Word motions ───────────────────────────────────────────────────────────
  // Snap a code-unit offset off a surrogate-pair interior (BUG-96). The word
  // scanners below step by code unit, so an astral char (two units, both
  // classed 'punct') can leave the boundary between \ud83d and \ude00. Parked
  // there, a plain `e`/`E` caret — or anything downstream that slices from it
  // (x / d / backspace) — tears the pair into a lone surrogate (乱码). `toward`
  // picks the resting side: 'back' → the grapheme's start, otherwise just past
  // its end. No-op for all-BMP text (a valid boundary is never a pair interior).
  _alignGrapheme(i, toward) {
    const t = this.text;
    if (
      i > 0 && i < t.length
      && t.charCodeAt(i - 1) >= 0xd800 && t.charCodeAt(i - 1) <= 0xdbff
      && t.charCodeAt(i) >= 0xdc00 && t.charCodeAt(i) <= 0xdfff
    ) {
      return toward === 'back' ? i - 1 : i + 1;
    }
    return i;
  }

  _wordForward(classOf) {
    const text = this.text;
    const n = text.length;
    let i = this.offset;
    if (i >= n) {
      return new VimCursor(text, n);
    }
    const cls = classOf(text[i]);
    if (cls !== 'ws') {
      while (i < n && classOf(text[i]) === cls) {
        i++;
      }
    }
    while (i < n && classOf(text[i]) === 'ws') {
      i++;
    }
    return new VimCursor(text, i);
  }
  _wordBackward(classOf) {
    const text = this.text;
    let i = this.offset;
    if (i <= 0) {
      return new VimCursor(text, 0);
    }
    i--;
    while (i > 0 && classOf(text[i]) === 'ws') {
      i--;
    }
    if (i <= 0) {
      return new VimCursor(text, 0);
    }
    const cls = classOf(text[i]);
    if (cls === 'ws') {
      return new VimCursor(text, i);
    }
    while (i > 0 && classOf(text[i - 1]) === cls) {
      i--;
    }
    return new VimCursor(text, i);
  }
  _wordEnd(classOf) {
    const text = this.text;
    const n = text.length;
    let i = this.offset;
    // `e`/`E` park ON the last char of the word. When that char is astral, the
    // raw code-unit offset lands on its low half (a pair interior); align back
    // to the grapheme start so downstream x/d/backspace never split it.
    if (i >= n - 1) {
      return new VimCursor(text, this._alignGrapheme(Math.max(0, n - 1), 'back'));
    }
    i++;
    while (i < n && classOf(text[i]) === 'ws') {
      i++;
    }
    if (i >= n) {
      return new VimCursor(text, this._alignGrapheme(n - 1, 'back'));
    }
    const cls = classOf(text[i]);
    while (i + 1 < n && classOf(text[i + 1]) === cls) {
      i++;
    }
    return new VimCursor(text, this._alignGrapheme(i, 'back'));
  }

  nextVimWord() {
    return this._wordForward(smallClass);
  }
  prevVimWord() {
    return this._wordBackward(smallClass);
  }
  endOfVimWord() {
    return this._wordEnd(smallClass);
  }
  nextWORD() {
    return this._wordForward(bigClass);
  }
  prevWORD() {
    return this._wordBackward(bigClass);
  }
  endOfWORD() {
    return this._wordEnd(bigClass);
  }

  // ── Find on current line (f/F/t/T) ─────────────────────────────────────────
  // Returns the target OFFSET (number) or null when the char is not found.
  findCharacter(char, findType, count) {
    const text = this.text;
    const needle = char == null ? '' : String(char);
    if (needle === '') {
      return null;
    }
    const lineStart = text.lastIndexOf('\n', this.offset - 1) + 1;
    let lineEnd = text.indexOf('\n', this.offset);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    const forward = findType === 'f' || findType === 't';
    const till = findType === 't' || findType === 'T';

    // Enumerate the line's CODE-POINT boundaries (offset + one code point each)
    // and match the needle against those, not raw UTF-16 units. Comparing
    // `text[i] === char` unit-wise can never match a multi-unit needle, so
    // `f😀` (astral emoji / CJK ext-B) silently no-oped — the find half of
    // BUG-96. Code-point granularity keeps the caret off a pair interior and
    // lands it on the target's start; a single code point is the engine's
    // documented matching unit (full Intl.Segmenter clusters stay unsupported).
    const starts = [];
    const glyphs = [];
    for (let i = lineStart; i < lineEnd; ) {
      const g = firstGrapheme(text.slice(i, lineEnd));
      starts.push(i);
      glyphs.push(g);
      i += g.length || 1;
    }

    let pos = this.offset;
    for (let c = 0; c < count; c++) {
      let idx = -1;
      if (forward) {
        for (let k = 0; k < starts.length; k++) {
          if (starts[k] > pos && glyphs[k] === needle) {
            idx = starts[k];
            break;
          }
        }
      } else {
        for (let k = starts.length - 1; k >= 0; k--) {
          if (starts[k] < pos && glyphs[k] === needle) {
            idx = starts[k];
            break;
          }
        }
      }
      if (idx === -1) {
        return null;
      }
      pos = idx;
    }
    if (till) {
      // `pos` is the found char's start offset; the till step backs/forwards
      // one unit from there and can land on the low half of an adjacent astral
      // pair. Snap to the grapheme boundary (BUG-96) so `dt{char}` never slices
      // a pair.
      pos = forward ? this._alignGrapheme(pos - 1, 'back') : this._alignGrapheme(pos + 1, 'fwd');
    }
    return pos;
  }

  // ── Image-ref chips: KHY has none, so range snapping is identity. ───────────
  snapOutOfImageRef(offset /*, side */) {
    return offset;
  }

  // Used by dot-repeat replay of inserted text.
  insert(str) {
    if (!str) {
      return this;
    }
    const next = this.text.slice(0, this.offset) + str + this.text.slice(this.offset);
    return new VimCursor(next, this.offset + str.length);
  }
}

module.exports = {
  VimCursor,
  isVimWhitespace,
  isVimWordChar,
  isVimPunctuation,
  firstGrapheme,
  lastGrapheme,
  countCharInString,
};
