'use strict';

/**
 * khyTrace.js — `_khyTrace` 溯源信封的单一真源（DESIGN-ARCH-047 §2）。
 *
 * 当 Khyos 经任意外部 agent 中转（codex / claude-code / 通用 relay）时，外部回传的
 * 助手正文、thinking、工具调用请求都会流进 Khyos 自己的对话轨迹。本模块定义每一条
 * 轨迹条目都应携带的「溯源信封」`_khyTrace`：谁产的（producer）、可信到什么程度
 * （trust）、是哪类内容（kind）、何时产生（at），以及后续阶段填充的矛盾标记
 * （contradictions，P4）与封印（seal，P2）。
 *
 * 设计铁律（防呆）：
 *   - 标签 fail-SAFE-TO-OURS：任何缺失/异常输入一律归 KHY_LOCAL / VERIFIED，
 *     绝不把本地内容误标为外部、也绝不把外部内容漏标为本地（漏标方向只能偏“我方”，
 *     因为隔离与核对是按 producer!=khy-local 触发的，宁可少防不可错防自己）。
 *   - 枚举 frozen；未知 producer 一律坍缩为 `relay` + producerId=raw，热路径永不抛。
 *   - 纯函数、零 IO：可在任意热路径同步调用。
 */

const PRODUCER = Object.freeze({
  KHY_LOCAL: 'khy-local',   // Khyos 自有模型 / agent loop
  CODEX: 'codex',           // codex-direct / codex 中转
  CLAUDE_CODE: 'claude-code', // claude-code 中转
  RELAY: 'relay',           // 通用中转 relay:<id>（id 落在 producerId）
});

const TRUST = Object.freeze({
  VERIFIED: 'verified',     // 本地重跑 / 本地校验过
  CLAIMED: 'claimed',       // 外部声称，未经本地验证
  QUARANTINED: 'quarantined', // 注入调用被审批闸扣留
});

const KIND = Object.freeze({
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
});

const TRACE_VERSION = 1;

const _PRODUCERS = new Set(Object.values(PRODUCER));
const _TRUSTS = new Set(Object.values(TRUST));
const _KINDS = new Set(Object.values(KIND));

function _stamp() {
  try { return Date.now(); } catch { return 0; }
}

/**
 * 归一 producer：已知枚举原样返回；其它非空值坍缩为 RELAY 并把原值作为 producerId。
 * @returns {{producer:string, producerId:(string|null)}}
 */
function normalizeProducer(producer, producerId = null) {
  if (typeof producer === 'string' && _PRODUCERS.has(producer)) {
    return { producer, producerId: producerId == null ? null : String(producerId) };
  }
  if (producer == null || producer === '') {
    // fail-safe to ours
    return { producer: PRODUCER.KHY_LOCAL, producerId: null };
  }
  // 未知 producer → relay:<raw>
  const raw = producerId == null ? String(producer) : String(producerId);
  return { producer: PRODUCER.RELAY, producerId: raw };
}

function _normalizeTrust(trust, producer) {
  if (typeof trust === 'string' && _TRUSTS.has(trust)) return trust;
  // 缺/异常 trust：我方→verified，外部→claimed（保守，绝不默认 verified 给外部）。
  return producer === PRODUCER.KHY_LOCAL ? TRUST.VERIFIED : TRUST.CLAIMED;
}

function _normalizeKind(kind) {
  return typeof kind === 'string' && _KINDS.has(kind) ? kind : KIND.TEXT;
}

/**
 * 构造一个 `_khyTrace` 信封（纯数据，不挂到任何对象上）。
 * @param {object} [opts] { producer, producerId, trust, kind, at, contradictions, seal }
 * @returns {object} _khyTrace
 */
function makeTrace(opts = {}) {
  const { producer, producerId } = normalizeProducer(opts.producer, opts.producerId);
  const trust = _normalizeTrust(opts.trust, producer);
  const kind = _normalizeKind(opts.kind);
  return {
    v: TRACE_VERSION,
    producer,
    producerId,
    trust,
    kind,
    at: Number.isFinite(opts.at) ? opts.at : _stamp(),
    contradictions: Array.isArray(opts.contradictions) ? opts.contradictions : [],
    seal: typeof opts.seal === 'string' ? opts.seal : null,
  };
}

/**
 * 给一个轨迹条目盖戳：返回带 `_khyTrace` 的浅拷贝（不可变枚举，原对象不被改写）。
 * 缺省 / 异常输入 fail-safe 到 KHY_LOCAL / VERIFIED。
 * @param {object} entry 任意可序列化条目（{role, content, ...}）
 * @param {object} [opts] 见 makeTrace
 * @returns {object} entry 的浅拷贝 + `_khyTrace`
 */
function stamp(entry, opts = {}) {
  const base = (entry && typeof entry === 'object') ? entry : {};
  return { ...base, _khyTrace: makeTrace(opts) };
}

/** 是否带（结构合法的）_khyTrace。 */
function isTrace(value) {
  return !!(value && typeof value === 'object'
    && value._khyTrace && typeof value._khyTrace === 'object'
    && _PRODUCERS.has(value._khyTrace.producer)
    && _TRUSTS.has(value._khyTrace.trust));
}

/**
 * 取条目的 _khyTrace；缺失则返回 fail-safe 的默认（khy-local/verified）信封，绝不返回 null。
 * 这样下游渲染/链/核对永远拿得到一个结构完整的信封。
 */
function traceOf(entry) {
  if (isTrace(entry)) return entry._khyTrace;
  return makeTrace({ producer: PRODUCER.KHY_LOCAL, trust: TRUST.VERIFIED });
}

/** producer 是否为外部中转（非 khy-local）。隔离/核对的统一判定入口。 */
function isRelayed(producer) {
  return typeof producer === 'string' && producer !== PRODUCER.KHY_LOCAL && _PRODUCERS.has(producer);
}

module.exports = {
  PRODUCER,
  TRUST,
  KIND,
  TRACE_VERSION,
  makeTrace,
  stamp,
  isTrace,
  traceOf,
  isRelayed,
  normalizeProducer,
};
