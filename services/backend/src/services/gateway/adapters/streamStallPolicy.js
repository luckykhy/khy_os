'use strict';

/**
 * streamStallPolicy.js — 纯叶子:上游 AI 流式(SSE)连接「卡死」(stall)时该怎么办的单一真源。
 *
 * 背景(连接稳定性真缺口):三个共享 SSE 解析器
 *   - `_openaiSseStream.js`
 *   - `_anthropicSseStream.js`
 *   - `_responsesSseStream.js`
 * 都各自构造了 `StreamStaleDetector`(阈值真源在 `_streamStaleDetector.PROVIDER_STALE_MS`,
 * provider 感知 45–90s),但它们的 `onStale` 全都只「转发一条 status 文案」而**从不拆掉这条流**。
 * 于是一条静默卡死的上游流会一直挂到粗粒度的 120s socket 超时(kiro 更糟,可无限挂)——
 * 这正是「莫名其妙超时 / 会话卡住」的连接级病根。
 *
 * 本叶子只拥有**决策 + 规范化的卡死错误**(阈值仍单一真源在 `_streamStaleDetector`),
 * 让三个解析器行为一致:卡死即主动拆流,复用各文件既有的 `stream.on('error')` 半截救援路径
 * (有进度→按截断 resolve 走续写恢复;零进度→reject 一个被判为 `timeout` 的瞬时错误→重试/failover)。
 *
 * 契约:零 IO(只读 process.env 做门控,不碰 fs/网络/子进程/流对象)、确定性、绝不抛(fail-soft)、
 * env 门控 `KHY_STREAM_STALL_ABORT` 默认开。门控关 → `shouldAbortStaleStream()===false` →
 * 调用方跳过拆流 → 行为与今天**逐字节相同**(只转发,不拆流)。
 *
 * 全局门控惯例:khyos 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const STREAM_STALL_MARKER = 'KHY_STREAM_STALL';

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// trim+小写 nullish-安全规整单一真源 utils/normLower。
const _norm = require('../../../utils/normLower');

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function isEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_STREAM_STALL_ABORT));
}

/**
 * 决策:流卡死时是否主动拆流(true)还是只告警(false=今天的旧行为)。
 * 目前等同于门控;独立成函数,方便将来按 provider/场景细化而不动调用方。
 */
function shouldAbortStaleStream(env = process.env) {
  return isEnabled(env);
}

/**
 * 规范化的「流卡死」错误(单一真源)。
 *
 * 消息特意含 "stalled" 与 "idle timeout",使其经 `_errorClassifiers` 归类为 `timeout`——
 * 即一个**瞬时、与载荷无关**的失败:不计入熔断器开闸,享有 timeout 短冷却 + 重试/failover。
 * 同时打上结构化标记(code/errorType/isStreamStall),让下游无需正则即可识别。
 *
 * @param {object} opts
 * @param {string} [opts.provider]  provider 名(仅用于文案,大小写不敏感)
 * @param {number} [opts.elapsedMs] 卡死时长(ms);非法值归 0,绝不抛
 * @returns {Error}
 */
function buildStallError(opts = {}) {
  const provider = _norm(opts && opts.provider) || 'default';
  const elapsedMs = Number(opts && opts.elapsedMs);
  const secs = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.round(elapsedMs / 1000) : 0;
  const err = new Error(`Stream stalled: no data for ${secs}s from ${provider} (idle timeout)`);
  err.name = 'StreamStallError';
  err.code = STREAM_STALL_MARKER;
  err.errorType = 'timeout';
  err.isStreamStall = true;
  err.stallProvider = provider;
  err.stallElapsedMs = secs * 1000;
  return err;
}

/** 判定一个错误是否是本叶子产出的「流卡死」错误(结构化优先,fail-soft)。 */
function isStreamStallError(err) {
  if (!err || typeof err !== 'object') return false;
  return err.code === STREAM_STALL_MARKER
    || err.isStreamStall === true
    || err.name === 'StreamStallError';
}

/** 自描述(给工具 / CLI / 帮助 / 提示词用)。 */
function describeStallPolicy(env = process.env) {
  const on = isEnabled(env);
  return {
    enabled: on,
    gate: 'KHY_STREAM_STALL_ABORT',
    marker: STREAM_STALL_MARKER,
    behaviorWhenStale: on
      ? 'tear down stalled stream → transient timeout → retry/failover (or salvage partial progress)'
      : 'forward status only (legacy: stalled socket hangs until the coarse socket timeout)',
  };
}

module.exports = {
  STREAM_STALL_MARKER,
  isEnabled,
  shouldAbortStaleStream,
  buildStallError,
  isStreamStallError,
  describeStallPolicy,
};
