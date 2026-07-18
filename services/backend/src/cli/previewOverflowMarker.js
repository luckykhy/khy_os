'use strict';

// 对齐 CC「后端逻辑也对齐」:diff/预览「溢出折叠标记」的**文本构造逻辑**单一真源。
//
// khy 的 write-diff / 文件预览在「头部预览 + 隐藏其余」时会缀一行溢出标记,告诉
// 用户「还有 N 行/N 行没显示,ctrl+o 展开」(展开态改说 capped):
//   `... +N lines (ctrl+o to expand)` / `... +N lines (capped)`
//   `... (diff truncated, N more rows, ctrl+o to expand)` / `..., N more rows, capped)`
//
// 这条标记被**两套独立渲染引擎逐字重复**:
//   - Ink TUI   src/cli/tui/ink-components/ToolLines.js::buildWriteDiffRows
//   - 经典 REPL src/cli/repl/toolOutputRender.js(新建/删除文件预览)
// 两处都把 `lines`/`rows` 写死复数,N=1 时输出语法错误的「+1 lines」「1 more row」,
// 而 khy 自己紧挨着的 gap 分隔行(ToolLines.js:217)和 diffRenderer.js:388 早已
// `line${n !== 1 ? 's' : ''}` 守复数 —— CC 的显示约定是处处守 `=== 1`。
//
// 本叶子把「溢出标记文本 + 复数守卫」收敛成单一真源,两套引擎共用。各 call-site
// 仍自管缩进(经典 REPL 的 `    ` 前缀)与着色(c.dim / chalk),本叶子只产核心文本。
//
// 门控 KHY_PREVIEW_OVERFLOW_PLURAL 默认开:关 → 复数不守(恒 `lines`/`rows`),与
// 历史**逐字节回退**。开 → N===1 时单数(line/row),N>1 时复数(与历史一致)。

const FALSY = new Set(['0', 'false', 'off', 'no']);

function previewOverflowPluralEnabled(env = process.env) {
  const flag = String((env && env.KHY_PREVIEW_OVERFLOW_PLURAL) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

// CC 折叠决策对齐(utils/terminal.ts wrapText:42-60):折叠标记本身占一个终端行,
// 当**恰好只有 1 行**会被隐藏时,标记消耗的纵向空间与它所藏的那一行**一样多** ——
// 于是 CC 直接把那多出的一行内联显示、**完全不发标记**(`slice(0, MAX+1)` 且
// `remainingLines:0`)。标记只在隐藏 **≥2 行**时才划算。
//   门控 KHY_PREVIEW_OVERFLOW_INLINE_ONE 默认开:hidden===1 → 内联(keep=previewMax+1、
//   hidden=0、无标记);关 → 逐字节回退历史(hidden===1 仍显 `+1 line` 标记)。
function foldInlineSingleEnabled(env = process.env) {
  const flag = String((env && env.KHY_PREVIEW_OVERFLOW_INLINE_ONE) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

// 复数守卫:门控关 → 恒复数(legacy 字节回退);门控开 → CC 约定 `=== 1` 守单数。
function _noun(base, n, env) {
  if (!previewOverflowPluralEnabled(env)) return `${base}s`;
  return `${base}${n === 1 ? '' : 's'}`;
}

function _count(n) {
  return Number.isFinite(n) ? n : 0;
}

/**
 * CC 头部预览折叠决策:给定总行数 `total` 与头部预览上限 `previewMax`,决定
 * **保留**几行(keep)与**隐藏**几行(hidden,即 `+N` 标记里的 N)。镜像 CC
 * utils/terminal.ts wrapText:42-60 —— 恰好隐藏 1 行时内联它、不发标记。
 *
 * 门控关(或非本内联特例)时严格等价于历史 `slice(0, previewMax)` + 「total>previewMax
 * 则标记 total-previewMax」:total<=previewMax → {keep:total, hidden:0};否则
 * {keep:previewMax, hidden:total-previewMax}。→ 逐字节回退。
 *
 * @param {number} total     - 总行数,可为 0。
 * @param {number} previewMax - 头部预览上限。
 * @param {object} [env]
 * @returns {{keep:number, hidden:number}} 均为非负整数;绝不抛。
 */
function resolveFold(total, previewMax, env = process.env) {
  const t = _count(total);
  const p = _count(previewMax);
  if (t <= p) return { keep: t, hidden: 0 }; // 放得下 —— 无隐藏
  const hidden = t - p;
  // CC 规则:恰藏 1 行 → 内联那一行(keep=previewMax+1),不发标记。
  if (foldInlineSingleEnabled(env) && hidden === 1) return { keep: p + 1, hidden: 0 };
  return { keep: p, hidden };
}

/**
 * 头部预览溢出标记:`... ±N line(s) (ctrl+o to expand|capped)`。
 * 用于「只显示头部 previewMax 行、隐藏其余 n 行」的单文件 add/del 预览。
 *
 * @param {number} n        - 被隐藏(未显示)的行数,可为 1。
 * @param {'+'|'-'} sign     - `+`(新增预览)/`-`(删除预览)。
 * @param {boolean} expanded - true → 展开态 `(capped)`(无 ctrl+o 承诺);
 *                             false → 折叠态 `(ctrl+o to expand)`。
 * @param {object} [env]
 * @returns {string} 核心标记文本(不含缩进/着色)。
 */
function buildLinesOverflow(n, sign, expanded, env = process.env) {
  const c = _count(n);
  const s = sign === '-' ? '-' : '+';
  const tail = expanded ? '(capped)' : '(ctrl+o to expand)';
  return `... ${s}${c} ${_noun('line', c, env)} ${tail}`;
}

/**
 * 多 hunk 行数封顶溢出标记:`... (diff truncated, N more row(s), capped|ctrl+o to expand)`。
 *
 * @param {number} dropped  - 被截掉的 diff 行数,可为 1。
 * @param {boolean} expanded - true → `capped`;false → `ctrl+o to expand`。
 * @param {object} [env]
 * @returns {string}
 */
function buildRowsOverflow(dropped, expanded, env = process.env) {
  const c = _count(dropped);
  const tail = expanded ? 'capped' : 'ctrl+o to expand';
  return `... (diff truncated, ${c} more ${_noun('row', c, env)}, ${tail})`;
}

module.exports = {
  previewOverflowPluralEnabled,
  foldInlineSingleEnabled,
  resolveFold,
  buildLinesOverflow,
  buildRowsOverflow,
};
