'use strict';

/**
 * byteFormat.js — 纯叶子:字节数 → 人类可读串(**带空格 + 到 TB** 口径)。
 *
 * 这是 Khy 各处「盒式 ASCII 报告」里散落三份逐字节相同的本地 `_humanBytes`
 * (diskAnalyzeReport / upstreamStudyReport / diskCleanup/planner)应收敛到的
 * 单一真源。它与 `cli/ccFormat.js` 的 `ccFormatFileSize` 是**两种不同口径**,
 * 刻意不合并:
 *   - `ccFormatFileSize`:CC `format.ts` 风格,**无空格、无 TB**(`1KB` / `2.5MB`),
 *     供 CLI/TUI 内联展示。
 *   - 本函数 `humanBytes`:**带空格、到 TB、`>=100` 或 `B` 档取整**
 *     (`512 B` / `1.5 KB` / `340 MB` / `2 GB`),供盒式报告对齐列宽。
 *
 * 契约:零 I/O、确定性、绝不抛。
 *   - 非有限 / <=0 → `'0 B'`(退化,与三处历史口径逐字节一致)。
 *   - 进位到 units 末档(TB)封顶,不再往上。
 *   - 单位从 1024 起进位;`>=100` 的值或 `B` 档(i===0)取整,否则保 1 位小数。
 *
 * @module services/byteFormat
 */

/**
 * 字节数 → 人类可读串(带空格,到 TB)。
 * @param {number} n 字节数
 * @returns {string} 如 `'512 B'` / `'1.5 KB'` / `'340 MB'` / `'2 GB'`;非有限/<=0 → `'0 B'`。
 */
function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

module.exports = { humanBytes };
