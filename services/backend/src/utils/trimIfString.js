'use strict';

/**
 * trimIfString.js — 「仅字符串才 trim,其余一律空串」单一真源。
 *
 * 收敛 src/ 下 4 处逐字节相同的私有 `_s(v)`
 * (services/toolCatalog/toolContract · toolCatalog/toolCatalog · commandCatalog/commandCatalog ·
 *  selfLocation):
 *   `typeof v === 'string' ? v.trim() : ''`。
 *
 * **与 utils/toStr 的区别(刻意分开)**:toStr 对任意值 `String(v)` 强转(数字/布尔/对象 → 其字符串形);
 *   本 util 只让**字符串**通过(trim 后),其余类型(number/boolean/object/null/undefined)一律 → ''。
 *   即「类型闸门」而非「强转」,不可互相委托。
 *
 * 契约:纯函数、确定性、不 mutate、恒返字符串。
 *
 * 各消费方保留同名本地 `const _s = require('.../trimIfString')` → 调用点逐字节不变。
 */

function trimIfString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

module.exports = trimIfString;
