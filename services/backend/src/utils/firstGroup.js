'use strict';

/**
 * firstGroup.js — 「按正则匹配文本·取第 1 捕获组 trim(无则空串)」纯 helper
 *   (纯叶子·零 IO·无状态·不 mutate 入参·绝不抛)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_firstGroup(re, text)`——
 *   services/config/nlExternalAppResolver(内部用 ×5)· services/config/nlProviderResolver(内部用 ×8)。
 *
 * 语义:`text.match(re)` → 有第 1 捕获组则 `String(m[1]).trim()`,否则 `''`;
 *   任何异常(如 text 非字符串)→ `''`。正则由调用方传入(不依赖任何 module 常量)。
 *
 * 契约:纯叶子(无 IO/状态)·不 mutate 入参·绝不抛。各消费方保留同名本地
 *   `const _firstGroup = require('../../utils/firstGroup')` → 调用点逐字节不变。
 */

function _firstGroup(re, text) {
  try {
    const m = text.match(re);
    return m && m[1] ? String(m[1]).trim() : '';
  } catch {
    return '';
  }
}

module.exports = _firstGroup;
