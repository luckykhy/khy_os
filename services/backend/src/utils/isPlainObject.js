'use strict';

/**
 * isPlainObject.js — 纯 util:「非 null 的非数组对象」判定单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_isPlainObject(v)`
 * (bootstrap/windowsSpawnHardening · services/externalApps/tomlLite ·
 *  services/syscallGateway/actionContractVerifier):
 *   `v !== null && typeof v === 'object' && !Array.isArray(v)`
 * 语义:排除 null 与数组的「对象型」宽判定(含类实例/Date 等,与原体一致——非严格 plain-object)。
 *
 * **刻意不收敛**:cli/repl/khySettings 的 `_isPlainObject` 用真值 `v && ...`(对 undefined/0
 *   返回 undefined/0 而非布尔 false)→ 返回值语义不同,留原样(C 组)。
 *
 * 契约:纯函数、确定性、恒返回布尔、不 mutate、绝不抛。
 *
 * 各消费方保留同名本地 `const _isPlainObject = require('.../isPlainObject')` → 调用点逐字节不变。
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = isPlainObject;
