'use strict';

/**
 * footerLayout.js — 底部状态栏的纯布局内核（从 repl.js startRepl 闭包抽出）。
 *
 * 仅承载「给定左标签 + 右信息 + 终端列宽 → 单行底栏字符串」的确定性排版数学
 * （ANSI 宽度测量、截断、补白、永不换行的硬钳位），不读取任何渲染/会话状态。
 * 样式经 `dim` 注入（chalk dim），故可用 identity 样式器独立单测。
 */

/** 去掉 ANSI 颜色码后的可见文本。 */
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '');
}

/** 把纯文本截断到至多 n 个字符，超出以 '…' 收尾。 */
function truncatePlain(s, n) {
  const text = String(s == null ? '' : s);
  if (n <= 0) return '';
  if (text.length <= n) return text;
  return n <= 1 ? text.slice(0, n) : `${text.slice(0, n - 1)}…`;
}

/**
 * 排版权限/上下文底栏为单行：左对齐标签 + 右对齐信息，中间补白；
 * 信息过长按预算截断，整行超宽做最终硬钳位（绝不换行到下一行）。
 *
 * @param {object} o
 * @param {string} o.permLeft   左侧标签（可含 ANSI 样式）
 * @param {string} o.rightPlain 右侧信息（纯文本，调用方已 join）
 * @param {number} o.cols       终端列宽
 * @param {(s:string)=>string} o.dim 截断/降级时套用的样式器（chalk dim）
 * @returns {string} 最终底栏单行
 */
function composePermissionFooter({ permLeft, rightPlain, cols, dim }) {
  const width = cols > 0 ? cols : 80;
  const style = typeof dim === 'function' ? dim : (s) => s;

  const maxRightLen = Math.max(0, width - 8); // 预留左标签 + 间隙
  const rightPlainTrunc = truncatePlain(rightPlain, maxRightLen);
  const rightText = rightPlainTrunc ? style(rightPlainTrunc) : '';

  const plainLeft = stripAnsi(permLeft);
  const rightLen = stripAnsi(rightText).length;
  const leftBudget = Math.max(1, width - rightLen - 2);
  const safeLeft = plainLeft.length > leftBudget
    ? style(plainLeft.slice(0, Math.max(1, leftBudget - 1)) + '…')
    : permLeft;

  const leftLen = stripAnsi(safeLeft).length;
  const pad = Math.max(1, width - leftLen - rightLen - 1);
  const line = safeLeft + ' '.repeat(pad) + rightText;

  // 最终硬钳位：底栏永不换行到下一行
  const plainLine = stripAnsi(line);
  const maxFooterCols = Math.max(1, width - 1);
  if (plainLine.length > maxFooterCols) {
    return style(truncatePlain(plainLine, maxFooterCols));
  }
  return line;
}

module.exports = { stripAnsi, truncatePlain, composePermissionFooter };
