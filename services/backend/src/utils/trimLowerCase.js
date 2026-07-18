'use strict';

/**
 * trimLowerCase.js — 「nullish-safe: trim + 转小写」单一真源。
 *
 * 收敛 src/ 下 6 处 body 逐字节相同的私有归一器(仅函数名/参数名不同):
 *   `String(<arg> || '').trim().toLowerCase()`
 *   - services/acceptanceCriteria `_normalizeText`
 *   - services/gateway/ucbRouter `_armKey`
 *   - tools/_userDirs `_aliasKey`
 *   - tools/ImportExternalAppModels · tools/ConfigureExternalApp · services/externalApps/appModelImporter `_normApp`
 *   用途一致:把外部名/键规整成 trim + lowercase 的匹配键。
 *
 * **语义**:`|| ''` → 0/false/null/undefined/'' 均归 '';其余 String 强转后 trim + toLowerCase。
 *
 * **与近亲区别(不可互委)**:
 *   - utils/toLowerCaseSafe 仅 lowercase 不 trim(且用 `== null ? '' :`,对 0 → '0');
 *   - utils/normalizeToolName 额外 `.replace(/[\s_-]/g,'')` 去空白/下划线/连字符;
 *   - localWebSolver 的 `_norm` 还折叠内部空白 `.replace(/\s+/g,' ')`。均另议。
 *
 * 契约:纯函数、确定性、不 mutate、恒返字符串。
 *
 * 各消费方保留同名本地 `const <原名> = require('.../trimLowerCase')` → 调用点逐字节不变。
 */

function trimLowerCase(v) {
  return String(v || '').trim().toLowerCase();
}

module.exports = trimLowerCase;
