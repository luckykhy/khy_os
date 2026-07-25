'use strict';

/**
 * provenanceClassifier.js — 入站溯源分类器（DESIGN-ARCH-047 §3 PHASE 1）。
 *
 * 在「上游响应被解析成 Khyos 规范结构」的入站边界处调用，依据 adapter / provider /
 * serviceType / direct 等信号判定该内容的 producer 与初始 trust。结果以只读元数据
 * `__provenance` 随响应对象旅行，**绝不写入模型可见内容**。
 *
 * 纯函数：同输入同输出，无 IO、无副作用。
 */

const { PRODUCER, TRUST } = require('./khyTrace');

// adapter / provider 标识 → producer 的固定映射（allow-list，单一真源）。
// key 为小写子串，匹配采用「包含」语义以兼容形如 'relay_api'、'codex-direct' 的命名。
const _PRODUCER_HINTS = Object.freeze([
  { match: 'claude-code', producer: PRODUCER.CLAUDE_CODE },
  { match: 'claudecode', producer: PRODUCER.CLAUDE_CODE },
  { match: 'codex', producer: PRODUCER.CODEX },
  { match: 'relay', producer: PRODUCER.RELAY },
]);

function _firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 依信号判 producer。原生 / 未识别 → KHY_LOCAL（fail-safe-to-ours）。
 * @param {object} signals { adapter, provider, serviceType, direct, endpoint, model }
 * @returns {{producer:string, producerId:(string|null)}}
 */
function classifyProducer(signals = {}) {
  const hay = _firstString(
    signals.adapter, signals.provider, signals.serviceType,
  ).toLowerCase();
  const serviceType = String(signals.serviceType || '').toLowerCase();

  for (const hint of _PRODUCER_HINTS) {
    if (hay.includes(hint.match) || serviceType.includes(hint.match)) {
      // relay 携带 producerId 以区分具体上游（endpoint/model/provider）。
      const producerId = hint.producer === PRODUCER.RELAY
        ? (_firstString(signals.endpoint, signals.model, signals.provider) || null)
        : null;
      return { producer: hint.producer, producerId };
    }
  }
  return { producer: PRODUCER.KHY_LOCAL, producerId: null };
}

/**
 * 完整分类：返回可直接喂给 khyTrace.stamp 的 __provenance 元数据。
 * trust 初值：非 KHY 的正文/thinking → CLAIMED；KHY_LOCAL → VERIFIED。
 * （TOOL_RESULT 恒由本地重跑产出 → 由消费方按 kind 标 VERIFIED；TOOL_CALL 由 P3 定案。）
 * @param {object} signals 见 classifyProducer
 * @returns {{producer:string, producerId:(string|null), trust:string}}
 */
function classify(signals = {}) {
  const { producer, producerId } = classifyProducer(signals);
  const trust = producer === PRODUCER.KHY_LOCAL ? TRUST.VERIFIED : TRUST.CLAIMED;
  return { producer, producerId, trust };
}

module.exports = {
  classify,
  classifyProducer,
};
