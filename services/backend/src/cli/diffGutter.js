'use strict';

// 对齐 CC「后端逻辑也对齐」:结构化 diff 行号 gutter 的**宽度计算逻辑**单一真源。
//
// CC 源 src/components/StructuredDiff.tsx::computeGutterWidth —
//   maxLineNumber = Math.max(oldStart+oldLines-1, newStart+newLines-1, 1)
//   gutterWidth   = maxLineNumber.toString().length + 3   // marker(1) + 2 padding
// 即:行号列**右对齐到本 hunk 实际出现的最大行号的位数**(至少 1 位),marker/空格另算。
//
// Khy 历史在所有结构化 diff 渲染路径硬编码 `String(num).padStart(4)`(恒 4 位),
// 既对小文件(行号 ≤ 999)多浪费一列,又在 hunk 跨位数边界(如 9998→10002)或
// 行号 ≥ 5 位时**对不齐**(4 位宽容不下 5 位数字,同 hunk 内 4 位/5 位混排错位)。
//
// 本叶子把「gutter 数字位宽」收敛成单一真源:门控开 = CC 动态位宽;
// 门控关 = 恒 4 位,与历史 padStart(4) **逐字节回退**。marker(`+`/`-`/空格)与
// 着色仍归各 call-site 自己的样式层,本叶子只产「数字右对齐到几位」这一决策 + 填充。

const FALSY = new Set(['0', 'false', 'off', 'no']);

function diffGutterWidthEnabled(env = process.env) {
  const flag = String((env && env.KHY_DIFF_GUTTER_WIDTH) || '').trim().toLowerCase();
  return !FALSY.has(flag);
}

const LEGACY_WIDTH = 4;

function _digits(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 0;
  return String(v).length;
}

/**
 * Gutter digit-width from an explicit max line number (single-block path, e.g.
 * diffRenderer.renderStructuredDiff). Mirrors CC's `maxLineNumber.toString().length`
 * with CC's `Math.max(maxLineNumber, 1)` floor → never below 1 digit.
 * Gate off → legacy fixed 4 (byte-identical to the old `padStart(4)`).
 */
function computeDiffGutterWidthForMax(maxLineNumber, env = process.env) {
  if (!diffGutterWidthEnabled(env)) return LEGACY_WIDTH;
  const d = _digits(maxLineNumber);
  return d > 0 ? d : 1; // CC floors maxLineNumber at 1 → at least one digit column
}

/**
 * Gutter digit-width from a flat list of diff rows (multi-hunk path, e.g.
 * ToolLines.renderDiffRows). Width = max digit-length over rows carrying a `num`.
 * When NO row is numbered (e.g. KHY_DIFF_LINE_NUMBERS off → all num == null), fall
 * back to the legacy filler width 4 so that no-number diffs stay byte-identical.
 * Gate off → legacy fixed 4.
 */
function computeDiffGutterWidth(rows, env = process.env) {
  if (!diffGutterWidthEnabled(env)) return LEGACY_WIDTH;
  let max = 0;
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && r.num != null) {
        const d = _digits(r.num);
        if (d > max) max = d;
      }
    }
  }
  return max > 0 ? max : LEGACY_WIDTH; // no numbered rows → preserve legacy 4-space filler
}

/**
 * Right-align a line number (or render a blank filler when num == null) to `width`.
 * Single source for the gutter cell so every diff path pads identically.
 */
function formatDiffGutterNum(num, width) {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : LEGACY_WIDTH;
  return num != null ? String(num).padStart(w) : ' '.repeat(w);
}

module.exports = {
  diffGutterWidthEnabled,
  computeDiffGutterWidth,
  computeDiffGutterWidthForMax,
  formatDiffGutterNum,
};
