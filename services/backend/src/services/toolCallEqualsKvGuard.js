'use strict';

/**
 * toolCallEqualsKvGuard.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 toolCallParser.parseFunctionArgs 的「`=` 分支准入过宽」缺陷:该分支只要
 * `argsStr.includes('=')` 就把整串当 `key=value[, key=value]` 解析,于是**含 `=` 的裸命令**
 * (PowerShell 赋值 `$x = ...`、bash `export FOO=bar` / `VAR=val cmd`、命令里的 `--opt=value`)
 * 被误当键值对切碎:第一个 `=` 左边整段被当「键」,永远拼不出 `command` 字段 →
 *   `Bash(powershell -Command "$files = Get-ChildItem ...")`
 *     → { 'powershell -Command "$files': '...' }(无 command)
 *   → shellCommand schema `command: required` 校验失败 → 折成 `Invalid tool parameters`。
 * parseFunctionArgs 服务 Format 2/2b/5/6/7 五路工具调用解析,故此缺陷在 harmony/文本形工具
 * 调用路径上,让**任何含 `=` 的 shell 命令**都调不动(Windows/PowerShell 用户尤其高频)。
 *
 * 正确判定:真正的 KV 键恒是**裸标识符**紧跟 `=`(caller 用 `pair.split('=')` + `key.trim()`
 * 取键名),故「首个 `=` 左侧是 `[A-Za-z_][\w-]*`」= 真 KV 形;左侧含空格/引号(如
 * `powershell -Command "$files`)= 裸命令,应落 command 兜底而非 KV。本叶子给出该准入判定。
 *
 * 门控 KHY_TOOLCALL_EQ_KV_GUARD(默认开):关(0/false/off/no)/异常/非字符串 → 返回 null,
 * 调用方逐字节回退 legacy `argsStr.includes('=')` 判定(含 `=` 即进 KV 分支)。flagRegistry
 * 优先,失败回退本地 CANON 解析;绝不抛。
 *
 * 严格化(非扩张):门开只在「含 `=` 但首键非裸标识符」时**多拦一层**(这些串 legacy 本就
 * 产不出合法键、只会丢 command)→ 改落 command 兜底;首键是裸标识符(`command=`/`a=1, b=2`)
 * 者两态完全一致。与 [[KHY_TOOLCALL_COLON_KV_ANCHOR]]/[[KHY_TOOLCALL_EQ_KV_SPLIT]] 同函数三分支
 * 同类锚定(冒号键 / 逗号切点 / 等号准入)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 「首个 `=` 左侧是裸标识符键」的形状:可选前导空白 + 标识符([A-Za-z_] 起,含 \w 与连字符)
// + 可选空白 + `=`。命中 → 真 KV 形;不中(含空格/引号/以非标识符起)→ 裸命令。
const _KV_KEY_LEAD = /^\s*[A-Za-z_][\w-]*\s*=/;

/**
 * 门控 KHY_TOOLCALL_EQ_KV_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function eqKvGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_TOOLCALL_EQ_KV_GUARD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_TOOLCALL_EQ_KV_GUARD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 判定 argsStr 是否应走 `=` KV 分支。
 *   - 门关 / 异常 / 非字符串 → null(调用方回退 legacy `argsStr.includes('=')` 判定);
 *   - 门开 → true(首个 `=` 左侧是裸标识符键,真 KV)/ false(含 `=` 但首键非标识符,裸命令)。
 * @param {string} argsStr
 * @param {Record<string,string>} [env]
 * @returns {boolean|null}
 */
function shouldParseAsKvArgs(argsStr, env = process.env) {
  try {
    if (!eqKvGuardEnabled(env)) return null;
    if (typeof argsStr !== 'string') return null;
    return _KV_KEY_LEAD.test(argsStr);
  } catch {
    return null;
  }
}

module.exports = {
  eqKvGuardEnabled,
  shouldParseAsKvArgs,
};
