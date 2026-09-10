'use strict';

/**
 * textMeasure — canonical CJK/ANSI text measurement utilities for TUI.
 *
 * Single source of truth for stripAnsi, isFullwidth, visWidth, visPad.
 * All TUI components import from here; no inline duplicates.
 *
 * 与 cli/formatters.js 的 displayWidth() 保持码点范围一致(含 emoji 0x1f300-0x1f9ff),
 * 确保 CLI/TUI 对同一文本的宽度判定相同。
 */

/** Strip ANSI escape sequences. */
// 收敛到 utils/stripAnsi 单一真源(逐字节委托,调用点不变)
const stripAnsi = require('../../../utils/stripAnsi');

/** Test whether a Unicode code point is fullwidth (CJK, etc.). */
function isFullwidth(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

/** Visible display width (strips ANSI, CJK=2). */
function visWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) {
    w += isFullwidth(ch.codePointAt(0)) ? 2 : 1;
  }
  return w;
}

/** Pad string to target visible width with trailing spaces. */
function visPad(str, width) {
  const gap = Math.max(0, width - visWidth(str));
  return str + ' '.repeat(gap);
}

module.exports = { stripAnsi, isFullwidth, visWidth, visPad };
