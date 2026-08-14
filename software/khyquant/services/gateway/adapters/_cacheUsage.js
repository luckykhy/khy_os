'use strict';

/**
 * _cacheUsage.js — 单一真源：把各厂商五花八门的「prompt 缓存」计费字段
 * 规范化成 KHY 内部规范名 { cacheReadInputTokens, cacheWriteInputTokens }。
 *
 * 背景：只有 CW/kiro 路径（_cwStreamParser.js）历来采集缓存字段，下游
 * proxyServer.js 已按这对规范名消费。其余适配器（Anthropic SSE / relay /
 * codex / openai）在构造 tokenUsage 时把缓存字段全丢了，导致网关无法判断
 * 某个中转商「享受了缓存却全价计费」。本模块补齐采集，纯函数零副作用。
 *
 * 厂商字段对照：
 *   Anthropic: cache_read_input_tokens（读）/ cache_creation_input_tokens（写）
 *   OpenAI:    prompt_tokens_details.cached_tokens（仅读，无写区分）
 *   DeepSeek:  prompt_cache_hit_tokens（读）/ prompt_cache_miss_tokens（仅信息，非写）
 *   CW/kiro:   cacheReadInputTokens / cacheWriteInputTokens（已是规范名，原样透传）
 */

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../../../utils/finiteNumber').toPositiveOr0;

/**
 * @param {object|null|undefined} rawUsage 厂商原始 usage 对象（任一协议形态）
 * @returns {{cacheReadInputTokens:number, cacheWriteInputTokens:number}}
 *   缺失字段一律 0；绝不抛错。
 */
function normalizeCacheUsage(rawUsage) {
  const u = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};

  // 1) 规范名已存在（CW/kiro，或上游已规范化）→ 原样透传，优先级最高。
  let read = _num(u.cacheReadInputTokens);
  let write = _num(u.cacheWriteInputTokens);

  // 2) Anthropic 原生字段。
  if (!read) read = _num(u.cache_read_input_tokens);
  if (!write) write = _num(u.cache_creation_input_tokens);

  // 3) OpenAI：prompt_tokens_details.cached_tokens（仅读，无写区分）。
  if (!read) {
    const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
      ? u.prompt_tokens_details
      : null;
    if (details) read = _num(details.cached_tokens);
  }

  // 4) DeepSeek：prompt_cache_hit_tokens（读）。miss 仅信息量，不计为写。
  if (!read) read = _num(u.prompt_cache_hit_tokens);

  return { cacheReadInputTokens: read, cacheWriteInputTokens: write };
}

/**
 * 便捷封装：把规范化后的缓存字段并入一个既有 tokenUsage 对象（不可变返回）。
 * 仅在缓存字段 > 0 时附加键，保持对零缓存响应的输出最小化。
 * @param {object} tokenUsage 既有 { inputTokens, outputTokens, totalTokens, ... }
 * @param {object|null} rawUsage 厂商原始 usage
 * @returns {object} 合并后的新对象
 */
function withCacheUsage(tokenUsage, rawUsage) {
  const base = tokenUsage && typeof tokenUsage === 'object' ? tokenUsage : {};
  const { cacheReadInputTokens, cacheWriteInputTokens } = normalizeCacheUsage(rawUsage);
  if (!cacheReadInputTokens && !cacheWriteInputTokens) return base;
  return { ...base, cacheReadInputTokens, cacheWriteInputTokens };
}

module.exports = { normalizeCacheUsage, withCacheUsage };
