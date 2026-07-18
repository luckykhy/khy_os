'use strict';

/**
 * misjudgmentQuencher.js — 误判淬火器（§3.4 / 防呆③「漏判与误触皆需求」）。
 *
 * 把用户的「纠正行为」视为最高优先级的进化信号：意图裁决一旦误触或漏判，绝不止于一次道歉，
 * 而是定向淬火出针对意图解析引擎的 `EvoRequirement`：
 *
 *   误触（分类器过激进）：用户「我没让你执行 / 只是在聊天」
 *        → L0 启发式补丁：增加负样本、下调相关特征提权权重。
 *   漏判（分类器过保守）：用户「我刚才说了 / 为什么没反应 / 快执行」
 *        → L1 器官新生：扩充特权动词库、新增语义框架解析工具。
 *
 * 复用 [[evoRequirement]] 的 `forge` 真源（不改其定形），铸后装饰 misjudgmentKind/targetFeature。
 * classify 陷阱：误触 why 措辞「调权重/负样本」落 L0；漏判 why 含「拓扑空洞/新增…工具」落 L1；
 * 两者皆规避「网关/调度/压缩/核心流转」L2 触发词。
 *
 * 纯逻辑，不做 I/O（落账本由门面负责）。
 */

const evoRequirement = require('../evoEngine/evoRequirement');
const evoLevels = require('../evoEngine/evoLevels');
const L = require('./intentLexicon');

const MISJUDGMENT_KIND = Object.freeze({
  FALSE_TRIGGER: 'false-trigger',   // 误触：过激进
  MISS: 'miss',                     // 漏判：过保守
});

class MisjudgmentQuencher {
  /**
   * 从用户纠正文本判别误判类型（防呆③）。
   * @param {string} text
   * @returns {string|null} MISJUDGMENT_KIND.* 或 null（非纠正信号）
   */
  classifySignal(text) {
    const t = String(text || '');
    if (L._hits(t, L.FALSE_TRIGGER_SIGNALS).length) return MISJUDGMENT_KIND.FALSE_TRIGGER;
    if (L._hits(t, L.MISS_SIGNALS).length) return MISJUDGMENT_KIND.MISS;
    return null;
  }

  /**
   * 捕获纠正信号 → 定向进化需求。非纠正信号返回 null（不淬火）。
   * @param {string} correctionText  用户纠正话语
   * @param {object} [context] { originalText, confidence, band }
   * @returns {{kind, misjudgmentKind, targetFeature, requirement}|null}
   */
  quench(correctionText, context = {}) {
    const kind = this.classifySignal(correctionText);
    if (!kind) return null;
    return kind === MISJUDGMENT_KIND.FALSE_TRIGGER
      ? this._quenchFalseTrigger(correctionText, context)
      : this._quenchMiss(correctionText, context);
  }

  /** 误触淬火：分类器过激进 → L0 调权重/加负样本。 */
  _quenchFalseTrigger(text, ctx) {
    const orig = String(ctx.originalText || '');
    const req = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `闲聊「${orig.slice(0, 40)}」被误判为指令并触发系统模式`,
      attribution: {
        kind: 'intent-false-trigger',
        // L0 校准：调权重/加负样本属启发式补丁，规避 L1（拓扑空洞/新工具）与 L2 触发词。
        why: '意图分类器过于激进，把闲聊误升为指令——须增加负样本并下调相关特征的提权权重，收紧提权阈值',
        surface: `intent-input`,
      },
      impact: `误触系统模式，用户被迫纠正；置信度=${ctx.confidence ?? '?'} 偏高`,
      proposedModules: ['意图负样本集扩充', '提权特征权重下调'],
      acceptanceCriteria: [`同类闲聊输入「${orig.slice(0, 24)}」复算置信度落入安全对话带 [0,0.3)`],
    });
    return this._decorate(MISJUDGMENT_KIND.FALSE_TRIGGER, req, orig, '提权权重下调');
  }

  /** 漏判淬火：分类器过保守 → L1 扩充特权动词库/新解析工具。 */
  _quenchMiss(text, ctx) {
    const orig = String(ctx.originalText || '');
    const req = evoRequirement.forge({
      signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: `真实指令「${orig.slice(0, 40)}」被漏判，未能放行执行`,
      attribution: {
        kind: 'intent-miss',
        // L1 校准：含「拓扑空洞 + 新增…工具」，锁器官新生，规避 L2 触发词。
        why: '意图分类器过于保守，特权动词库存在拓扑空洞漏掉真实指令——须扩充特权动词库、新增语义框架解析工具补全识别能力',
        surface: `intent-input`,
      },
      impact: `漏判真实指令，用户重复追加；置信度=${ctx.confidence ?? '?'} 偏低`,
      proposedModules: ['特权动词库扩充', '语义框架解析工具(SemanticFrameParser)'],
      acceptanceCriteria: [`同类指令「${orig.slice(0, 24)}」复算置信度跨入执行带 [0.7,1.0]`],
    });
    return this._decorate(MISJUDGMENT_KIND.MISS, req, orig, '特权动词库扩充');
  }

  /** 铸后装饰：钉死误判类型与定向进化目标特征（便于审计「往哪进化」）。 */
  _decorate(misjudgmentKind, requirement, originalText, targetFeature) {
    requirement.intentMisjudgment = true;
    requirement.misjudgmentKind = misjudgmentKind;
    requirement.targetFeature = targetFeature;
    requirement.originalText = String(originalText || '').slice(0, 120);

    // L0/L1 不变式自检：误判进化绝不应擅升 L2（措辞失手即在此兜底归一）。
    if (requirement.level === evoLevels.LEVELS.L2) {
      requirement.level = evoLevels.LEVELS.L1;
      requirement.executionLevel = evoLevels.LEVELS.L1;
      requirement.validationSteps = 1;
      requirement.l2Valid = true;
    }
    return { kind: misjudgmentKind, misjudgmentKind, targetFeature, requirement };
  }
}

module.exports = { MisjudgmentQuencher, MISJUDGMENT_KIND };
