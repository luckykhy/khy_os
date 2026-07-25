'use strict';

/**
 * envIntNonNeg.js — 「按名读 process.env 的非负整数(带默认)」单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_envInt(name, def)`
 * (services/learningCurriculumDynamic · learningImprove · maintainerCockpit):
 *   `Number.parseInt(String(process.env[name] || '').trim(), 10)`;
 *   有限且 **>= 0** → 该值,否则(NaN / 负数 / 缺失)→ def。
 *
 * **刻意不收敛(C 组·`_envInt` 家族高度分叉,签名与口径各异)**:
 *   - ragRetrievalService / learningRetrieval / auditFixLoop.triggerGate — `(…, min, max)` 带钳位;
 *   - subagentContextSummary — `(env, key, fallback, lo, hi)` 值型 env + round + 钳位;
 *   - reversibility — `(name, fallback, {min, max})` options 形;
 *   - contextProfile / projectBlueprint.catalog / query.streamRepetitionGuard — `n > 0`(非 >= 0)+ 空值前置判;
 *   - weipuxiezuo.rules / diskCleanup.junkCatalog — `Number.isFinite(v)` 无 >= 0 约束(接受负数);
 *   - gateway.cacheEconomyStore / tools._fileLock — `Number(...)` + `> 0` + Math.floor。
 *   上述返回集/边界与本 util 不同,委托会改行为,留原样。
 *
 * 契约:确定性、不 mutate、缺失/非法 → def。读全局 process.env(非纯·name-based env 读取惯用)。
 *
 * 各消费方保留同名本地 `const _envInt = require('../utils/envIntNonNeg')` → 调用点逐字节不变。
 */

function envIntNonNeg(name, def) {
  const n = Number.parseInt(String(process.env[name] || '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

module.exports = envIntNonNeg;
