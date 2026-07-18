'use strict';

/**
 * chaosInterceptor.js — 混沌拦截器（DESIGN-ARCH-036 §3.1 / §4.3 强制实现项 ChaosInterceptor）。
 *
 * 「绝对前置拦截」的物理实现：任何外部自然语言在触达 Khyos 核心推理/业务逻辑之前，
 * 必须先穿过本拦截器被坍缩、校验、铸造为**封印信封 ForgeEnvelope**。未坍缩的原始字符串
 * 永远不应出现在业务代码里（违者视为致命级架构违规）。
 *
 * 管线（fail-closed，任一环出错都不放原文过去）：
 *   assess(熵/级别) → 路由 L0/L1/L2 坍缩器 → forgeSchema 校验 → anomalyHandler 裁决
 *   → 通过则盖**封印**产出 ForgeEnvelope；拒损则抛 FurnaceRejection。
 *
 * 封印（seal）= 对 payload 的内容寻址摘要 + 进程私有盐。业务侧用 assertForged(envelope)
 * 验封；伪造/裸 payload/被篡改一律抛错。这把“只能消费熔炉产物”从约定升级为可校验的硬边界。
 */

const crypto = require('crypto');
const { assess } = require('./entropyAssessor');
const dimensionReducer = require('./dimensionReducer');
const intentWeaver = require('./intentWeaver');
const skeletonReconstructor = require('./skeletonReconstructor');
const { EntityRegistry } = require('./entityRegistry');
const { TaskGraph } = require('./taskGraph');
const forgeSchema = require('./forgeSchema');
const anomalyHandler = require('./anomalyHandler');
const { FurnaceRejection } = anomalyHandler;

// 进程私有封印盐：不持久、不出进程，仅用于本进程内验封（防止业务代码手搓裸 payload 蒙混）。
const SEAL_SALT = crypto.randomBytes(16).toString('hex');
const SEAL_BRAND = Symbol.for('khyos.structuredFurnace.sealed');

function _seal(payload) {
  return crypto
    .createHmac('sha256', SEAL_SALT)
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * 拦截并坍缩一段外部自然语言。
 * @param {string} raw
 * @param {object} [opts]
 * @param {'L0'|'L1'|'L2'} [opts.forceLevel]  跳过熵评估，强制某级（测试/特例用）
 * @returns {object} ForgeEnvelope（已封印，不可变意图上限快照）
 * @throws {FurnaceRejection} 拒损（缺要素/死锁/多重矛盾）时抛出
 */
function intercept(raw, opts = {}) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) {
    throw new FurnaceRejection('空输入，无可坍缩要素', { kind: 'MISSING_ELEMENTS', missing: ['raw'] });
  }

  let assessment;
  let payload;
  let validation;
  let cycle = null;
  let contradictions = [];

  try {
    assessment = opts.forceLevel
      ? { level: opts.forceLevel, entropy: null, signals: null }
      : assess(text);

    const registry = new EntityRegistry();
    if (assessment.level === 'L0') {
      payload = dimensionReducer.reduce(text, registry);
      validation = forgeSchema.validateActionIntent(payload);
    } else if (assessment.level === 'L1') {
      payload = intentWeaver.weave(text, registry);
      validation = forgeSchema.validateTaskGraph(payload, { hadDependency: true });
      cycle = _detectCycle(payload);
    } else {
      payload = skeletonReconstructor.reconstruct(text, registry);
      validation = forgeSchema.validateStateMachine(payload);
      contradictions = payload.contradictions || [];
    }
  } catch (err) {
    // fail-closed：坍缩器内部任何意外都转为结构化拒损，绝不把原文泄回业务层。
    if (err instanceof FurnaceRejection) throw err;
    throw new FurnaceRejection(`熔炉坍缩内部异常：${err.message}`, {
      kind: 'MISSING_ELEMENTS',
      detail: { stage: assessment ? assessment.level : 'assess', cause: err.message },
    });
  }

  // 裁决：拒损会在此抛 FurnaceRejection；降级会返回打标后的 payload。
  const { verdict, payload: adjudicated } = anomalyHandler.adjudicate({
    payload,
    validation,
    cycle,
    contradictions,
    confidence: payload.confidence,
  });

  return _forge(adjudicated, {
    level: assessment.level,
    entropy: assessment.entropy,
    verdict,
    rawHash: crypto.createHash('sha1').update(text).digest('hex').slice(0, 12),
  });
}

/** 从 TaskGraph payload 重建图并检测环（死锁证据）。 */
function _detectCycle(payload) {
  const g = new TaskGraph();
  for (const n of payload.graph.nodes) g.addNode(n);
  for (const e of payload.graph.edges) {
    try { g.addEdge(e.from, e.to, e.type, e.condition || null); } catch { /* 悬空边交给 schema 报 */ }
  }
  return g.findCycle();
}

/** 盖封：产出不可绕过的 ForgeEnvelope。 */
function _forge(payload, meta) {
  const envelope = {
    [SEAL_BRAND]: true,
    sealed: true,
    seal: _seal(payload),
    level: meta.level,
    entropy: meta.entropy,
    verdict: meta.verdict,
    kind: payload.kind,
    payload,
    strategy: payload.strategy,
    degraded: !!payload.degraded,
    writeLocked: !!payload.writeLocked,
    entities: payload.entities || {},
    rawHash: meta.rawHash,
  };
  return Object.freeze(envelope);
}

/**
 * 封印守卫：业务侧消费意图前必须先过此关。验证信封确由本进程熔炉铸造且未被篡改。
 * @param {object} envelope
 * @returns {object} 经校验的 envelope（可安全消费）
 * @throws {Error} 裸 payload / 缺封 / 篡改 一律抛错（fail-closed）
 */
function assertForged(envelope) {
  if (!envelope || typeof envelope !== 'object' || envelope[SEAL_BRAND] !== true) {
    throw new Error('未经熔炉封印的输入不得进入业务逻辑（§3.1 绝对前置拦截）');
  }
  if (envelope.seal !== _seal(envelope.payload)) {
    throw new Error('熔炉封印校验失败：payload 被篡改或非法构造');
  }
  return envelope;
}

/** 仅判定是否已封印（不抛错），供条件分支使用。 */
function isForged(envelope) {
  return !!(envelope && typeof envelope === 'object' && envelope[SEAL_BRAND] === true
    && envelope.seal === _seal(envelope.payload));
}

module.exports = {
  intercept,
  assertForged,
  isForged,
  FurnaceRejection,
  SEAL_BRAND,
};
