'use strict';

/**
 * normLower.js — 纯 util:nullish-安全的「trim + 小写」规整单一真源。
 *
 * 收敛 src/ 下 5 处逐字节相同的私有 `_norm(v)`
 * (gateway/adapters/streamStallPolicy · khySelfUpdateService · packageRegistryService ·
 *  pipFailurePolicy · repoDisciplineRisk)。
 * 语义:null/undefined → 空串,其余 String 强转后 `.trim().toLowerCase()`;fail-soft(异常 → '')。
 *
 * 契约:纯函数、确定性、不 mutate、绝不抛(内建 try/catch,防御 toString 抛错的对象)。
 * 区别于:utils/cleanText(仅 trim 不小写)。
 *
 * 各消费方保留同名本地 `const _norm = require('.../normLower')` → 调用点逐字节不变。
 */

function normLower(v) {
  try {
    return String(v === undefined || v === null ? '' : v).trim().toLowerCase();
  } catch {
    return '';
  }
}

module.exports = normLower;
