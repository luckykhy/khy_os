'use strict';

/**
 * overflowInterceptor.js — 断点续传网关 / 溢出拦截器（§3.4）。
 *
 * 两道闸门 + 一张安全网：
 *   1. 资源预算规划强制（防呆⑤）：每步执行前模型必须给出预算规划
 *      {remaining, estimatedStepCost, strategy}；缺失即阻断执行（无预算不开火）。
 *   2. 前置溢出熔断（§3.4 下溢出拦截）：若「已用 + 本步预估」越过窗口上限的 80%，
 *      强制阻断执行，转入压缩流（compress）或卸载流（offload），绝不硬撞溢出。
 *   3. 截断异常紧急快照（防呆④）：模型一旦因上下文限制抛出截断错误，立即视作「异常
 *      熔断」，从残存上下文抽取生成紧急快照，绝不丢失任务进度。
 *
 * 纯策略层：自身不压缩、不落盘，只产出「该走哪条流」的裁决，交由 engine 编排执行。
 */

// 阈值上限的占用红线（§3.4「超过阈值上限的 80%」）。
const BUDGET_CEIL_RATIO = 0.80;

const ACTIONS = Object.freeze({
  PROCEED: 'proceed',     // 预算充足，放行
  COMPRESS: 'compress',   // 越线但仍可压：转压缩流
  OFFLOAD: 'offload',     // 压缩已不够：转卸载流（L3）
  BLOCK: 'block',         // 缺预算规划：阻断（防呆⑤）
});

/**
 * 防呆⑤：校验执行前的资源预算规划是否齐备。
 * @param {object} plan { remaining, estimatedStepCost, strategy }
 * @returns {{valid:boolean, missing:string[]}}
 */
function requireBudgetPlan(plan) {
  const missing = [];
  if (!plan || typeof plan !== 'object') {
    return { valid: false, missing: ['remaining', 'estimatedStepCost', 'strategy'] };
  }
  if (!Number.isFinite(plan.remaining)) missing.push('remaining');
  if (!Number.isFinite(plan.estimatedStepCost)) missing.push('estimatedStepCost');
  if (!plan.strategy) missing.push('strategy');
  return { valid: missing.length === 0, missing };
}

/**
 * 前置预判 + 强制熔断。
 * @param {object} args
 * @param {number} args.usedTokens          当前已用 token
 * @param {number} args.estimatedStepTokens 本步预估消耗
 * @param {number} args.windowTokens        上下文窗口上限
 * @param {object} [args.budgetPlan]        模型给出的预算规划（防呆⑤）
 * @param {boolean} [args.canCompress=true] 历史是否仍有可压空间（false → 直接 offload）
 * @returns {{allow:boolean, action:string, ratio:number, ceil:number, reason:string,
 *   budget?:object}}
 */
function preflight(args = {}) {
  const window = Math.max(1, Number(args.windowTokens) || 0);
  const used = Math.max(0, Number(args.usedTokens) || 0);
  const est = Math.max(0, Number(args.estimatedStepTokens) || 0);
  const ceil = window * BUDGET_CEIL_RATIO;

  // 防呆⑤：无合规预算规划 → 阻断执行。
  const planCheck = requireBudgetPlan(args.budgetPlan);
  if (!planCheck.valid) {
    return {
      allow: false,
      action: ACTIONS.BLOCK,
      ratio: used / window,
      ceil,
      reason: `缺少资源预算规划，阻断执行（防呆⑤）：missing ${planCheck.missing.join(',')}`,
    };
  }

  const projected = used + est;
  const ratio = projected / window;
  if (projected <= ceil) {
    return { allow: true, action: ACTIONS.PROCEED, ratio, ceil, reason: '预算充足，放行。' };
  }

  // 越过 80% 上限：强制转压缩/卸载，绝不放行执行。
  const canCompress = args.canCompress !== false;
  return {
    allow: false,
    action: canCompress ? ACTIONS.COMPRESS : ACTIONS.OFFLOAD,
    ratio,
    ceil,
    reason: `投影占用 ${(ratio * 100).toFixed(1)}% 越过 ${(BUDGET_CEIL_RATIO * 100)}% 上限，`
      + `强制转${canCompress ? '压缩' : '卸载'}流（§3.4 下溢出拦截）。`,
  };
}

// 截断 / 上下文超限错误的特征（多家网关措辞）。
const TRUNCATION_PATTERNS = [
  /context[_\s-]?length/i,
  /maximum\s+context/i,
  /token.*(exceed|limit)/i,
  /(exceed|over).*token/i,
  /truncat/i,
  /too\s+many\s+tokens/i,
  /reduce\s+the\s+length/i,
  /上下文.*(超|溢|限)/,
  /截断/,
];

/** 判定一个错误是否属于「上下文截断 / 超限」。 */
function isTruncationError(err) {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : (err.message || err.error || err.code || '');
  const text = String(msg);
  if (/context_length_exceeded|max_tokens|ECONTEXT/i.test(text)) return true;
  return TRUNCATION_PATTERNS.some((re) => re.test(text));
}

/**
 * 防呆④：截断异常 → 紧急快照。从残存上下文抽取，强制落盘，绝不丢进度。
 * 依赖注入 snapshotManager + compressionEngine（默认取本子系统实现），便于测试与解耦。
 *
 * @param {object} residual { taskId, ultimateGoal, step, steps, nextInstruction, retryCount, offloadPointers }
 * @param {object} [deps]   { snapshotManager, compressionEngine }
 * @returns {{ok:boolean, snapshot?:object, file?:string, error?:string}}
 */
function emergencySnapshot(residual = {}, deps = {}) {
  try {
    const snap = deps.snapshotManager || require('./snapshotManager');
    const comp = deps.compressionEngine || require('./compressionEngine');
    // 截断时一律按最严级压缩残存历史，先保命再说。
    const compressed = comp.compressHistory(residual.steps || [], { usageRatio: 1 });
    const snapshot = snap.build({
      taskId: residual.taskId,
      ultimateGoal: residual.ultimateGoal,
      step: residual.step,
      compressedHistory: compressed.history,
      nextInstruction: residual.nextInstruction || '[紧急熔断] 从最近一步的断点继续推进终极目标。',
      offloadPointers: residual.offloadPointers || [],
      retryCount: residual.retryCount,
      entities: compressed.entities,
      lessons: compressed.lessons,
      status: snap.STATUS.EMERGENCY,
    });
    const res = snap.persist(snapshot);
    return res.ok ? { ok: true, snapshot, file: res.file } : { ok: false, error: res.error };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  BUDGET_CEIL_RATIO,
  ACTIONS,
  requireBudgetPlan,
  preflight,
  isTruncationError,
  emergencySnapshot,
};
