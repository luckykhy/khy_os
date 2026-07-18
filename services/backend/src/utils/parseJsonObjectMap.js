'use strict';

/**
 * parseJsonObjectMap.js — 「安全解析 JSON 对象映射」纯叶子(零 IO·确定性)。
 *
 * 收敛 2 处 body 逐字节相同的私有 JSON-map 解析器——
 *   services/gateway/adapters/apiAdapter.parseJsonMap(内部用·:84/:96/:108 喂 env 串)·
 *   services/gateway/aiGateway._parseJsonMap(内部用·:1030/:1042/:1054 喂 env 串)。
 * env 读在**调用点**(`process.env.GATEWAY_API_POOL_*`)·本函数只吃已取出的 raw 串→纯。
 *
 * 语义:raw → trim;空 → {};JSON.parse 成功且为**普通对象**(非数组/非 null)→ 原样返回;
 *   解析失败/非对象 → {}·**绝不抛**。
 *
 * 各消费方保留同名本地 `const parseJsonMap = require('.../parseJsonObjectMap')`
 *   → 调用点逐字节不变。
 */

function parseJsonObjectMap(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }
  return {};
}

module.exports = parseJsonObjectMap;
