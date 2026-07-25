'use strict';

/**
 * tryOr.js — 纯 util:try/catch combinator 单一真源。
 *
 * 这是 cli/handlers/* 里 8 处逐字节相同的私有 `_safe(fn, dflt)` 收敛后的单一真源
 * (advisor / autofixPr / autonomy / ideStatus / subscribePr / onboarding / claimMain / proactive)。
 * 语义:同步执行 `fn()`,任何异常 → 返回 `dflt`(吞错,fail-soft)。
 *
 * 契约:
 *   - 只调用一次 `fn()`,不重试。
 *   - 只捕获同步抛出;`fn` 返回 rejected Promise 不在捕获范围(调用方从不用于异步)。
 *   - 不改变 `dflt`,不 mutate 任何入参。
 *
 * 各消费方保留同名本地 `const _safe = require('../../utils/tryOr')` → 调用点逐字节不变。
 */

function tryOr(fn, dflt) {
  try { return fn(); } catch { return dflt; }
}

module.exports = tryOr;
