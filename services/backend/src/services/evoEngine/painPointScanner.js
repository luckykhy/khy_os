'use strict';

/**
 * painPointScanner.js — 内源需求发生器 / 元认知刺探（§3.1）。
 *
 * 不依赖外部输入：Khyos 在运行态遭遇**阻力**时，本扫描器把「阻力」翻译成「需求」。
 * 四类阻力信号（§3.1 阻力信号捕获）：
 *   - 拦截器阻断        interceptor-block
 *   - 工具调用失败      tool-failure
 *   - 压缩提取丢失核义  compression-loss
 *   - 上下文频繁熔断    context-meltdown
 *
 * 归因（§3.1 元认知归因）：复用 selfHeal 的 `ErrorDiagnostician`（三源合一：failsafe 标准码
 * + resilience 失败原因 + 诊断字典病因），绝不臆造——再把诊断翻译成「Why」：是缺工具？是
 * 规则误杀？是阈值僵化？最后交 `evoRequirement.forge` 铸造严格需求规格。
 *
 * 纯逻辑 + 可注入 diagnostician，便于测试。扫描器只产出 EvoRequirement，**不**生成代码、
 * 不碰沙箱、不动宿主——是自举链路的「感知端」。
 */

const evoRequirement = require('./evoRequirement');
const { SIGNALS } = evoRequirement;

let _ErrorDiagnostician = null;
function _defaultDiagnostician() {
  if (_ErrorDiagnostician === undefined) return null;
  if (_ErrorDiagnostician) return _ErrorDiagnostician;
  try {
    const { ErrorDiagnostician } = require('../selfHeal/errorDiagnostician');
    _ErrorDiagnostician = new ErrorDiagnostician();
  } catch { _ErrorDiagnostician = undefined; return null; }
  return _ErrorDiagnostician;
}

// 把诊断/信号翻译成「Why」三类根因（§3.1：缺工具 / 规则误杀 / 阈值僵化）。
const WHY_KIND = Object.freeze({
  MISSING_TOOL: 'missing-tool',       // 能力空洞：缺工具/解析器
  RULE_MISFIRE: 'rule-misfire',       // 规则误杀：拦截器/守卫错误阻断
  THRESHOLD_RIGID: 'threshold-rigid', // 阈值僵化：压缩/上下文阈值不适应
  LOGIC_GAP: 'logic-gap',             // 逻辑死角：核心流转缺陷
});

/**
 * 由信号类型 + 诊断推断 Why 根因。确定性映射，给模型元认知一个可解释的起点。
 */
function _attributeWhy(signal, dx) {
  const text = `${dx ? dx.cause : ''} ${dx ? dx.detail : ''}`.toLowerCase();
  switch (signal) {
    case SIGNALS.INTERCEPTOR_BLOCK:
      return {
        kind: WHY_KIND.RULE_MISFIRE,
        why: `拦截器/守卫阻断了本应放行的操作——疑似规则误杀。诊断病因：${(dx && dx.cause) || '未归类阻断'}。`,
      };
    case SIGNALS.COMPRESSION_LOSS:
      return {
        kind: WHY_KIND.THRESHOLD_RIGID,
        why: `压缩提取丢失了核心语义——疑似压缩阈值/级别选择僵化，未能在该上下文保住核义。`,
      };
    case SIGNALS.CONTEXT_MELTDOWN:
      return {
        kind: WHY_KIND.THRESHOLD_RIGID,
        why: `上下文频繁熔断——疑似窗口/预算阈值僵化，未随任务形态自适应。`,
      };
    case SIGNALS.TOOL_FAILURE:
    default:
      if (/cannot find module|missing|不支持|无法处理|unsupported|no parser|未覆盖/.test(text)) {
        return {
          kind: WHY_KIND.MISSING_TOOL,
          why: `工具/解析器无法处理当前输入——能力拓扑存在空洞，缺少对应器官。诊断病因：${(dx && dx.cause) || '能力缺失'}。`,
        };
      }
      return {
        kind: WHY_KIND.LOGIC_GAP,
        why: `工具调用失败且非已知可修复类——疑似核心流转逻辑死角。诊断病因：${(dx && dx.cause) || '未归类失败'}。`,
      };
  }
}

class PainPointScanner {
  /**
   * @param {object} [opts]
   * @param {object} [opts.diagnostician]  selfHeal ErrorDiagnostician（默认内置）
   */
  constructor(opts = {}) {
    this.diagnostician = opts.diagnostician || _defaultDiagnostician();
  }

  /**
   * 刺探一次阻力，产出 EvoRequirement（或 null 当信号无意义）。
   *
   * @param {object} friction
   * @param {string} friction.signal       SIGNALS.*（默认 tool-failure）
   * @param {Error|object|string} [friction.error]  原始阻力错误（喂给 diagnostician 归因）
   * @param {string} [friction.surface]    阻力发生面（工具名/模块/路径），用于签名与定位
   * @param {string} [friction.painPoint]  人读痛点（缺省由归因合成）
   * @param {object} [friction.context]    诊断上下文 { tool, path, model, ... }
   * @param {object} [friction.l2Plan]     若预判 L2，附 { architectureDiff, blastRadius }
   * @returns {object|null} EvoRequirement
   */
  scan(friction = {}) {
    const signal = friction.signal || SIGNALS.TOOL_FAILURE;
    let dx = null;
    if (this.diagnostician && friction.error != null) {
      try { dx = this.diagnostician.diagnose(friction.error, friction.context || {}); } catch { dx = null; }
    }

    const attribution = _attributeWhy(signal, dx);
    attribution.surface = String(friction.surface || (friction.context && friction.context.tool) || '').slice(0, 300);

    const painPoint = friction.painPoint
      || (dx && dx.cause ? `${attribution.surface || '运行态'}：${dx.cause}` : `${attribution.surface || '运行态'} 遭遇阻力`);

    // 影响面：有诊断风险级时据其粗评；否则按信号给保守评估。
    const impact = friction.impact || this._estimateImpact(signal, dx);

    return evoRequirement.forge({
      signal,
      painPoint,
      attribution,
      impact,
      proposedModules: friction.proposedModules,
      acceptanceCriteria: friction.acceptanceCriteria,
      l2Plan: friction.l2Plan,
    });
  }

  _estimateImpact(signal, dx) {
    if (dx && dx.risk === 'L2') return '高：触及不可本地修复的系统性风险，可能波及核心流转。';
    if (signal === SIGNALS.CONTEXT_MELTDOWN || signal === SIGNALS.COMPRESSION_LOSS) {
      return '中：影响长链路任务的记忆完整性与续航，跨任务复现。';
    }
    if (signal === SIGNALS.INTERCEPTOR_BLOCK) {
      return '中：误杀阻断正常任务推进，规则面波及所有同类操作。';
    }
    return '低-中：当前任务受阻，需评估是否跨场景复现。';
  }
}

module.exports = { PainPointScanner, WHY_KIND };
