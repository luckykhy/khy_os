'use strict';

/**
 * finiteNumber.js — 纯 util:「数值强转到有限数 + 下限地板」家族的单一真源。
 *
 * 收敛 src/ 下三个逐字节相同的私有 `_num(v)` 簇(共 15 处):
 *   - toFiniteOr0   :`Number.isFinite(n) ? n : 0`               —— 非有限 → 0(负数保留)。×7
 *   - toPositiveOr0 :`Number.isFinite(n) && n > 0 ? n : 0`       —— 非有限或 ≤0 → 0。×5
 *   - toNonNegOr0   :`Number.isFinite(n) && n >= 0 ? n : 0`      —— 非有限或 <0 → 0。×3
 *
 * 三者仅在「负数怎么处理」上不同,故分三个具名函数而非一个参数化函数
 * (参数化会改调用点签名,破坏逐字节委托)。
 *
 * 契约:纯函数、确定性、不 mutate、绝不抛。区别于:
 *   - utils/clampInt(带上下界 + round + fallback)
 *   - utils/envNum (env-key → number|undefined)
 * 本家族只做「强转 + 单侧地板到 0」,不取整、不设上界。
 *
 * 各消费方保留同名本地 `const _num = require('.../finiteNumber').toXxxOr0` → 调用点逐字节不变。
 */

function toFiniteOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toPositiveOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toNonNegOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

module.exports = { toFiniteOr0, toPositiveOr0, toNonNegOr0 };
