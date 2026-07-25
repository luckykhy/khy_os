'use strict';

/**
 * hardeningLoop.js — 破防 → 需求 的加固回路（DESIGN-ARCH-055 §5「收口」）。
 *
 * 对抗训练若只「打分」而不「沉淀」，就退化成一次性烟雾测试。本模块把每一条 survivalCriteria
 * 判出的 breach **收口**进 Khyos 既有的「从失败中学习」生态——破防即痛点，痛点即需求：
 *   - 主沉淀：evoEngine.frictionBridge.observeFailure —— 确定性、fail-soft、自带去重、落 evoLedger
 *     观测分支，供离线 evolve 消费。这是 Khyos 唯一既有的「运行态阻力 → 进化需求」通道，对抗
 *     破防是它最该收的一类阻力（真实、可复现、附完整归因）。
 *   - 选沉淀：dualTrackForge.forge —— 「一切 Bug 皆需求」的双轨淬火，可选注入（需映射到物理码
 *     或注入 brain），默认不挂，避免与主沉淀重复铸造。
 *
 * 铁律：
 *   - 永不抛、永不阻断战役：任何沉淀异常都折叠成 {observed:false, reason}，对抗循环继续。
 *   - 非破坏默认：沉淀**只在显式开启**时发生（campaign 的 harden 档）。纯评测/测试不写 ledger，
 *     借 KHY_DATA_HOME 隔离亦可。这避免「跑一次测试就刷爆进化需求池」。
 *   - 归因完整：每条 friction 必带 surface（定位）+ painPoint（人读痛点）+ signal（分级锚点），
 *     满足 evoRequirement「缺归因即抛」的硬契约——破防的灵魂正是「它怎么破的」。
 */

const { INVARIANTS } = require('./survivalCriteria');

/** 不变量 → evoRequirement.SIGNALS.* 的稳定映射（破防性质决定进化信号）。 */
const INVARIANT_SIGNAL = Object.freeze({
  [INVARIANTS.NO_THROW]: 'tool-failure', // 非预期异常逃逸 = 工具级失败
  [INVARIANTS.BOUNDED]: 'context-meltdown', // 失控/死循环 = 上下文熔断
  [INVARIANTS.NO_SILENT_FAILURE]: 'tool-failure', // 静默失败 = 交付失败
  [INVARIANTS.ALWAYS_SALVAGE]: 'tool-failure', // 躺平不兜底 = 交付失败
  [INVARIANTS.BUDGET_FLOOR_HONORED]: 'context-meltdown', // 越界燃烧 = 资源熔断
  [INVARIANTS.FORGERY_REJECTED]: 'interceptor-block', // 封印被绕过 = 拦截器失守
});

const DEFAULT_SIGNAL = 'tool-failure';

/**
 * 把一次评定（含其 observation）收口为进化需求。
 * 守住（survived）的不沉淀；破防的逐条沉淀，每条 breach 一份 friction。
 *
 * @param {object} evaluation  survivalCriteria.evaluate() 结果 { vectorId, target, survived, breaches }
 * @param {object} observation 对应 stressHarness 产出的 observation（提供 error/family 等佐证）
 * @param {object} [opts]
 * @param {object} [opts.bridge]   注入 frictionBridge（默认 require evoEngine/frictionBridge）；可注 mock
 * @param {object} [opts.forge]    可选 DualTrackForge 实例（注入即启用双轨淬火二次沉淀）
 * @returns {Promise<{vectorId:string, sank:number, requirements:Array}>}
 */
async function harden(evaluation, observation, opts = {}) {
  const out = { vectorId: (evaluation && evaluation.vectorId) || null, sank: 0, requirements: [] };
  if (!evaluation || evaluation.survived || !Array.isArray(evaluation.breaches) || !evaluation.breaches.length) {
    return out;
  }

  const bridge = opts.bridge || _safeRequire('../evoEngine/frictionBridge');
  const obs = observation || {};

  for (const breach of evaluation.breaches) {
    const friction = _toFriction(evaluation, obs, breach);
    let record = { observed: false, reason: 'bridge-unavailable', invariant: breach.invariant };
    if (bridge && typeof bridge.observeFailure === 'function') {
      try {
        const r = bridge.observeFailure(friction);
        record = { ...r, invariant: breach.invariant };
      } catch (e) {
        record = { observed: false, reason: 'observe-error', invariant: breach.invariant, error: String(e && e.message) };
      }
    }
    if (record.observed) out.sank += 1;
    out.requirements.push(record);

    // 选沉淀：双轨淬火（注入了 forge 才走，避免与主沉淀重复）。永不阻断主路。
    if (opts.forge && typeof opts.forge.forge === 'function') {
      try {
        const forged = await opts.forge.forge(_toForgeObservation(evaluation, obs, breach));
        if (forged && forged.status === 'forged') {
          record.forgedRequirementId = forged.requirementId || (forged.requirement && forged.requirement.id) || null;
          record.forgedTrack = forged.source_track || null;
        }
      } catch { /* 双轨淬火永不抛；真抛了也不许污染对抗战役 */ }
    }
  }
  return out;
}

/** breach → frictionBridge.observeFailure 入参。 */
function _toFriction(evaluation, obs, breach) {
  const target = evaluation.target || obs.target || 'unknown';
  const vectorId = evaluation.vectorId || obs.vectorId || 'unknown';
  const signal = INVARIANT_SIGNAL[breach.invariant] || DEFAULT_SIGNAL;
  return {
    signal,
    surface: `adversarial/${target}/${vectorId}`,
    painPoint: `对抗破防[${breach.invariant}]：${breach.detail}`,
    error: obs.error || { name: 'AdversarialBreach', message: breach.detail },
    context: {
      tool: 'adversarial-trainer',
      target,
      vectorId,
      family: obs.family || null,
      invariant: breach.invariant,
    },
  };
}

/** breach → DualTrackForge.forge 观测现场（仅在显式注入 forge 时构造）。 */
function _toForgeObservation(evaluation, obs, breach) {
  return {
    input: { vectorId: evaluation.vectorId, target: evaluation.target, invariant: breach.invariant },
    output: obs.outcome,
    goal: `守住不变量 ${breach.invariant}`,
    context: { source: 'adversarial-trainer', family: obs.family, detail: breach.detail },
  };
}

function _safeRequire(p) {
  try { return require(p); } catch { return null; }
}

module.exports = {
  harden,
  INVARIANT_SIGNAL,
  _toFriction, // 导出供测试
};
