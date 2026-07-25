'use strict';

/**
 * hostOfEndpoint.js — 「从端点串(允许裸主机/无协议)解析出小写 hostname」纯 helper
 *   (纯叶子·零 IO·无状态·仅用内建 URL/String)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_hostOf(endpoint)`——
 *   services/imageGenPoolBridge(内部用·:69)·services/videoGenPoolBridge(内部用·:70)。
 *
 * 语义:endpoint 归一为 trim 串·空→'';无 `scheme://` 前缀则补 `https://` 占位再取
 *   `new URL(...).hostname.toLowerCase()`;任何解析异常 → ''。**绝不抛**·不 mutate 入参。
 *
 * 契约:纯叶子(仅 URL/String·无 IO/状态)。各消费方保留同名本地
 *   `const _hostOf = require('../utils/hostOfEndpoint')` → 调用点逐字节不变。
 */

function _hostOf(endpoint) {
  try {
    const s = String(endpoint == null ? '' : endpoint).trim();
    if (!s) return '';
    // 允许裸主机(无协议)也能解析:补一个占位协议再取 host。
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}

module.exports = _hostOf;
