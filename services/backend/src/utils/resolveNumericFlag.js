'use strict';

/**
 * resolveNumericFlag.js — 「命名数值环境门 → clamp 后的正整数」共享 helper。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_resolveNumeric(name, env, fallback, lo, hi)`——
 *   services/diskAnalyzeCatalog · services/upstreamStudyCatalog(各自 `../utils/resolveNumericFlag`)。
 *
 * 语义:先试 flagRegistry.resolveNumeric(name, env)——命中有限正数即用(不 clamp,
 *   由 flagRegistry 权威裁决);否则回退直读 env[name] 解析整数,有限且 >0 → clamp 到
 *   [lo, hi];再否则 → fallback。
 *
 * 契约:非纯(读 process.env 默认 + require flagRegistry),但确定性给定 env;不 mutate 入参。
 *   各消费方保留同名本地 `const _resolveNumeric = require('../utils/resolveNumericFlag')`
 *   → 调用点逐字节不变。
 */

function resolveNumericFlag(name, env, fallback, lo, hi) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../services/flagRegistry');
    const v = flagRegistry.resolveNumeric(name, e);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* fall through */ }
  const raw = Number.parseInt((e && e[name]) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(hi, Math.max(lo, raw));
  return fallback;
}

module.exports = resolveNumericFlag;
