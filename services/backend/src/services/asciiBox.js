'use strict';

/**
 * asciiBox.js — 纯叶子:盒式 ASCII 报告的行/分隔线基元(宽度参数化)。
 *
 * diskAnalyzeReport / upstreamStudyReport 两处的 `_row` / `_rule` 逐字节相同,
 * 唯一差异是各自闭包的模块级 `WIDTH`(60 vs 66)。此叶子把这两个基元收敛成
 * 单一真源,宽度改为显式入参 —— 调用方保留同名本地 `_row`/`_rule` 薄委托
 * (传入本模块 WIDTH),故 44 处调用点逐字节不变。
 *
 * 契约:零 I/O、确定性、绝不抛。宽度为盒内文本可视宽度(不含左右 `│ ` `│` 边框)。
 *
 * @module services/asciiBox
 */

/**
 * 定宽内容行:`│ <padded> │`。超宽截断,不足右侧补空格。
 * @param {*} text 行内容(null/undefined → 空串)
 * @param {number} width 盒内可视宽度
 * @returns {string}
 */
function boxRow(text, width) {
  const s = String(text == null ? '' : text);
  const padded = s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
  return `│ ${padded} │`;
}

/**
 * 分隔线:无 label → 纯 `├───┤`;有 label → `├─ label ─────┤`。
 * @param {string} [label] 段标题(空 → 纯分隔线)
 * @param {number} width 盒内可视宽度
 * @returns {string}
 */
function boxRule(label, width) {
  if (!label) return `├${'─'.repeat(width + 2)}┤`;
  const inner = `─ ${label} `;
  const fill = width + 2 - inner.length;
  return `├${inner}${'─'.repeat(Math.max(0, fill))}┤`;
}

module.exports = { boxRow, boxRule };
