'use strict';

/**
 * orderedListAlign — 纯叶子:有序(数字)列表标记右对齐。
 *
 * 对齐 CC `src/components/ui/OrderedList.tsx` 的后端逻辑:
 *   `maxMarkerWidth = String(numberOfItems).length`,每个 marker 经 `padStart(maxMarkerWidth)`
 *   → ` 1.` … ` 9.`,`10.`,`11.` —— 列表跨 9→10 时点号与正文**仍然对齐**,不右跳。
 *
 * Khy `markdownRenderer` 旧逐行正则 `^(\s*)(\d+)\.\s+` 把 `${num}.` 各自渲染,**无跨行对齐**:
 * `9.`(宽 2)与 `10.`(宽 3)正文起始列不同 → 第 10 项起整段正文向右跳一格。本叶子在上色链
 * **之前**只调整有序列表行「数字前的左填充空白」(把 num `padStart` 到该 run 的最大宽度),
 * 保留缩进/正文/**源序号**;既有上色正则原样匹配(pad 空白并入 `(\s*)` 缩进组,不可见)。
 *
 * 刻意偏差:CC 用 `index+1` **重编号**;Khy 既有策略**保留源序号**(注释「preserve the ordinal」,
 * 列表可故意从 5 开始)。本叶子只采纳 CC 的 `padStart` 对齐,**不动序号**(重编号可能改对/改错)。
 *
 * 一个「run」= 连续、**同缩进**的有序列表项行;非项行或缩进变化都断开 run(嵌套 = 另一 run)。
 * 当 run 内所有序号位数相同(含单项 run)→ padStart 加 0 空格 → **逐字节不变**。
 * 门控 `KHY_OL_MARKER_ALIGN`(默认开)关 → 原样返回逐字节回退。零 IO、确定性、绝不抛(leaf-contract)。
 */

// Ordered-list item: leading indent, digits, a literal '.', then ≥1 space + content.
// Dot-only (matches the renderer's existing colorize regex; ')'-lists are left alone).
const OL_ITEM = /^(\s*)(\d+)\.(\s+)(.*)$/;

/**
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function orderedListAlignEnabled(env = process.env) {
  const flag = String((env && env.KHY_OL_MARKER_ALIGN) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * Right-align ordered-list markers within each contiguous same-indent run by
 * padding the ordinal with leading spaces to the run's widest ordinal. Pure
 * text→text; only inserts spaces before the digits, never touches content or
 * the source ordinal. Byte-identical when a run's ordinals are all the same
 * width. Never throws — returns the input unchanged on any anomaly.
 * @param {string} text
 * @returns {string}
 */
function alignOrderedListMarkers(text) {
  try {
    const src = String(text == null ? '' : text);
    if (src.indexOf('.') === -1) return src; // fast path: no possible "N." marker
    const lines = src.split('\n');
    const n = lines.length;
    let i = 0;
    while (i < n) {
      const m = lines[i].match(OL_ITEM);
      if (!m) { i++; continue; }
      const indent = m[1];
      // Gather the maximal run of consecutive items at this exact indent.
      const run = [];
      let j = i;
      while (j < n) {
        const mj = lines[j].match(OL_ITEM);
        if (!mj || mj[1] !== indent) break;
        run.push({ idx: j, num: mj[2], gap: mj[3], rest: mj[4] });
        j++;
      }
      const maxWidth = run.reduce((w, it) => Math.max(w, it.num.length), 0);
      for (const it of run) {
        const pad = ' '.repeat(maxWidth - it.num.length);
        // indent + leading-pad + num + '.' + original gap + content.
        lines[it.idx] = `${indent}${pad}${it.num}.${it.gap}${it.rest}`;
      }
      i = j;
    }
    return lines.join('\n');
  } catch {
    return String(text == null ? '' : text);
  }
}

module.exports = { alignOrderedListMarkers, orderedListAlignEnabled, OL_ITEM };
