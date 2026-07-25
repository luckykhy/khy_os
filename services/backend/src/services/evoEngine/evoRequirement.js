'use strict';

/**
 * evoRequirement.js — 内源需求规格铸造（§3.1 需求规格铸造）。
 *
 * 把「阻力 + 元认知归因」凝固成一份严格的 `EvoRequirement`——这是自举链路里唯一被下游
 * （沙箱/热载/日志）消费的需求真源。朴素链路靠人类写 Issue；这里由系统在运行态自动产出。
 *
 * EvoRequirement 七要素：
 *   id                稳定需求 ID（确定性，由痛点签名派生，便于去重与熔断计数）
 *   painPoint         痛点描述（人读，一句话）
 *   signal            原始阻力信号类型（interceptor-block / tool-failure / compression-loss / context-meltdown）
 *   attribution       元认知归因 { kind, why, surface }——必须回答 Why（缺工具/规则误杀/阈值僵化）
 *   impact            影响面评估（人读）
 *   proposedModules   拟新增/修改模块（字符串数组）
 *   acceptanceCriteria 验收标准（字符串数组，沙箱差异校验据此判胜负）
 *   level             演进级（L0/L1/L2，来自 evoLevels.classify，L2 经 planL2 强制降级）
 *
 * 纯函数。ID 由痛点签名稳定派生（非时间戳），保证同一痛点反复出现得到同一 ID——这是
 * 「同一痛点连续 2 次沙箱失败即熔断该分支」（§3.4）的计数锚点。
 */

const crypto = require('crypto');
const evoLevels = require('./evoLevels');

const SIGNALS = Object.freeze({
  INTERCEPTOR_BLOCK: 'interceptor-block',   // 拦截器阻断
  TOOL_FAILURE: 'tool-failure',             // 工具调用失败
  COMPRESSION_LOSS: 'compression-loss',     // 压缩提取丢失核义
  CONTEXT_MELTDOWN: 'context-meltdown',     // 上下文频繁熔断
});

const _ALL_SIGNALS = new Set(Object.values(SIGNALS));

/** 痛点签名 → 稳定 ID（确定性，去重 + 熔断计数锚点）。 */
function signatureOf({ signal, surface, painPoint }) {
  const basis = [String(signal || ''), String(surface || ''), String(painPoint || '')]
    .join('|')
    .replace(/\d+/g, '#')       // 数字归一（行号/计数不应分裂签名）
    .toLowerCase()
    .slice(0, 400);
  return 'evo_' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/**
 * 铸造一份 EvoRequirement。缺归因（Why）即抛——「头痛医头」是被本架构废弃的反模式，
 * 归因是需求的灵魂。
 *
 * @param {object} input
 * @param {string} input.signal       SIGNALS.*
 * @param {string} input.painPoint    痛点一句话
 * @param {object} input.attribution  { kind, why, surface }（why 必填）
 * @param {string} [input.impact]
 * @param {string[]} [input.proposedModules]
 * @param {string[]} [input.acceptanceCriteria]
 * @param {object} [input.l2Plan]     L2 时的 { architectureDiff, blastRadius }
 * @returns {object} EvoRequirement（含 _l2 降级规划当 level==L2）
 */
function forge(input = {}) {
  const signal = _ALL_SIGNALS.has(input.signal) ? input.signal : SIGNALS.TOOL_FAILURE;
  const attribution = input.attribution || {};
  if (!attribution.why || !String(attribution.why).trim()) {
    throw new Error('EvoRequirement.forge: attribution.why 必填（元认知归因不可空——禁止头痛医头）');
  }
  const painPoint = String(input.painPoint || attribution.surface || '未命名痛点').slice(0, 300);
  const surface = String(attribution.surface || '').slice(0, 300);
  const id = signatureOf({ signal, surface, painPoint });

  const declaredLevel = evoLevels.classify({
    kind: attribution.kind, why: attribution.why, surface,
  });

  const req = {
    id,
    signature: id,
    painPoint,
    signal,
    attribution: {
      kind: String(attribution.kind || 'unknown'),
      why: String(attribution.why).slice(0, 500),
      surface,
    },
    impact: String(input.impact || '未评估').slice(0, 500),
    proposedModules: Array.isArray(input.proposedModules) ? input.proposedModules.map(String) : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
      ? input.acceptanceCriteria.map(String)
      : ['解决该痛点且不引入退化'],
    level: declaredLevel,
  };

  // 防呆②：L2 必须经 planL2 闸门——强制降级 + 验证步数；缺架构对比/爆炸半径即 invalid。
  if (declaredLevel === evoLevels.LEVELS.L2) {
    const l2 = evoLevels.planL2(input.l2Plan || {});
    req._l2 = l2;
    req.executionLevel = l2.executionLevel;     // 实际以 L0 执行
    req.validationSteps = l2.validationSteps;
    req.l2Valid = l2.valid;
  } else {
    req.executionLevel = declaredLevel;
    req.validationSteps = declaredLevel === evoLevels.LEVELS.L1 ? 1 : 0;
    req.l2Valid = true;
  }
  return req;
}

/** 校验一个对象是否是结构合法的 EvoRequirement。 */
function validate(req) {
  const missing = [];
  if (!req || typeof req !== 'object') return { valid: false, missing: ['<all>'] };
  if (!req.id) missing.push('id');
  if (!_ALL_SIGNALS.has(req.signal)) missing.push('signal');
  if (!req.attribution || !req.attribution.why) missing.push('attribution.why');
  if (!evoLevels.isLevel(req.level)) missing.push('level');
  if (req.level === evoLevels.LEVELS.L2 && req.l2Valid === false) missing.push('l2Plan(architectureDiff/blastRadius)');
  return { valid: missing.length === 0, missing };
}

module.exports = { SIGNALS, signatureOf, forge, validate };
