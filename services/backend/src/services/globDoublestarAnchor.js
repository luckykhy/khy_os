'use strict';

/**
 * globDoublestarAnchor.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 permissionPolicy/matchers.globToRegExp 的「双星紧跟斜杠(`**` + `/`)吞掉分隔符后
 * 无边界」缺陷:该 glob→RegExp 编译器把 `**` 译成 `.*` 并「吞掉紧跟的斜杠,好让
 * `**`+`/x` 也匹配 `x`」,于是 `**`+`/id_rsa` 编成 `^.*id_rsa$` —— `.*` 无分隔符边界,
 * 导致它匹配**任何 basename 恰以该模式结尾**的路径:
 *   `**`+`/id_rsa` 匹配 `/home/u/.ssh/id_rsa`(本意)✔
 *                但也匹配 `/home/u/backup_id_rsa`、`evilid_rsa`(不同文件)✘
 * matchPath 用它做**文件权限白名单** → 一条这样的模式(或 `config` 同理)会顺带放行
 * 一批名字碰巧以该后缀结尾的**无关文件**,是真实的越权 over-match。
 *
 * 正确语义(与函数 docstring「anchored」、注释「双星斜杠也匹配 `x`」一致)是
 * 「任意目录下的 x」= `(?:.*[/\\])?x`:分隔符**存在时必须是真分隔符**,或整段可空
 * (使 `x` 自身也匹配)。本叶子提供该修正片段。
 *
 * 门控 KHY_GLOB_DOUBLESTAR_ANCHOR(默认开):关(0/false/off/no)/异常 → 返回 null,
 * 调用方逐字节回退到 legacy(`.*` + 吞斜杠),从而门关时编译结果逐字节等于历史行为。
 * flagRegistry 优先,失败回退本地 CANON 解析;绝不抛。
 *
 * 严格化(非扩张):门开只让该形匹配**更严**(去掉伪匹配),对白名单是安全收紧;
 * 合法的「任意目录下同名文件」仍全部命中,`x` 自身也仍命中(可选组为空)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 双星紧跟斜杠(`**` + `/`)的修正正则片段:可选的「任意前缀 + 真分隔符」,故
// `x` / `dir/x` / `a/b/x` 皆中,而 `foox`(x 前非分隔符)不中。字符类 [/\\] = 斜杠或反斜杠。
const DOUBLESTAR_SLASH_FRAGMENT = '(?:.*[/\\\\])?';

/**
 * 门控 KHY_GLOB_DOUBLESTAR_ANCHOR:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function globDoublestarAnchorEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_GLOB_DOUBLESTAR_ANCHOR', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_GLOB_DOUBLESTAR_ANCHOR;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 返回双星紧跟斜杠(`**` + `/`)在 glob→RegExp 编译时应发出的**修正**正则片段:
 *   - 门关 / 异常 → null(调用方回退 legacy `.*` + 吞斜杠);
 *   - 门开 → `(?:.*[/\\])?`(可选「任意前缀 + 真分隔符」,消除 over-match)。
 * 该片段已把斜杠语义纳入,调用方发出它后应同步吞掉源 glob 里那个斜杠。
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function doublestarSlashFragment(env = process.env) {
  try {
    if (!globDoublestarAnchorEnabled(env)) return null;
    return DOUBLESTAR_SLASH_FRAGMENT;
  } catch {
    return null;
  }
}

module.exports = {
  DOUBLESTAR_SLASH_FRAGMENT,
  globDoublestarAnchorEnabled,
  doublestarSlashFragment,
};
