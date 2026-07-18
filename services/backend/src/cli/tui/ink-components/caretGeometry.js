'use strict';

// caretGeometry.js — pure leaf (zero IO, deterministic, never throws).
//
// 输入体验「候选区跟随光标」两条修复(Fix 1a 系统 IME 真实光标 / Fix 1b khy 自己的补全下拉
// 横向对齐)共享的列几何单一真源。把「caret 在渲染行里的显示列」与两个门控判定抽离成无副作用
// 函数,便于单测,且让 PromptFrame / App.js 两个薄壳保持薄。
//
// **关键(避免循环依赖)**:本叶子**绝不** `require('./PromptFrame')`——PromptFrame 会 require
// 本叶子取门控/列数学,若反向依赖即成环。故 `caretColumn` **接收调用方已算好的 `rows`**
// (来自 `PromptFrame.layoutPromptRows`)而非自己重算布局=单向依赖。
//
// 门控 KHY_IME_CURSOR / KHY_COMPLETION_FOLLOW_CURSOR 默认开;关 → 上层薄壳逐字节回退现状
// (光标恒隐藏 / 补全下拉贴左),沿用 liveRegionBudget 同 OFF_VALUES 语义。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// "❯ "(行 0)/ "  "(续行)前缀都占 2 列。镜像 PromptFrame.MARKER_W(两处同值;PromptFrame
// 是布局真源,本常量供无 PromptFrame 引用的纯列数学复用,避免叶子反向 require 成环)。
const MARKER_W = 2;

/** 默认宽度度量:UTF-16 code-unit 长度。壳注入 formatters.displayWidth 以支持 CJK 宽度。 */
function _defaultMeasure(s) {
  return String(s == null ? '' : s).length;
}

/**
 * 在渲染行模型里定位 caret 的**显示列**(含 marker 宽度)。
 *
 * `rows` 即 PromptFrame.layoutPromptRows(...).rows —— 每个 'line' 行含 `text` 与
 * `caretCol`(该行 caret 的 UTF-16 列,或 null)。找到 `caretCol != null` 的那一行,
 * `col = MARKER_W + measure(text.slice(0, caretCol))`。
 *
 * 永不抛:`rows` 非数组 / 行结构异常 / measure 抛 → 防御回退 `{ col: MARKER_W, rowIndex: -1 }`。
 *
 * @param {Array} rows
 * @param {{ measure?: (s:string)=>number }} [opts]
 * @returns {{ col:number, rowIndex:number }}
 */
function caretColumn(rows, opts = {}) {
  const measure = (opts && typeof opts.measure === 'function') ? opts.measure : _defaultMeasure;
  const fallback = { col: MARKER_W, rowIndex: -1 };
  if (!Array.isArray(rows)) return fallback;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.kind !== 'line') continue;
    if (row.caretCol == null) continue;
    const text = String(row.text == null ? '' : row.text);
    const col = Math.max(0, Number(row.caretCol) || 0);
    let width;
    try { width = Number(measure(text.slice(0, col))); }
    catch { width = text.slice(0, col).length; }
    if (!Number.isFinite(width) || width < 0) width = 0;
    return { col: MARKER_W + width, rowIndex: i };
  }
  return fallback;
}

/**
 * 把补全下拉的左偏移量钳制在 `[0, cols - minMenuWidth]`,保证下拉不被推出屏幕右缘。
 * 非有限入参 → 0(保守贴左)。
 * @param {number} col
 * @param {number} cols 终端列数
 * @param {number} minMenuWidth 下拉最小可见宽度(保证右侧至少留这么多列)
 * @returns {number}
 */
function clampColumn(col, cols, minMenuWidth) {
  const c = Number(col);
  const w = Number(cols);
  const m = Number(minMenuWidth);
  if (!Number.isFinite(c) || c <= 0) return 0;
  if (!Number.isFinite(w) || w <= 0) return 0;
  const room = w - (Number.isFinite(m) && m > 0 ? m : 0);
  return Math.max(0, Math.min(Math.floor(c), Math.floor(room)));
}

/** 门控判定:显式 falsy(0/false/off/no,大小写/空白不敏感)→ false;其余(含 unset)→ true。 */
function _flagOn(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/** 系统 IME 真实光标跟随默认开;仅显式 falsy 关闭(→ 光标恒隐藏=legacy)。 */
function imeCursorEnabled(env = process.env) {
  return _flagOn(env && env.KHY_IME_CURSOR);
}

/** khy 自己的补全下拉横向对齐光标列默认开;仅显式 falsy 关闭(→ 下拉贴左=legacy)。 */
function completionFollowEnabled(env = process.env) {
  return _flagOn(env && env.KHY_COMPLETION_FOLLOW_CURSOR);
}

module.exports = {
  MARKER_W,
  OFF_VALUES,
  caretColumn,
  clampColumn,
  imeCursorEnabled,
  completionFollowEnabled,
};
