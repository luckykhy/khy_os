'use strict';

/**
 * toolCallingProbe.js — 「某个模型到底能不能原生调工具」由**实测**决定的纯逻辑层。
 *
 * 背景:工具调用能力此前完全靠按名字硬编码的正/负向正则(modelToolingCapability 的
 * SMALL_MODEL_HINTS / FULL_SIZE_TOOL_EXCEPTIONS)猜测。一个名字含 "flash" 的全尺寸模型
 * (如 agnes-2.0-flash)会被误判为小模型而被剥掉 tools,导致工具完全无法调用;反之亦然。
 * 用户裁决:**工具可调用模型不要硬编码,需要实测后才算**。
 *
 * 本模块是「实测」的纯逻辑部分(零 IO/确定性/绝不抛):
 *   - 定义一个极小的探测工具 TRIVIAL_TOOL + 探测提示词 PROBE_PROMPT(发给模型,
 *     要求它调用该工具);
 *   - interpretProbeResult(result):把一次真实 generate 的返回值解释为
 *     'native' / 'text' / 'unknown' 三态裁决;
 *   - shouldReprobe(record, env):基于 TTL 的纯重测判定;
 *   - normalizeModel / isEnabled:规范化与门控。
 *
 * 网络发送与持久化分别在 aiGateway.verifyToolCalling(镜像 verifyModel)与
 * toolCapabilityStore(镜像 modelCuration 的原子写 + TTL)。本层不碰网络、不碰磁盘。
 *
 * 门控 KHY_TOOL_CAP_PROBE 默认开(独立于决策门 KHY_MODEL_TOOLING_CAPABILITY,
 * 便于单独关闭主动探测而保留既有决策语义)。仅 0/false/off/no 关。
 */

// 探测用的极小工具:schema 尽量小,避免触发上游对复杂 schema 的兼容问题。
// 名字带 khy_ 前缀,几乎不可能与真实业务工具撞名,且语义对模型清晰(回显 ok)。
const TRIVIAL_TOOL = Object.freeze({
  name: 'khy_probe_echo',
  description: 'Capability probe. Call this tool exactly once, passing ok:"yes".',
  input_schema: Object.freeze({
    type: 'object',
    properties: Object.freeze({ ok: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['ok']),
  }),
});

// 探测提示词:明确要求「调用工具」而非「文字回答」。能原生调工具的模型会回 tool_calls;
// 不能的模型会回纯文字(或把调用当文本吐出)。两种都被 interpretProbeResult 区分。
const PROBE_PROMPT =
  'Call the tool khy_probe_echo with ok set to "yes". Do not answer in plain text — use the tool.';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _norm = require('../../utils/trimLowerNullish');

/**
 * 门控(默认开;仅 0/false/off/no 关,大小写/空白不敏感)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const v = _norm(env && env.KHY_TOOL_CAP_PROBE);
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** 规范化 model id(缓存键统一用此,与决策层按名字判定保持同一规范化语义)。 */
function normalizeModel(model) {
  return _norm(model);
}

/** TTL(ms);env KHY_TOOL_CAP_TTL_MS 可调,非法/非正回落默认。 */
function ttlMs(env = process.env) {
  const raw = parseInt((env && env.KHY_TOOL_CAP_TTL_MS) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TTL_MS;
}

/**
 * 确证通过(verdict==='native')的重测 TTL(ms)。
 * **默认 0 = sticky 永不按 age 重测**:一个模型能不能原生调工具是其稳定的结构属性,
 * 一旦实测「通过」即纳入数组常驻,绝不重复浪费资源去探测。仅当 env
 * KHY_TOOL_CAP_NATIVE_TTL_MS 设为正数时才给 PASS 也加过期(自愈用·opt-in)。
 * @param {object} [env]
 * @returns {number} 0 表示永不过期
 */
function nativeTtlMs(env = process.env) {
  const raw = parseInt((env && env.KHY_TOOL_CAP_NATIVE_TTL_MS) || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 0;
}

/**
 * 把一次真实 generate 的返回解释为工具调用能力三态。纯函数、绝不抛。
 *   - 'native':回包含原生 tool_calls(toolUseBlocks 非空)或 finish_reason==='tool_calls'
 *               → 确证支持原生 function calling。
 *   - 'text'  :成功且有文字内容、但没有任何原生 tool_calls
 *               → 模型没走原生通道(可能把调用当文本吐,或纯聊天);判为不支持原生工具。
 *   - 'unknown':失败/空/异常 → 不下结论(不记录,留待重测)。绝不把瞬时失败误判为不支持。
 * @param {object} result generate 的返回值(或等价的 {success,content,toolUseBlocks,finishReason})
 * @returns {{verdict:'native'|'text'|'unknown', reason:string}}
 */
function interpretProbeResult(result) {
  try {
    const r = result || {};
    // native 信号:多种字段名兼容(网关/适配器返回形状的并集)。
    const blocks = r.toolUseBlocks || r.toolCalls || r.tool_calls;
    const blockCount = Array.isArray(blocks) ? blocks.length : 0;
    const finish = _norm(r.finishReason || r.stopReason || r.stop_reason || r.finish_reason);
    if (blockCount > 0 || finish === 'tool_calls' || finish === 'tool_use') {
      return { verdict: 'native', reason: 'native_tool_calls_observed' };
    }

    // 成功判定:显式 success===false 视为失败;未给 success 字段时,以「有文字内容」近似成功。
    const text = String(r.content != null ? r.content : (r.thinking != null ? r.thinking : '')).trim();
    const explicitlyFailed = r.success === false;
    if (explicitlyFailed) {
      return { verdict: 'unknown', reason: 'generation_failed' };
    }
    if (text) {
      // 成功回了文字却没调工具 → 不支持原生工具(或本轮选择不调,但探测提示词已强制要求调用)。
      return { verdict: 'text', reason: 'text_only_no_tool_calls' };
    }
    return { verdict: 'unknown', reason: 'empty_response' };
  } catch {
    return { verdict: 'unknown', reason: 'interpret_error' };
  }
}

/**
 * 基于 TTL 的纯重测判定。record 为 toolCapabilityStore 的条目(或 null)。
 * 无记录、记录非法 → 应重测(true)。
 *
 * **避免重复浪费资源(对称设计)**:
 *   - verdict==='native'(确证通过/PASS):默认 **sticky 永不重测**(nativeTtlMs 默认 0)。
 *     工具调用能力是模型的稳定结构属性,通过一次即纳入数组常驻,绝不周期性重探。
 *     需自愈时经 env KHY_TOOL_CAP_NATIVE_TTL_MS 给 PASS 也加过期;主动重测走 CLI
 *     gateway probe-tools(直调 verifyToolCalling,绕过本判定)。
 *   - verdict==='text'(未确证):有界 TTL(ttlMs,默认 7 天)重测,使一次性假阴性
 *     可恢复,同时不每轮浪费——负缓存仍挡住「未测→后台探测」的重复触发。
 * @param {object|null} record { verdict, measuredAt } 形状
 * @param {object} [env]
 * @param {number} [now] 可注入的当前时刻(测试用);缺省 Date.now()
 * @returns {boolean}
 */
function shouldReprobe(record, env = process.env, now) {
  try {
    if (!record || typeof record !== 'object') return true;
    const verdict = record.verdict;
    if (verdict !== 'native' && verdict !== 'text') return true; // unknown/缺失不算已测
    const measuredAt = Number(record.measuredAt);
    if (!Number.isFinite(measuredAt)) return true;
    const t = Number.isFinite(now) ? now : Date.now();
    if (verdict === 'native') {
      const nttl = nativeTtlMs(env);
      if (nttl <= 0) return false; // sticky:确证通过永不重测
      return (t - measuredAt) > nttl;
    }
    return (t - measuredAt) > ttlMs(env);
  } catch {
    return true;
  }
}

module.exports = {
  TRIVIAL_TOOL,
  PROBE_PROMPT,
  DEFAULT_TTL_MS,
  isEnabled,
  normalizeModel,
  ttlMs,
  nativeTtlMs,
  interpretProbeResult,
  shouldReprobe,
};
