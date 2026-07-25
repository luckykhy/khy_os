'use strict';

/**
 * toNonNegInt.js — 「强转数字→非负整数,否则 0」计数归一化单一真源(纯)。
 *
 * 收敛 3 处 body 逐字节相同的私有 helper:
 *   `const v = Number(n); if (!Number.isFinite(v) || v <= 0) return 0; return Math.floor(v);`
 *   (cli/contextPanelDetail._nonNegInt · cli/statsConversationLines._count ·
 *    services/context/contextBreakdown._nonNegInt):
 *   Number(n) 后,非有限(NaN/±Infinity)或 ≤0 → 0,否则向下取整。
 *
 * **刻意不收敛(不可互委)**:
 *   - 允许负数、或用 Math.round/Math.ceil 取整的变体。
 *   - 下界用 `< 0`(容许 0 但 v<=0 归 0 语义不同)、或有 max 上限钳位的变体。
 *   - 解析失败返 null/-1/默认值(非 0)的变体。
 *
 * 契约:纯函数、确定性、不 mutate。`v <= 0 → 0` 令 0 与负数皆归 0(计数下界)。
 *
 * 各消费方保留同名本地 `const NAME = require('.../toNonNegInt')`→ 调用点逐字节不变。
 */

function toNonNegInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

module.exports = toNonNegInt;
