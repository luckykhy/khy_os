'use strict';

/**
 * streamUsageOptions.js — 纯叶子:让 OpenAI 兼容流式请求**主动索取 usage**,修「ctx 卡在 0%」。
 *
 * 真实缺口(截图:agnes `api:agnes:agnes-2.0-flash` 跑了 37 分钟、大量输出,底栏仍 `0% ctx
 * (0/128k)`):TUI 必走 multiFreeService 流式分支(`stream: true`),而按 OpenAI 流式协议,
 * 服务端**只有在请求里带 `stream_options: { include_usage: true }` 时**才会在 SSE 末块回
 * `usage` 字段。历史请求体从不带它 → agnes 这类标准 OpenAI 兼容网关整条流都无 usage →
 * `tokenUsage = null` → useQueryBridge 的 `setContextTokens` 永不触发 → contextTokens 停在 0
 * → 底栏渲成 `0% ctx`。本叶子在流式请求体上加这一开关,让 usage 能真正回流。
 *
 * 加法式、绝不破坏:只在 requestBody 上补一个标准字段(不改 messages/model/其余)。极少数
 * 严格网关可能拒绝未知字段(400)——调用方的 400-retry 会连同 tools 一并剥 stream_options
 * 优雅降级(降级后 usage 仍为 0,即今日行为,不比现状更糟)。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_STREAM_USAGE(默认开,仅显式 0/false/off/no 关);
 * 关 / 异常 → 不改动 requestBody(逐字节回退,不加字段)。门控经 flagRegistry 集中判定
 * (CANON),fail-soft 回退本地 CANON。
 *
 * @module services/streamUsageOptions
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定:flagRegistry 优先,回退本地 CANON。默认开。 */
function streamUsageEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_STREAM_USAGE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_STREAM_USAGE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 在 OpenAI 兼容流式请求体上加 `stream_options: { include_usage: true }`,使服务端在 SSE
 * 末块回 usage。就地修改并返回同一 requestBody(方便链式)。
 *
 * 门控关 / requestBody 非对象 / 异常 → 原样返回不改动(逐字节回退)。已存在 stream_options
 * 时保守合并(不覆盖调用方已设的其它子键,只确保 include_usage=true)。
 *
 * @param {object} requestBody OpenAI /v1/chat/completions 请求体(已含 stream:true)
 * @param {object} [env]       注入 env(测试用);缺省取 process.env
 * @returns {object}           同一 requestBody(可能被就地补了 stream_options)
 */
function applyStreamUsage(requestBody, env) {
  try {
    if (!requestBody || typeof requestBody !== 'object') return requestBody;
    if (!streamUsageEnabled(env)) return requestBody;
    const existing = (requestBody.stream_options && typeof requestBody.stream_options === 'object')
      ? requestBody.stream_options
      : {};
    requestBody.stream_options = { ...existing, include_usage: true };
    return requestBody;
  } catch {
    return requestBody;
  }
}

module.exports = {
  streamUsageEnabled,
  applyStreamUsage,
};
