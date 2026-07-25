'use strict';

/**
 * tryOrAsync.js — 纯 util:async try/catch combinator 单一真源。
 *
 * 这是 cli/handlers/* 里 5 处逐字节相同的私有 `_safeAsync(fn, dflt)` 收敛后的单一真源
 * (advisor / autofixPr / autonomy / onboarding / subscribePr)。
 * 语义:`await fn()`,任何异常(同步抛出或 rejected Promise)→ 返回 `dflt`(吞错,fail-soft)。
 * 是 utils/tryOr 的异步姊妹(见 [[project_ssot_convergence_rounds]] Round 10/11)。
 *
 * 契约:
 *   - 只 await 一次 `fn()`,不重试。
 *   - 同步抛出与 rejected Promise 均归入 dflt 分支。
 *   - 不改变 `dflt`,不 mutate 任何入参。
 *
 * 各消费方保留同名本地 `const _safeAsync = require('../../utils/tryOrAsync')` → 调用点逐字节不变。
 */

async function tryOrAsync(fn, dflt) {
  try { return await fn(); } catch { return dflt; }
}

module.exports = tryOrAsync;
