'use strict';

/**
 * foldLongLines — pre-layout folding of over-long lines (DESIGN-ARCH-103 P1).
 *
 * dsh-TUI's fold-long-lines.ts, adopted as a hard constraint (rule 1: folding
 * happens BEFORE the layout engine sees the content, so row-height signatures
 * are computed on the folded shape and can never go stale). Rules:
 *   ① process line-by-line (preserve \n line boundaries); a line whose display
 *      width fits within `width` passes through UNTOUCHED (zero-allocation fast
 *      path: when no line is folded the original array is returned by identity);
 *   ② an over-long line is cut to a multiple of the display width (never in the
 *      middle of a display cell) and gets an inline hint `… 已折叠 N 字符（点击或
 *      Ctrl+O 展开）`;
 *   ③ surrogate pairs are never split — iterate by code point, join back.
 */

const { visWidth } = require('./wrapCell');

/**
 * @param {string} text
 * @param {{limit?: number, width?: number}} [opts] limit = fold threshold in
 *   display width (default 1000); width = target visual width for the cut.
 * @returns {{lines: string[], folded: number, byIdentity: boolean}}
 *   lines: the folded rows; folded: number of lines that were actually cut;
 *   byIdentity: true when nothing was folded (the input array was returned
 *   unchanged — the zero-allocation fast path).
 */
function foldLongLines(text, opts = {}) {
  const t = String(text == null ? '' : text);
  const limit = Math.max(1, Math.floor(Number(opts.limit) || 1000));
  const width = Math.max(1, Math.floor(Number(opts.width) || limit));
  const rawLines = t.split('\n');
  const out = [];
  let folded = 0;

  for (const line of rawLines) {
    const w = visWidth(line);
    if (w <= limit) {
      out.push(line);
      continue;
    }
    // Over-long: keep the FIRST `width` display cells visible, hide the rest,
    // and append an inline hint. Code-point iteration keeps surrogate pairs
    // whole; `visible` is the kept head, `hidden` accumulates the dropped tail.
    let visible = '';
    let visibleW = 0;
    let hidden = '';
    for (const cp of line) {
      const cw = visWidth(cp);
      if (visible === '' || visibleW + cw <= width) {
        visible += cp;
        visibleW += cw;
      } else {
        hidden += cp;
      }
    }
    const hiddenChars = hidden.length;
    folded += 1;
    out.push(visible + `… 已折叠 ${hiddenChars} 字符（点击或 Ctrl+O 展开）`);
  }

  return { lines: out, folded, byIdentity: folded === 0 };
}

module.exports = { foldLongLines };
