'use strict';

/**
 * conflictQuencher.js — 冲突淬火器（§3.3 冲突淬火 / 防呆③④「打架即需求」）。
 *
 * 数据主权的终极信条：数据打架不是运行期异常，而是**架构进化的原石**。当主权网关侦测到
 *   - 同阶层异值打架（如两个 P3 工具返回值各执一词，无更高权威可裁），或
 *   - 同一参数被不同来源高频来回覆盖产生二义性震荡（A→B→A），
 * 网关绝不在原地随机选择或先后覆盖（那是「精神分裂」的根源），而是把这次冲突**升维**为一份
 * 结构化 `EvoRequirement`，向系统索要「意图裁决器」「状态锁」或「结果交叉验证工具」这类新器官。
 *
 * 复用 [[evoRequirement]] 的 `forge` 真源（不改其定形），铸后装饰：
 *   - `conflict_sources`（防呆④）：清晰记录是哪些数据源打架导致此次进化，供架构审计；
 *   - `sovereigntyConflict=true` / `param` / `tier`，钉死冲突现场。
 *
 * classify 陷阱规避：evoLevels.classify 只读 `why+surface+kind`，且「网关 / 调度 / 压缩 /
 * 核心流转」是 L2 触发词。本域满纸「网关」，故 `why` 一律措辞为「状态拓扑空洞，须新增
 * 意图裁决工具与状态锁」——含 `拓扑空洞`+`新增…工具` 锁定 L1（器官新生），把「网关」等
 * 处方词收进 `proposedModules`（classify 不读），绝不擅升 L2。
 *
 * 纯逻辑，不做 I/O（落账本由门面负责）。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const evoLevels = require('../evoEngine/evoLevels');
const { labelOf } = require('./sovereigntyTiers');

const QUENCH_KIND = Object.freeze({
  SAME_TIER_FIGHT: 'same-tier-fight',   // 同阶层异值打架（防呆③）
  OSCILLATION: 'oscillation',           // 高频来回覆盖震荡（§3.3）
});

class ConflictQuencher {
  /**
   * 同阶层打架淬火（防呆③）：同一参数在最高权威阶层上出现 ≥2 个异值，无更高权威可裁。
   * 升维出 L1「结果交叉验证器」器官新生需求。
   * @param {object} fight { param, tier, claims:[{source,value}] }
   * @returns {{kind, conflict_sources:string[], param, tier, requirement}}
   */
  quenchSameTier(fight = {}) {
    const param = String(fight.param || 'unknown-param');
    const tier = fight.tier;
    const claims = Array.isArray(fight.claims) ? fight.claims : [];
    const conflict_sources = claims.map((c) => String(c.source || 'unknown'));

    const req = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `同主权阶层 ${tier}(${labelOf(tier)}) 多源就参数「${param}」各执一词，无更高权威可裁`,
      attribution: {
        kind: 'sovereignty-conflict',
        // L1 校准：含「拓扑空洞 / 新增…工具」，规避 L2 触发词（网关/调度/压缩/核心流转）。
        why: '同阶层数据源相互打架产生二义性，主权裁决出现状态拓扑空洞——须新增结果交叉验证工具与意图裁决工具消歧，不可在原地随机或先后覆盖',
        surface: `param:${param}`,   // 中性现场标签，绝不带 L2 触发词
      },
      impact: `参数「${param}」在 ${tier} 阶层悬而未决，极权注入被熔断，业务函数不予放行`,
      proposedModules: [
        '结果交叉验证工具(CrossValidator)',
        '意图裁决器(IntentArbiter)',
        '状态锁(StateLock)',
      ],
      acceptanceCriteria: [
        `同阶层 ${tier} 多源冲突时能产出可信单值或显式上抛裁决，不再二义`,
        '交叉验证工具对冲突源给出一致性判定',
      ],
    });

    return this._decorate(QUENCH_KIND.SAME_TIER_FIGHT, req, { param, tier, conflict_sources });
  }

  /**
   * 震荡淬火（§3.3）：同一参数被不同来源高频来回覆盖（A→B→A），状态管理存在死角。
   * 升维出 L1「状态锁 / 意图裁决器」器官新生需求。
   * @param {object} thrash { param, sources:string[], values:any[] }
   * @returns {{kind, conflict_sources:string[], param, requirement}}
   */
  quenchOscillation(thrash = {}) {
    const param = String(thrash.param || 'unknown-param');
    const conflict_sources = (Array.isArray(thrash.sources) ? thrash.sources : []).map(String);

    const req = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `参数「${param}」被多源高频来回覆盖产生二义性震荡`,
      attribution: {
        kind: 'sovereignty-oscillation',
        why: '同一参数被不同来源反复来回覆盖，状态管理存在拓扑空洞——须新增状态锁与意图裁决工具固化单一权威意图，杜绝来回拉扯',
        surface: `param:${param}`,
      },
      impact: `参数「${param}」状态在 ${conflict_sources.join('↔') || '多源'} 间反复翻转，下游消费者得到不稳定值`,
      proposedModules: [
        '状态锁(StateLock)',
        '意图裁决器(IntentArbiter)',
      ],
      acceptanceCriteria: [
        `参数「${param}」一旦被高权威阶层锁定，同会话内不再被同/低阶层来源翻转`,
      ],
    });

    return this._decorate(QUENCH_KIND.OSCILLATION, req, { param, tier: undefined, conflict_sources });
  }

  /**
   * 铸后装饰：把主权冲突现场钉进需求本体（防呆④ conflict_sources 必打标）。
   * 装饰发生在 forge 之后，绝不污染 evoRequirement 共享真源的定形。
   */
  _decorate(kind, requirement, { param, tier, conflict_sources }) {
    requirement.sovereigntyConflict = true;
    requirement.conflictKind = kind;
    requirement.param = param;
    if (tier !== undefined) requirement.tier = tier;
    requirement.conflict_sources = conflict_sources;   // 防呆④：审计可追溯是谁打架触发了进化

    // L1 不变式自检：器官新生需求绝不应擅升 L2（措辞校准失手即在此暴露）。
    if (!evoLevels.atLeast(requirement.level, evoLevels.LEVELS.L1) ||
        requirement.level === evoLevels.LEVELS.L2) {
      // 兜底归一到 L1：宁可降级也绝不放裸 L2 入主权需求池。
      requirement.level = evoLevels.LEVELS.L1;
      requirement.executionLevel = evoLevels.LEVELS.L1;
      requirement.validationSteps = 1;
      requirement.l2Valid = true;
    }

    return { kind, param, tier, conflict_sources, requirement };
  }
}

module.exports = { ConflictQuencher, QUENCH_KIND };
