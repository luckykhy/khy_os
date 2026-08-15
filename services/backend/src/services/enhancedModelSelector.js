'use strict';

/**
 * enhancedModelSelector —— 在既有 autoModelSelect 之上叠一层「专长匹配 + 成本效率 + UCB 探索」的排序。
 *
 * 为什么不直接改 autoModelSelect:
 *   它是**纯叶子**(零 IO、确定性),而本模块必须每请求读模型画像(文件 IO)。把 IO 塞进叶子会
 *   破掉它的契约和现有测试。所以这里做的是 *包壳*:tier/可用性过滤仍旧全权交给
 *   autoModelSelect.rankAutoModels(单一真源,不重写),本模块只在它给出的有序候选上重排。
 *
 * 打分(与任务书 Goal 3 一致):
 *   specialtyMatch  = styleMatchers.calculateSpecialtyMatch(画像, 任务)   // 0.2 基线 / +0.5 / −0.3
 *   costEfficiency  = capability_matrix.cost_efficiency / 5              // 0..1
 *   overallScore    = specialtyMatch × 0.6 + costEfficiency × 0.4
 *   blended         = ucbNormalized × 0.3 + overallScore × 0.7
 *
 * 关于 UCB 的诚实边界(必须知道):
 *   ucbRouter 的 arm 粒度是 **adapter**,不是 model —— 同一 adapter 下的所有模型共享一个
 *   探索/收益统计。所以 blended 里的 UCB 项表达的是「这个 *通道* 近期表现如何」,而不是
 *   「这个 *模型* 近期表现如何」。没有 adapter 的候选拿不到信号,按中性 0.5 处理
 *   (**不**按未拉过的 +Infinity 处理,否则一堆没有 adapter 的候选会靠"强制探索"直接屠榜)。
 *
 * 门控 KHY_ENHANCED_MODEL_SELECT(父门 KHY_MODEL_ADAPT,默认关)。关闭时**原样返回**
 * autoModelSelect.rankAutoModels 的结果 → 与改动前逐字节相同的行为。
 */

const styles = require('../utils/styleMatchers');

const autoModelSelect = require('./gateway/autoModelSelect');
const ucbRouter = require('./gateway/ucbRouter');
const modelFeatureRegistry = require('./modelFeatureRegistry');

const FLAG = 'KHY_ENHANCED_MODEL_SELECT';

const W_SPECIALTY = 0.6;
const W_COST = 0.4;
const W_UCB = 0.3;
const W_OVERALL = 0.7;

/** routing_priority 命中时的加/减分(在 overallScore 之后、混合之前施加)。 */
const BONUS_ALWAYS_PREFER = 0.35;
const BONUS_DEFAULT_CHOICE = 0.1;
const PENALTY_BUDGET_AVOID = 0.4;

function isEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 把 ucbRouter.rank 的原始 value 归一到 0..1。
 *
 * +Infinity(从未拉过的 arm,UCB1 的强制首试)→ 1.0:保留"新通道优先试一次"的语义。
 * 有限值做 min-max;全部相等(常见于刚启动)→ 一律 0.5,让 overallScore 说话。
 *
 * @param {Array<{adapter:string, value:number}>} ranked
 * @returns {Map<string, number>}
 */
function normalizeUcb(ranked) {
  const out = new Map();

  try {
    const rows = Array.isArray(ranked) ? ranked : [];
    const finite = rows.map((r) => Number(r && r.value)).filter((v) => Number.isFinite(v));
    const min = finite.length > 0 ? Math.min(...finite) : 0;
    const max = finite.length > 0 ? Math.max(...finite) : 0;
    const span = max - min;

    for (const row of rows) {
      const key = row && typeof row.adapter === 'string' ? row.adapter : '';

      if (!key) {
        continue;
      }

      const v = Number(row.value);

      if (!Number.isFinite(v)) {
        out.set(key, 1);
      } else if (span <= 0) {
        out.set(key, 0.5);
      } else {
        out.set(key, (v - min) / span);
      }
    }
  } catch {
    /* 拿不到 UCB 就退化成"没有探索项",由 overallScore 独自决定 */
  }

  return out;
}

/**
 * 专长匹配度(直接复用纯叶子里的实现,保持单一真源)。
 *
 * @param {object} profile
 * @param {string} taskType
 * @returns {number} 0..1
 */
function calculateSpecialtyMatch(profile, taskType) {
  return styles.calculateSpecialtyMatch(profile, taskType);
}

/**
 * 成本效率:capability_matrix.cost_efficiency(0-5)线性映射到 0..1。
 *
 * @param {object} profile
 * @returns {number} 0..1
 */
function calculateCostEfficiency(profile) {
  try {
    const caps = styles.isPlainObject(profile) ? profile.capability_matrix : null;

    return styles.clampInt(caps && caps.cost_efficiency, 0, 5, 3) / 5;
  } catch {
    return 0.6;
  }
}

/**
 * 按「专长 + 成本 + UCB」重排候选模型。
 *
 * @param {string} taskType
 * @param {Array} candidates 形状同 autoModelSelect.rankAutoModels
 * @param {{max?:number, preferTier?:string, budget?:'low'|'medium'|'high', env?:object,
 *   registry?:object, ucb?:object, cooldownByKey?:object}} [opts]
 * @returns {Array<object>} 失败/空 → []
 */
function rankEnhancedModels(taskType, candidates, opts = {}) {
  const o = styles.isPlainObject(opts) ? opts : {};
  const env = styles.isPlainObject(o.env) ? o.env : process.env;

  // 门控关 → 原样透传既有排序(零行为差异)。
  if (!isEnabled(env)) {
    return autoModelSelect.rankAutoModels(taskType, candidates, o);
  }

  try {
    // ① tier / 可用性过滤:全权交给既有叶子,不重写。
    const base = autoModelSelect.rankAutoModels(taskType, candidates, {
      preferTier: o.preferTier,
    });

    if (base.length === 0) {
      return [];
    }

    const registry = o.registry && typeof o.registry.get === 'function'
      ? o.registry
      : modelFeatureRegistry.getModelFeatureRegistry();
    const router = o.ucb && typeof o.ucb.rank === 'function' ? o.ucb : ucbRouter;
    const adapters = Array.from(new Set(base.map((e) => e.adapter).filter(Boolean)));
    let ucbMap = new Map();

    if (adapters.length > 0) {
      ucbMap = normalizeUcb(
        router.rank(adapters, { cooldownByKey: o.cooldownByKey, priorOrder: o.priorOrder })
      );
    }

    const budget = styles.pickEnum(o.budget, ['low', 'medium', 'high'], '');
    const task = String(taskType || '')
      .trim()
      .toLowerCase();

    // ② 逐候选打分。
    const scored = base.map((entry, idx) => {
      const profile = registry.get(entry.model, { taskType: task });
      const specialtyMatch = calculateSpecialtyMatch(profile, task);
      const costEfficiency = calculateCostEfficiency(profile);
      let overallScore = specialtyMatch * W_SPECIALTY + costEfficiency * W_COST;
      const routing = styles.isPlainObject(profile) ? profile.routing_priority : null;
      const always = styles.normalizeStringList(routing && routing.always_prefer_for);
      const preferred = styles.normalizeStringList(routing && routing.default_choice_for);
      const notes = [];

      if (task && always.includes(task)) {
        overallScore += BONUS_ALWAYS_PREFER;
        notes.push('always_prefer_for');
      } else if (task && preferred.includes(task)) {
        overallScore += BONUS_DEFAULT_CHOICE;
        notes.push('default_choice_for');
      }

      if (budget && routing && routing.avoid_when_budget_is === budget) {
        overallScore -= PENALTY_BUDGET_AVOID;
        notes.push(`avoid_when_budget_is:${budget}`);
      }

      overallScore = Math.min(1, Math.max(0, overallScore));

      // 没有 adapter → 没有通道级信号 → 中性 0.5(见文件头「诚实边界」)。
      const ucbNormalized = entry.adapter && ucbMap.has(entry.adapter)
        ? ucbMap.get(entry.adapter)
        : 0.5;
      const blended = ucbNormalized * W_UCB + overallScore * W_OVERALL;

      return {
        model: entry.model,
        adapter: entry.adapter,
        tier: entry.tier,
        status: entry.status,
        specialtyMatch: Number(specialtyMatch.toFixed(4)),
        costEfficiency: Number(costEfficiency.toFixed(4)),
        overallScore: Number(overallScore.toFixed(4)),
        ucbNormalized: Number(ucbNormalized.toFixed(4)),
        blended: Number(blended.toFixed(4)),
        confidence: profile.confidence,
        known: Boolean(profile._meta && profile._meta.known),
        notes,
        baseIndex: idx,
      };
    });

    // ③ 混合分降序;同分回落到既有排序的原下标(确定性)。
    scored.sort((a, b) => b.blended - a.blended || a.baseIndex - b.baseIndex);
    scored.forEach((row, i) => {
      row.rank = i;
    });

    const max = Number.isFinite(o.max) && o.max > 0 ? o.max | 0 : scored.length;

    return scored.slice(0, max);
  } catch {
    // 任何意外 → 退回既有排序,绝不让选型这一步失败。
    try {
      return autoModelSelect.rankAutoModels(taskType, candidates, o);
    } catch {
      return [];
    }
  }
}

/**
 * 取头名。绝不抛。
 *
 * @param {string} taskType
 * @param {Array} candidates
 * @param {object} [opts]
 * @returns {object|null}
 */
function pickEnhancedModel(taskType, candidates, opts = {}) {
  try {
    const ranked = rankEnhancedModels(taskType, candidates, opts);

    return ranked.length > 0 ? ranked[0] : null;
  } catch {
    return null;
  }
}

/**
 * 可读的排序解释(给 CLI / 监控 / 排障)。绝不抛。
 *
 * @param {string} taskType
 * @param {Array} candidates
 * @param {object} [opts]
 * @returns {string}
 */
function explainSelection(taskType, candidates, opts = {}) {
  try {
    const ranked = rankEnhancedModels(taskType, candidates, opts);

    if (ranked.length === 0) {
      return '(无可用候选)';
    }

    if (ranked[0].blended === undefined) {
      return `未启用增强选型,沿用既有排序:${ranked.map((r) => r.model).join(' > ')}`;
    }

    return ranked
      .map(
        (r) =>
          `${r.rank}. ${r.model} [${r.tier}] blended=${r.blended} ` +
          `(specialty=${r.specialtyMatch} cost=${r.costEfficiency} ucb=${r.ucbNormalized}` +
          `${r.notes.length ? ' ' + r.notes.join(',') : ''})`
      )
      .join('\n');
  } catch {
    return '';
  }
}

/** 自描述。 */
function describeEnhancedSelector() {
  return {
    gate: FLAG,
    defaultOn: false,
    weights: {
      specialty: W_SPECIALTY,
      cost: W_COST,
      ucb: W_UCB,
      overall: W_OVERALL,
    },
    ucbGranularity: 'adapter',
    summary:
      'tier/可用性过滤沿用 autoModelSelect;在其结果上按「专长匹配 ×0.6 + 成本效率 ×0.4」' +
      '算 overallScore,再与归一化后的 adapter 级 UCB 值按 0.3 / 0.7 混合重排。' +
      '门控关闭时原样返回既有排序。',
  };
}

module.exports = {
  BONUS_ALWAYS_PREFER,
  BONUS_DEFAULT_CHOICE,
  FLAG,
  PENALTY_BUDGET_AVOID,
  W_COST,
  W_OVERALL,
  W_SPECIALTY,
  W_UCB,
  calculateCostEfficiency,
  calculateSpecialtyMatch,
  describeEnhancedSelector,
  explainSelection,
  isEnabled,
  normalizeUcb,
  pickEnhancedModel,
  rankEnhancedModels,
};
