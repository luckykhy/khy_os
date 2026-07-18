/**
 * Vim operator execution — d, c, y and standalone commands.
 *
 * All operators take a range { start, end } and modify the line.
 */

const { Operator } = require('./types');

// ── Grapheme-aware boundary helpers (surrogate-pair / 乱码 guard) ───
//
// h/l motions step the REPL vim cursor by ±1 UTF-16 code unit, so it can
// land between the two halves of an astral character (emoji, CJK ext-B…).
// The editing commands below then slice at that offset, tearing the pair
// into a lone surrogate that UTF-8-encodes to U+FFFD — silent 乱码 in the
// user's own text. These helpers round edit boundaries to whole code
// points (mirrors the TUI vim twin's firstGrapheme/lastGrapheme stepping).
// Gated by KHY_VIM_GRAPHEME (default on); off → legacy ±1 code-unit slicing,
// which is byte-identical for all-BMP text.
const _GRAPHEME_OFF = ['0', 'false', 'off', 'no'];
function _graphemeStepEnabled() {
  return !_GRAPHEME_OFF.includes(
    String((process.env && process.env.KHY_VIM_GRAPHEME) || '').trim().toLowerCase());
}
// If `off` sits on the low half of a pair, round DOWN to the high half
// (include the whole char in a deletion that starts / ends there).
function _snapStart(line, off) {
  if (!_graphemeStepEnabled()) return off;
  if (off > 0 && off < line.length) {
    const c = line.charCodeAt(off);
    if (c >= 0xdc00 && c <= 0xdfff) {
      const p = line.charCodeAt(off - 1);
      if (p >= 0xd800 && p <= 0xdbff) return off - 1;
    }
  }
  return off;
}
// Advance `count` whole code points from `off`, capped at line end.
function _advance(line, off, count) {
  if (!_graphemeStepEnabled()) return Math.min(off + count, line.length);
  let p = off;
  for (let i = 0; i < count && p < line.length; i++) {
    const c = line.charCodeAt(p);
    if (c >= 0xd800 && c <= 0xdbff && p + 1 < line.length) {
      const n = line.charCodeAt(p + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { p += 2; continue; }
    }
    p += 1;
  }
  return p;
}
// Retreat `count` whole code points from `off`, floored at 0.
function _retreat(line, off, count) {
  if (!_graphemeStepEnabled()) return Math.max(0, off - count);
  let p = off;
  for (let i = 0; i < count && p > 0; i++) {
    const c = line.charCodeAt(p - 1);
    if (c >= 0xdc00 && c <= 0xdfff && p >= 2) {
      const h = line.charCodeAt(p - 2);
      if (h >= 0xd800 && h <= 0xdbff) { p -= 2; continue; }
    }
    p -= 1;
  }
  return p;
}
// Round an exclusive slice-END boundary UP off a low surrogate so the whole
// trailing code point stays included (used for inclusive d/c/y ranges).
function _snapEnd(line, off) {
  if (!_graphemeStepEnabled()) return off;
  if (off > 0 && off < line.length) {
    const c = line.charCodeAt(off);
    if (c >= 0xdc00 && c <= 0xdfff) {
      const p = line.charCodeAt(off - 1);
      if (p >= 0xd800 && p <= 0xdbff) return off + 1;
    }
  }
  return off;
}

// ── Core operator execution ────────────────────────────────────────

/**
 * Execute an operator over a range.
 *
 * @param {string} op - Operator type (d, c, y)
 * @param {{ start: number, end: number, inclusive?: boolean }} range
 * @param {string} line - Current line content
 * @param {number} cursor - Current cursor position
 * @param {object} persistent - Persistent state (register, lastChange, lastFind)
 * @returns {{ line: string, cursor: number, switchToInsert: boolean }}
 */
function executeOperator(op, range, line, cursor, persistent) {
  let { start, end } = range;
  const inclusive = range.inclusive !== false;

  // Normalize range
  if (start > end) [start, end] = [end, start];

  // For inclusive motions, include the end character
  let deleteEnd = inclusive ? end + 1 : end;

  // Snap both boundaries to whole code points so an astral character at a
  // range edge is never sliced through its surrogate pair (乱码 guard).
  start = _snapStart(line, start);
  deleteEnd = _snapEnd(line, deleteEnd);

  const deleted = line.slice(start, deleteEnd);

  switch (op) {
    case Operator.delete:
    case 'd': {
      persistent.register = deleted;
      const newLine = line.slice(0, start) + line.slice(deleteEnd);
      const newCursor = Math.min(start, Math.max(0, newLine.length - 1));
      return { line: newLine, cursor: newCursor, switchToInsert: false };
    }

    case Operator.change:
    case 'c': {
      persistent.register = deleted;
      const newLine = line.slice(0, start) + line.slice(deleteEnd);
      return { line: newLine, cursor: start, switchToInsert: true };
    }

    case Operator.yank:
    case 'y': {
      persistent.register = deleted;
      return { line, cursor: start, switchToInsert: false };
    }

    case Operator.indent:
    case '>': {
      const newLine = '  ' + line;
      return { line: newLine, cursor: cursor + 2, switchToInsert: false };
    }

    case Operator.dedent:
    case '<': {
      let newLine = line;
      let shift = 0;
      if (line.startsWith('  ')) {
        newLine = line.slice(2);
        shift = 2;
      } else if (line.startsWith('\t')) {
        newLine = line.slice(1);
        shift = 1;
      } else if (line.startsWith(' ')) {
        newLine = line.slice(1);
        shift = 1;
      }
      return { line: newLine, cursor: Math.max(0, cursor - shift), switchToInsert: false };
    }

    default:
      return { line, cursor, switchToInsert: false };
  }
}

// ── Standalone commands ────────────────────────────────────────────

/**
 * Execute a standalone command (not operator+motion).
 *
 * @param {string} cmd - Command key
 * @param {string} line - Current line
 * @param {number} cursor - Current cursor position
 * @param {number} count - Repeat count
 * @param {object} persistent - Persistent state
 * @param {string|null} replaceChar - For 'r' command
 * @returns {{ line: string, cursor: number, switchToInsert: boolean }|null}
 */
function executeStandalone(cmd, line, cursor, count, persistent, replaceChar = null) {
  switch (cmd) {
    // ── x — delete char at cursor ──
    case 'x': {
      if (line.length === 0) return { line, cursor, switchToInsert: false };
      const from = _snapStart(line, cursor);
      const end = _advance(line, from, count);
      persistent.register = line.slice(from, end);
      const newLine = line.slice(0, from) + line.slice(end);
      return {
        line: newLine,
        cursor: Math.min(from, Math.max(0, newLine.length - 1)),
        switchToInsert: false,
      };
    }

    // ── X — delete char before cursor ──
    case 'X': {
      if (cursor === 0) return { line, cursor, switchToInsert: false };
      const start = _retreat(line, cursor, count);
      persistent.register = line.slice(start, cursor);
      const newLine = line.slice(0, start) + line.slice(cursor);
      return { line: newLine, cursor: start, switchToInsert: false };
    }

    // ── r — replace char at cursor ──
    case 'r': {
      if (!replaceChar || line.length === 0) return null;
      const from = _snapStart(line, cursor);
      const end = _advance(line, from, 1);
      const newLine = line.slice(0, from) + replaceChar + line.slice(end);
      return { line: newLine, cursor: from, switchToInsert: false };
    }

    // ── ~ — toggle case ──
    case '~': {
      if (line.length === 0) return { line, cursor, switchToInsert: false };
      const from = _snapStart(line, cursor);
      const end = _advance(line, from, count);
      let toggled = '';
      for (let i = from; i < end; i++) {
        const ch = line[i];
        toggled += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      }
      const newLine = line.slice(0, from) + toggled + line.slice(end);
      return {
        line: newLine,
        cursor: Math.min(end, Math.max(0, newLine.length - 1)),
        switchToInsert: false,
      };
    }

    // ── p — paste after cursor ──
    case 'p': {
      if (!persistent.register) return { line, cursor, switchToInsert: false };
      const reg = persistent.register;
      const insertAt = Math.min(cursor + 1, line.length);
      let newLine = line;
      for (let i = 0; i < count; i++) {
        newLine = newLine.slice(0, insertAt + i * reg.length) + reg + newLine.slice(insertAt + i * reg.length);
      }
      return { line: newLine, cursor: insertAt + (count * reg.length) - 1, switchToInsert: false };
    }

    // ── P — paste before cursor ──
    case 'P': {
      if (!persistent.register) return { line, cursor, switchToInsert: false };
      const reg = persistent.register;
      let newLine = line;
      for (let i = 0; i < count; i++) {
        newLine = newLine.slice(0, cursor + i * reg.length) + reg + newLine.slice(cursor + i * reg.length);
      }
      return { line: newLine, cursor: cursor + (count * reg.length) - 1, switchToInsert: false };
    }

    // ── D — delete to end of line ──
    case 'D': {
      persistent.register = line.slice(cursor);
      const newLine = line.slice(0, cursor);
      return {
        line: newLine,
        cursor: Math.max(0, newLine.length - 1),
        switchToInsert: false,
      };
    }

    // ── C — change to end of line ──
    case 'C': {
      persistent.register = line.slice(cursor);
      const newLine = line.slice(0, cursor);
      return { line: newLine, cursor, switchToInsert: true };
    }

    // ── Y — yank entire line ──
    case 'Y': {
      persistent.register = line;
      return { line, cursor, switchToInsert: false };
    }

    // ── dd — delete entire line ──
    case 'dd': {
      persistent.register = line;
      return { line: '', cursor: 0, switchToInsert: false };
    }

    // ── cc — change entire line ──
    case 'cc': {
      persistent.register = line;
      return { line: '', cursor: 0, switchToInsert: true };
    }

    // ── yy — yank entire line ──
    case 'yy': {
      persistent.register = line;
      return { line, cursor, switchToInsert: false };
    }

    // ── S — substitute entire line (same as cc) ──
    case 'S': {
      persistent.register = line;
      return { line: '', cursor: 0, switchToInsert: true };
    }

    // ── s — substitute char(s) at cursor ──
    case 's': {
      const from = _snapStart(line, cursor);
      const end = _advance(line, from, count);
      persistent.register = line.slice(from, end);
      const newLine = line.slice(0, from) + line.slice(end);
      return { line: newLine, cursor: from, switchToInsert: true };
    }

    // ── >> — indent ──
    case '>>': {
      const newLine = '  ' + line;
      return { line: newLine, cursor: cursor + 2, switchToInsert: false };
    }

    // ── << — dedent ──
    case '<<': {
      let newLine = line;
      let shift = 0;
      if (line.startsWith('  ')) {
        newLine = line.slice(2); shift = 2;
      } else if (line.startsWith('\t')) {
        newLine = line.slice(1); shift = 1;
      } else if (line.startsWith(' ')) {
        newLine = line.slice(1); shift = 1;
      }
      return { line: newLine, cursor: Math.max(0, cursor - shift), switchToInsert: false };
    }

    default:
      return null;
  }
}

module.exports = {
  executeOperator,
  executeStandalone,
  _graphemeStepEnabled,
  _snapStart,
  _snapEnd,
  _advance,
  _retreat,
};
