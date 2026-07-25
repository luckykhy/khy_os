'use strict';

/**
 * cleanText.js — 纯 util:nullish-安全的字符串规整单一真源。
 *
 * 这是 config/ 下 4 处逐字节相同的私有 `_clean(text)` 收敛后的单一真源
 * (nlProviderResolver / nlExternalAppImportResolver / nlInstallVsConfigGuard / nlExternalAppResolver)。
 * 语义:`String(text == null ? '' : text).trim()` —— null/undefined → 空串,其余 String 强转后去首尾空白。
 *
 * 契约:纯函数、确定性、不 mutate 入参、绝不抛。
 *
 * 各消费方保留同名本地 `const _clean = require('../../utils/cleanText')` → 调用点逐字节不变。
 */

function cleanText(text) {
  return String(text == null ? '' : text).trim();
}

module.exports = cleanText;
