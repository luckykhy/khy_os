'use strict';

/**
 * collapseWhitespace.js — 「空白折叠 + 去首尾」单一真源(纯)。
 *
 * 收敛 src/ 下 4 处 body 逐字节相同、仅函数名/单多行不同的
 *   `String(s == null ? '' : s).replace(/\s+/g, ' ').trim()`
 * (learningRetrieval._norm · memoryEngine/sessionMemory._norm ·
 *  memoryEngine/progressLog._oneLine · memoryTier._normText):
 *   nullish→''、内部连续空白(空格/制表/换行)折叠为单空格、去首尾空白。
 *
 * 契约:纯函数(确定性、无 IO、不 mutate)。`/\s+/g` 的 g 标志是 replace 全替所需,
 * 非 test/exec 故无 lastIndex 状态隐患。
 *
 * 各消费方保留同名本地 `const _xxx = require('.../utils/collapseWhitespace')` → 调用点逐字节不变。
 */

function collapseWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

module.exports = collapseWhitespace;
