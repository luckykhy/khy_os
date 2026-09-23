'use strict';

/**
 * resilience/budgetAdapters.js — 预算适配器（可注入任意预算源，统一 snapshot() 契约）。
 *
 * snapshot() → { totalUnits, remainingUnits, remainingPct }
 *
 * 纯叶子：零 back-edge 回 budgetExecutor，只依赖 fallbackTree 的硬上限常量。
 * 从 budgetExecutor.js 行为保真抽出（两者仍是 budgetExecutor 公共面导出，逐字节不变）。
 */

const { MAX_FALLBACK_DEPTH } = require('./fallbackTree');

/**
 * 步数预算：把"还能开几个 Plan/几步"当作预算。
 *
 * 语义铁律（对抗式训练 DESIGN-ARCH-055 加固）：**显式数字一律照单全收**（向下取整、夹到 ≥0），
 * 只有「压根没给可解析的数字」（undefined / NaN / 非数）才回落到缺省总额 = 树最大深度。
 * 旧实现用 `Number(totalSteps) || MAX` 做缺省回落，因 0 是 falsy，把**显式枯竭预算 0 静默
 * 当成了缺省 3 步**——调用方声明「已无预算」却仍被烧掉 3 个 Plan，预算地板形同虚设。此乃对抗
 * 红队逼出的真实破口，现按「显式 0 = 真枯竭，立即触发地板熔断」修正。
 */
function makeStepBudget(totalSteps) {
  const n = Number(totalSteps);
  const total = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : MAX_FALLBACK_DEPTH;
  let used = 0;
  return {
    spendOne() {
      used += 1;
    },
    snapshot() {
      const remainingUnits = Math.max(0, total - used);
      return {
        totalUnits: total,
        remainingUnits,
        // total===0（显式枯竭）→ 剩余 0%，地板闸门立即熔断，绝不空转烧 Plan。
        remainingPct: total > 0 ? Math.round((remainingUnits / total) * 100) : 0,
      };
    },
  };
}

/**
 * Token 预算适配器：包裹一个 { total, spent() } 用量源（如 usageTracker / IterationBudget）。
 * spendOne 是 no-op —— Token 由外部真实消耗驱动，本适配器只读快照。
 */
function makeTokenBudget(source = {}) {
  const total = Number(source.total) || 0;
  const spentFn = typeof source.spent === 'function' ? source.spent : () => 0;
  return {
    spendOne() {
      /* token 消耗由外部真实账本驱动，这里不自增 */
    },
    snapshot() {
      const spent = Number(spentFn()) || 0;
      const remainingUnits = Math.max(0, total - spent);
      return {
        totalUnits: total,
        remainingUnits,
        remainingPct: total > 0 ? Math.round((remainingUnits / total) * 100) : 100,
      };
    },
  };
}

module.exports = {
  makeStepBudget,
  makeTokenBudget,
};
