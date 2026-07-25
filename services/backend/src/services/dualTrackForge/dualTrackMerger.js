'use strict';

/**
 * dualTrackMerger.js — 双轨需求熔铸合并器（§3.4）。
 *
 * 把「确定性保底」与「模型增益」两轨的发现熔铸成一份最终 EvoRequirement，并**必须强制**标明
 * `source_track`，使进化历史清晰可查——哪些是客观铁律（Deterministic），哪些是模型猜想
 * （Assisted），哪些是两者合流（Dual-Track）。
 *
 * 合并规则：
 *   - 保底轨永远是地基（合法 EvoRequirement，权威 executionLevel）。
 *   - 有合格增益（已过置信度阈值）→ source_track = Dual-Track：挂上 assisted_hypothesis、
 *     拼接 merged_action（[保底] + [增益]），按置信度抬升优先级。
 *   - 增益若附带合规 l2Plan（架构对比 + 爆炸半径），允许把需求**建议**升至 L2——但仍走
 *     `evoRequirement.forge` → `evoLevels.planL2` 强制降级 L0 + 3 步验证（防呆②）。模型能
 *     提议架构级修正，但绝不能凭猜想直接重写核心。
 *   - 无保底、仅有软逻辑增益 → `fromAssisted` 铸造纯 Assisted 轨需求。
 *
 * `source_track` 取值固定 'Deterministic' | 'Assisted' | 'Dual-Track'，永不为空（防呆④）。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const evoLevels = require('../evoEngine/evoLevels');

const SOURCE_TRACK = Object.freeze({
  DETERMINISTIC: 'Deterministic',
  ASSISTED: 'Assisted',
  DUAL_TRACK: 'Dual-Track',
});

const HIGH_CONFIDENCE = 0.8;

class DualTrackRequirementMerger {
  constructor(opts = {}) {
    this.threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.6;
  }

  /**
   * 合并保底轨 + （可选）增益轨。
   * @param {object} backstop  DeterministicElevator.elevate 的产物（含 requirement/finding/action/code/priority）
   * @param {object|null} assisted  LogicalSelfAssessor.assess 的产物（已过阈值）或 null
   * @returns {object} 最终双轨需求（标 source_track）
   */
  merge(backstop, assisted) {
    if (!backstop || !backstop.requirement) {
      throw new Error('DualTrackMerger.merge: 缺少保底轨 backstop（确定性轨不可为空）');
    }
    const hasGain = !!(assisted && Number.isFinite(assisted.confidence) && assisted.confidence >= this.threshold);

    let requirement = backstop.requirement;
    let escalatedToL2 = false;

    // 增益带合规 l2Plan → 建议升 L2（受 planL2 强制降级闸门约束）。
    if (hasGain && assisted.l2Plan && evoLevels.planL2(assisted.l2Plan).valid) {
      const surface = backstop.requirement.attribution.surface;
      const reforged = evoRequirement.forge({
        signal: backstop.requirement.signal,
        painPoint: backstop.requirement.painPoint,
        attribution: {
          kind: 'assisted-architecture',
          // 含 classify 的 L2 触发词「核心流转」，配合合规 l2Plan 升 L2。
          why: `${assisted.root_cause_hypothesis}——触及核心流转架构，需宪法级修正（模型增益假设，置信度 ${assisted.confidence}）。`,
          surface,
        },
        impact: backstop.requirement.impact,
        proposedModules: backstop.requirement.proposedModules,
        acceptanceCriteria: backstop.requirement.acceptanceCriteria,
        l2Plan: assisted.l2Plan,
      });
      requirement = reforged;
      escalatedToL2 = reforged.level === evoLevels.LEVELS.L2;
    }

    const source_track = hasGain ? SOURCE_TRACK.DUAL_TRACK : SOURCE_TRACK.DETERMINISTIC;
    const merged_action = [`[保底] ${backstop.action}`];
    if (hasGain) merged_action.push(`[增益] ${assisted.suggested_evo_requirement}`);

    return {
      requirementId: requirement.id,
      title: this._title(backstop, hasGain ? assisted : null),
      source_track,
      deterministic_finding: backstop.finding,
      assisted_hypothesis: hasGain ? `${assisted.root_cause_hypothesis} (置信度: ${assisted.confidence})` : null,
      merged_action,
      priority: this._priority(backstop, hasGain ? assisted : null, escalatedToL2),
      confidence: hasGain ? assisted.confidence : null,
      escalatedToL2,
      requirement,
    };
  }

  /**
   * 无物理硬伤、仅模型捕获软逻辑异常 → 纯 Assisted 轨需求。
   * @param {object} assisted  已过阈值的增益假设
   * @param {object} [observation] 现场（取 surface）
   * @returns {object} 纯 Assisted 轨需求
   */
  fromAssisted(assisted, observation = {}) {
    if (!assisted || !assisted.suggested_evo_requirement) {
      throw new Error('DualTrackMerger.fromAssisted: 缺少合格增益假设');
    }
    const surface = String(observation.surface || (observation.context && observation.context.tool) || 'runtime').slice(0, 300);
    const requirement = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.TOOL_FAILURE,
      painPoint: `软性逻辑异常：${assisted.root_cause_hypothesis}`.slice(0, 300),
      attribution: {
        kind: 'assisted-logic',
        why: `${assisted.root_cause_hypothesis}（模型自省增益假设，置信度 ${assisted.confidence}）。`,
        surface,
      },
      impact: '软性逻辑异常：物理断言未捕获，由模型自省捕捉，需评估跨场景复现。',
      proposedModules: [],
      acceptanceCriteria: [`验证 ${assisted.suggested_evo_requirement} 后该逻辑达标`],
      l2Plan: assisted.l2Plan,
    });
    return {
      requirementId: requirement.id,
      title: `[增益] ${String(assisted.suggested_evo_requirement).slice(0, 80)}`,
      source_track: SOURCE_TRACK.ASSISTED,
      deterministic_finding: null,
      assisted_hypothesis: `${assisted.root_cause_hypothesis} (置信度: ${assisted.confidence})`,
      merged_action: [`[增益] ${assisted.suggested_evo_requirement}`],
      priority: assisted.confidence >= HIGH_CONFIDENCE ? 'High' : 'Medium',
      confidence: assisted.confidence,
      escalatedToL2: requirement.level === evoLevels.LEVELS.L2,
      requirement,
    };
  }

  _title(backstop, assisted) {
    const base = backstop.action;
    return assisted ? `${base}（+模型增益）` : base;
  }

  _priority(backstop, assisted, escalatedToL2) {
    if (escalatedToL2) return 'High';
    if (backstop.priority === 'High') return 'High';
    if (assisted && assisted.confidence >= HIGH_CONFIDENCE) return 'High';
    return backstop.priority || 'Medium';
  }
}

module.exports = { DualTrackRequirementMerger, SOURCE_TRACK, HIGH_CONFIDENCE };
