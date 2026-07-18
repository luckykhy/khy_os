'use strict';

/**
 * toLowerCaseSafe.js — 「nullish-safe 转小写」单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_norm(s)`
 * (services/externalAgentDirective · errorEnumerationGuard · intentCoverage):
 *   `String(s == null ? '' : s).toLowerCase()`。
 *   null/undefined → '';其余经 String() 强转后 toLowerCase(不 trim、不去空白)。
 *
 * **与 utils/normalizeToolName 的区别(不可互委)**:normalizeToolName 额外 `.replace(/[\s_-]/g,'')`
 *   去空白/下划线/连字符;本 util 仅 lowercase,保留原字符。
 * **与 utils/toStr 的区别**:toStr 不改大小写;本 util 恒 toLowerCase。
 *
 * 契约:纯函数、确定性、不 mutate、恒返字符串。
 *
 * 各消费方保留同名本地 `const _norm = require('../utils/toLowerCaseSafe')` → 调用点逐字节不变。
 */

function toLowerCaseSafe(s) {
  return String(s == null ? '' : s).toLowerCase();
}

module.exports = toLowerCaseSafe;
