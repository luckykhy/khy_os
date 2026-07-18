'use strict';

/**
 * escapeRegExp.js — 纯 util:正则元字符转义的单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_escapeRe(s)`
 * (services/evolutionPolicy · services/contextScope/searchPlanBuilder · services/plugins/pluginInvoker):
 *   `String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`
 * 用途:把用户/动态 token 安全嵌入 `new RegExp(...)`,防元字符注入。
 *
 * **刻意不收敛**:services/completionContract 的 `_escapeRe` 用 `_str(s)`(null→'')而非
 *   `String(s)`(null→'null')——null 语义不同,收敛会改行为,留其原样(C 组)。
 *
 * 契约:确定性、不 mutate、以 `String(s)` 强转(与被收敛三簇一致:null→'null'、undefined→'undefined')。
 *   正则为函数体内联字面量(与原体逐字节一致);`.replace` 对 /g 正则无 lastIndex 泄漏。
 *
 * 各消费方保留同名本地 `const _escapeRe = require('.../escapeRegExp')` → 调用点逐字节不变。
 */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = escapeRegExp;
