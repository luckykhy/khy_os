'use strict';

/**
 * imageGenPoolBridge.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「聊天配好了 agnes(poolKey=agnes),生图却报『未检测到任何图像生成后端』」。
 *
 * 根因:khy 有两套互不相通的 agnes 凭据存储——聊天 provider 把 key 存进 apiKeyPool
 * (poolKey=agnes,endpoint=https://apihub.agnes-ai.com/v1),而 imageGenService 只从自己私有
 * 的 KHY_IMAGE_GEN_AGNES_API_KEY env 读 key,从不看聊天池。用户走聊天 provider 流程配 agnes
 * 后,生图那侧 backendStatus().agnes=false → resolveBackend() 返回 null → 报「无后端」。
 *
 * 本叶子把「生图能否从聊天池借用一个已配置且已知可生图的 provider 凭据」这一决策收敛为单一真源:
 *   - 判定口径 = 已知生图主机白名单 IMAGE_CAPABLE_HOSTS(初始仅 agnes 的 apihub.agnes-ai.com,
 *     日后加主机只改这一处常量);只对 endpoint 主机命中白名单的 pool provider 生效——安全,
 *     绝不会把 key 打到不支持 OpenAI 形 /images/generations 的端点。
 *   - 门控 KHY_IMAGE_GEN_POOL_BRIDGE(默认开):关门/异常 → 决策恒空,消费点逐字节回退今日行为。
 *
 * 严格的「决策 vs IO」分层:本叶子**只做决策**(哪个 provider 的 endpoint 主机可生图),
 * **绝不取 key**——运行时 secret(实时 key)由消费点(imageGenService)从 apiKeyPool.pick() 拿。
 * 因此本叶子零 require IO 模块、可单测。pickImageProviderFromPool 的入参是调用点传入的
 * provider 列表 + 一个取实时 endpoint 的回调,叶子本身不碰 apiKeyPool / customProviderRegistry。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 已知支持 OpenAI 形 POST /v1/images/generations 的主机白名单(单一真源)。
// 初始仅 agnes 的公共端点;新增可生图 provider 时只在这里追加主机名(小写)。
const IMAGE_CAPABLE_HOSTS = ['apihub.agnes-ai.com'];

/**
 * 门控是否开(默认开)。fail-soft:异常视作开(与默认一致)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function bridgeEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_IMAGE_GEN_POOL_BRIDGE;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return true;
  }
}

/**
 * 解析 endpoint 的主机名(小写)。非法/空 → ''。绝不抛。
 * @param {string} endpoint
 * @returns {string}
 */
const _hostOf = require('../utils/hostOfEndpoint');

/**
 * 该 endpoint 的主机是否为已知可生图主机(精确主机名匹配,大小写折叠)。绝不抛。
 * @param {string} endpoint
 * @returns {boolean}
 */
function hostServesImages(endpoint) {
  const host = _hostOf(endpoint);
  if (!host) return false;
  return IMAGE_CAPABLE_HOSTS.includes(host);
}

/**
 * 从聊天池的 provider 列表里,选出**所有** endpoint 主机命中已知生图白名单的 provider。
 *
 * 与 pickImageProviderFromPool 共用同一 host 判定(hostServesImages)——决策单一真源。
 * 用于「跨 key 轮转」:调用方拿全部候选 provider,再逐个 apiKeyPool.listAvailableKeys 试。
 * 返回按 poolKey 字典序的确定列表(可复现)。门关/异常/无命中 → []。
 *
 * @param {{providers?: Array<{poolKey:string, endpoint?:string}>, endpointFor?: (k:string)=>string, env?: Record<string,string>}} args
 * @returns {Array<{poolKey:string, endpoint:string}>}
 */
function listImageProvidersFromPool(args = {}) {
  try {
    const env = args.env || process.env;
    if (!bridgeEnabled(env)) return [];
    const providers = Array.isArray(args.providers) ? args.providers : [];
    const endpointFor = typeof args.endpointFor === 'function' ? args.endpointFor : null;

    const candidates = [];
    const seen = new Set();
    for (const p of providers) {
      const poolKey = p && typeof p.poolKey === 'string' ? p.poolKey.trim() : '';
      if (!poolKey || seen.has(poolKey)) continue;
      let endpoint = '';
      if (endpointFor) {
        try { endpoint = String(endpointFor(poolKey) || ''); } catch { endpoint = ''; }
      }
      if (!endpoint) endpoint = String((p && p.endpoint) || '');
      if (hostServesImages(endpoint)) {
        seen.add(poolKey);
        candidates.push({ poolKey, endpoint: endpoint.replace(/\/+$/, '') });
      }
    }
    candidates.sort((a, b) => (a.poolKey < b.poolKey ? -1 : a.poolKey > b.poolKey ? 1 : 0));
    return candidates;
  } catch {
    return [];
  }
}

/**
 * 从聊天池的 provider 列表里,选出第一个 endpoint 主机命中已知生图白名单的 provider。
 *
 * 纯函数:入参由消费点提供,叶子不做任何 IO。
 *   - providers: Array<{poolKey:string, endpoint?:string}> —— 聊天池/注册表里的 provider 列表。
 *   - endpointFor?: (poolKey:string) => string —— 可选回调,取该 provider 的实时 endpoint;
 *     命中优先用它,缺失时回落到 provider.endpoint。
 * 门关/异常/无命中 → null。命中多个时按 poolKey 字典序确定选第一个(可复现)。
 *
 * @param {{providers?: Array<{poolKey:string, endpoint?:string}>, endpointFor?: (k:string)=>string, env?: Record<string,string>}} args
 * @returns {{poolKey:string, endpoint:string} | null}
 */
function pickImageProviderFromPool(args = {}) {
  try {
    const list = listImageProvidersFromPool(args);
    return list.length ? list[0] : null;
  } catch {
    return null;
  }
}

module.exports = {
  bridgeEnabled,
  hostServesImages,
  pickImageProviderFromPool,
  listImageProvidersFromPool,
  IMAGE_CAPABLE_HOSTS,
  OFF_VALUES,
};
