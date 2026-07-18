'use strict';

/**
 * extractEndpoint.js — 「从自由文本里抽第一个 http(s) URL·剥尾部中文/半角标点」纯 helper
 *   (纯叶子·零 IO·无状态·不 mutate 入参·绝不抛)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_extractEndpoint(text)`——
 *   services/config/nlExternalAppResolver(内部用)· services/config/nlProviderResolver(内部用)。
 *
 * 语义:`text.match(_URL_RE)` 取首个 URL,再 `.replace(/[，。、；;]+$/, '')` 剥尾部标点;
 *   无匹配 / 任何异常 → `''`。`_URL_RE` 与原两处 module 常量逐字节相同(已核一致)。
 *
 * 契约:纯叶子(无 IO/状态)·不 mutate 入参·绝不抛。各消费方保留同名本地
 *   `const _extractEndpoint = require('../../utils/extractEndpoint')` → 调用点逐字节不变。
 */

const _URL_RE = /\bhttps?:\/\/[^\s，。、；;"'`」』）)】]+/i;

function _extractEndpoint(text) {
  try {
    const m = text.match(_URL_RE);
    return m ? m[0].replace(/[，。、；;]+$/, '') : '';
  } catch {
    return '';
  }
}

module.exports = _extractEndpoint;
