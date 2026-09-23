'use strict';

/**
 * wrapCell — the SINGLE wrap + row-counting source (DESIGN-ARCH-103 P0-4 / H6).
 *
 * The historical bug class: components WRAPPED text one way and ESTIMATED its
 * row count another way ("branch-mirrored same source" by convention). When a
 * branch was added or the width changed, the estimate drifted from the render
 * and Ink erased the wrong number of rows → the resize ghosting. The fix is
 * CONSTRUCTIVE: rendering and billing both call these same functions, so they
 * cannot diverge.
 *
 * - wrapCell(text, width): grapheme/CJK/emoji-aware wrapping. Width metering
 *   is display width (CJK = 2, combining marks = 0, emoji = 2), not code-unit
 *   length. Width <= 0 → one segment per line (no wrapping).
 * - visualRows(text, width): === wrapCell(text, width).length (H6). Use it for
 *   ANY row-budget accounting of wrapped content.
 * - visualRowsUnwrapped(text): logical-line count (split on \n). Use it when
 *   the content is rendered UNWRAPPED — e.g. tool preview lines that are
 *   pre-truncated to one visual row each (the ToolLines folding model, 079
 *   §12.5 "1 source row = 1 visual row").
 * - clipCell(text, width): one visual row, cut with '…' instead of wrapped.
 *   For content whose contract IS a single row (pickers, sidebar rows) — where
 *   wrapping would inflate frame height rather than show more.
 * - pickerRowBudget / pickerPageRows: the two budgets a picker needs to stay
 *   inside the terminal — columns left for one clipped row, and how many rows
 *   the list may take given the terminal height. Both meter through this file
 *   so a picker can never bill a row differently from how it renders.
 * - fitBorder(width, {left,right,mid,busy}): a border line whose DISPLAY width
 *   is exactly `width`. Top and bottom borders must both come from this
 *   function so they are equal-width by construction (H4).
 */

let _stringWidth = null;
function sw() {
  if (_stringWidth === null) {
    try {
      const m = require('string-width');
      // string-width@5 is ESM: CJS require() yields the namespace
      // ({ default: fn }) — unwrap it.
      _stringWidth = typeof m === 'function' ? m : m.default;
      if (typeof _stringWidth !== 'function') {
        _stringWidth = false;
      }
    } catch {
      _stringWidth = false;
    }
  }
  return _stringWidth;
}

/** Display width of a string (CJK=2, combining=0). Falls back to code units. */
function visWidth(s) {
  const w = sw();
  if (w) {
    try {
      const n = w(String(s == null ? '' : s));
      return Number.isFinite(n) ? n : String(s).length;
    } catch {
      /* fall through */
    }
  }
  return String(s == null ? '' : s).length;
}

/**
 * One terminal escape sequence at the current offset, matched as a unit.
 * CSI (`ESC [ params intermediates final`), OSC (`ESC ] … BEL|ST`), the
 * ESC-with-intermediates dispatches (e.g. `ESC ( B` charset designation) and
 * the two-byte ESC dispatches. These consume zero display columns and are the
 * shapes the terminal itself consumes — nothing inside one is a legal break
 * point, and metering their bytes as printable inflates the row width.
 *
 * CSI **parameter bytes** are the full ECMA-48 range `0x30–0x3F`
 * (`[0-9:;<=>?]`), not just digits/`;`/`?`: newer tooling and pasted model
 * output emit colon-separated truecolor SGR (`ESC [ 38:2:R:G:B m`) and private
 * params (`ESC [ > c`), which the narrower class used to split mid-sequence —
 * the trailing digits then got metered as printable and wrapped onto screen as
 * literal garbage (same family as BUG-32). The intermediate branch
 * `[ -/]+[@-~]` requires ≥1 intermediate byte (0x20–0x2F) before the final, so
 * a lone `ESC h` still falls through and keeps `h` printable.
 *
 * Sticky (`y`) so the scan stays linear on escape-heavy input.
 */
const ESC_SEQ_RE = /\x1b(?:\[[0-9:;<=>?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[ -/]+[@-~]|[@-Z\\-_])/y;
/** Close everything a row might still have open at a wrap point. */
const SGR_OFF = '\x1b[0m';

/**
 * Attribute group an SGR parameter string writes. A later code in the same
 * group replaces the earlier one, which keeps the replay set to one parameter
 * string per attribute instead of an ever-growing list of history.
 */
function sgrGroup(first) {
  const n = first;
  if (n === 0) return 'reset';
  if (n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) return 'fg';
  if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return 'bg';
  if (n === 22 || n === 1 || n === 2) return 'intensity';
  if (n === 23 || n === 3) return 'italic';
  if (n === 24 || n === 4) return 'underline';
  if (n === 27 || n === 7) return 'inverse';
  if (n === 29 || n === 9) return 'strike';
  if (n === 28 || n === 8) return 'conceal';
  if (n === 55 || n === 53) return 'overline';
  return 'code' + n;
}

/**
 * Wrap text into segments of display width <= `width`.
 *
 * ANSI-aware: escape sequences are atomic and zero-width, so a wrap point can
 * never land inside `\x1b[36m` (which made the terminal print the leftover
 * `36m` as literal text). When a styled span straddles a wrap point the row is
 * closed with `ESC[0m` and the next row reopens the styles still in effect, so
 * coloring neither leaks past the line nor silently drops.
 *
 * @param {string} text
 * @param {number} width - max display width per segment (<= 0 → no wrapping)
 * @returns {string[]}
 */
function wrapCell(text, width) {
  const t = String(text == null ? '' : text);
  const cap = Math.max(0, Math.floor(Number(width) || 0));
  if (cap <= 0) {
    return t.split('\n');
  }
  const out = [];
  let acc = '';
  let accW = 0;
  // SGR state for `acc`: group → parameter string ('38;5;208' stays whole).
  const styled = Object.create(null);
  const replay = () => {
    const ps = Object.values(styled);
    return ps.length ? '\x1b[' + ps.join(';') + 'm' : '';
  };
  const breakRow = () => {
    const open = replay();
    if (open) acc += SGR_OFF;
    out.push(acc);
    acc = open;
    accW = 0;
  };
  // Walk by code point so surrogate pairs (emoji, CJK outside BMP) are never
  // split in half; step over escape sequences whole.
  let i = 0;
  while (i < t.length) {
    let token;
    let w;
    if (t[i] === '\x1b') {
      ESC_SEQ_RE.lastIndex = i;
      const m = ESC_SEQ_RE.exec(t);
      token = m ? m[0] : t[i];
      w = 0;
    } else {
      token = String.fromCodePoint(t.codePointAt(i));
      if (token === '\n') {
        breakRow();
        i += 1;
        continue;
      }
      w = visWidth(token);
    }
    if (w > 0 && accW + w > cap && accW > 0) {
      breakRow();
    }
    // A single code point wider than the cap gets its own row (never dropped,
    // never split — the physical-floor rule from 102 §6.9).
    acc += token;
    accW += w;
    if (token.length > 3 && token[0] === '\x1b' && token[1] === '[' && token.endsWith('m')) {
      const params = token.slice(2, -1);
      const codes = params === '' ? [] : params.split(';').map((p) => Number(p) || 0);
      if (codes.length === 0 || codes[0] === 0) {
        for (const k of Object.keys(styled)) delete styled[k];
      } else {
        styled[sgrGroup(codes[0])] = params;
      }
    }
    i += token.length;
  }
  out.push(acc);
  return out;
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {number} number of VISUAL rows the wrapped text occupies
 */
function visualRows(text, width) {
  return wrapCell(text, width).length;
}

/**
 * Logical row count (split on \n) for UNWRAPPED content. Billing for pre-
 * truncated one-row-per-line content (tool preview bodies).
 * @param {string} text
 * @returns {number}
 */
function visualRowsUnwrapped(text) {
  const t = String(text == null ? '' : text);
  return t === '' ? 0 : t.split('\n').length;
}

/**
 * Clip to ONE visual row of at most `width` display columns, marking the cut
 * with `marker` (default '…'). Same metering as wrapCell — code-point stepping,
 * escape sequences consumed whole — so a clip never lands inside a surrogate
 * pair and never leaves half an SGR behind.
 *
 * @param {string} text
 * @param {number} width - total columns the result may occupy, marker included
 * @param {string} [marker]
 * @returns {string}
 */
function clipCell(text, width, marker = '…') {
  const t = String(text == null ? '' : text).replace(/\r?\n/g, ' ');
  const cap = Math.floor(Number(width));
  if (!Number.isFinite(cap) || cap <= 0) {
    return '';
  }
  if (visWidth(t) <= cap) {
    return t;
  }
  const mk = visWidth(marker);
  if (cap <= mk) {
    return '';
  }
  let acc = '';
  let w = 0;
  let i = 0;
  let dropped = false;
  while (i < t.length) {
    let token;
    let tw;
    if (t[i] === '\x1b') {
      ESC_SEQ_RE.lastIndex = i;
      const m = ESC_SEQ_RE.exec(t);
      token = m ? m[0] : t[i];
      tw = 0;
    } else {
      token = String.fromCodePoint(t.codePointAt(i));
      tw = visWidth(token);
    }
    if (w + tw > cap - mk) {
      dropped = true;
      break;
    }
    acc += token;
    w += tw;
    i += token.length;
  }
  return dropped ? acc + marker : acc;
}

// Box(borderStyle:'round', paddingX:1) — what the picker chrome eats from the
// terminal width: 2 border + 2 padding columns.
const PICKER_BOX_CHROME_COLS = 4;
// Below this many columns there is nothing worth clipping to — render the row
// uncapped (and let ink wrap) rather than a row of nothing but '…'.
const PICKER_MIN_CONTENT_COLS = 8;
// The 「（12/40 · ↓更多）」 overflow hint is appended to the footer, so it can
// only ever push that row onto one more visual row.
const PICKER_HINT_ROWS = 1;
// Default cap on list rows, shared by the pickers: a cap, never a target —
// see pickerPageRows.
const PICKER_PAGE_SIZE = 12;

/**
 * Columns left for a picker row's variable content, or 0 when the width is
 * unknown / the row is too narrow to clip (caller then renders as before).
 * The prefix and suffix are measured, not assumed — number labels and
 * ' (不可选)'-style tags change width per row.
 */
function pickerRowBudget(cols, prefix, suffix) {
  const c = Math.floor(Number(cols));
  if (!Number.isFinite(c) || c <= 0) {
    return 0;
  }
  const budget = c - PICKER_BOX_CHROME_COLS - visWidth(prefix) - visWidth(suffix);
  return budget >= PICKER_MIN_CONTENT_COLS ? budget : 0;
}

/**
 * Rows a picker may spend on list items inside a terminal of `rows` lines.
 * Frame chrome is billed with the SAME wrap meter the rows use, because at
 * narrow widths the header and the footer each wrap into two visual rows —
 * assuming one is what put the 「Esc 取消」 hint off screen (BUG-54/BUG-55).
 * Returns PICKER_PAGE_SIZE when the size is unknown (render as before).
 */
function pickerPageRows(rows, cols, headerText, footerText) {
  const r = Math.floor(Number(rows));
  const c = Math.floor(Number(cols));
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(c) || c <= 0) {
    return PICKER_PAGE_SIZE;
  }
  const inner = c - PICKER_BOX_CHROME_COLS;
  const chrome = 2 + visualRows(headerText, inner) + visualRows(footerText, inner) + PICKER_HINT_ROWS;
  return Math.max(1, Math.min(PICKER_PAGE_SIZE, r - chrome));
}

/**
 * A single border row of EXACTLY `width` display columns.
 * @param {number} width
 * @param {{left?: string, right?: string, mid?: string, busy?: boolean}} [opts]
 * @returns {string}
 */
function fitBorder(width, opts = {}) {
  const left = opts.left || '╭';
  const right = opts.right || '╮';
  // busy → the gutter char switches to a "working" glyph but stays visible
  // (never `color: undefined` + dim, which vanishes in some terminals).
  const mid = opts.busy ? '╌' : (opts.mid || '─');
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const fixed = visWidth(left) + visWidth(right);
  if (w <= fixed) {
    // Degenerate width: emit whatever corners FIT (a width-1 line can only
    // hold one corner); the visWidth(s) === width invariant holds.
    if (w === 0) {
      return '';
    }
    if (w <= visWidth(left)) {
      return left.slice(0, 1);
    }
    return left + right.slice(0, 1);
  }
  const inner = w - fixed;
  const reps = Math.max(1, inner);
  let s = left + mid.repeat(reps) + right;
  // Reconcile any residual width drift (mixed-width mid glyphs): pad or trim
  // to exactly `w` display columns.
  let guard = 0;
  while (visWidth(s) < w && guard++ < 16) {
    s = left + mid.repeat(reps + guard) + right;
  }
  return s;
}

module.exports = {
  wrapCell,
  visualRows,
  visualRowsUnwrapped,
  clipCell,
  fitBorder,
  visWidth,
  pickerRowBudget,
  pickerPageRows,
  PICKER_BOX_CHROME_COLS,
  PICKER_PAGE_SIZE,
};
