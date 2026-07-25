'use strict';

/**
 * instructionIncludeBoundary.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 instructionFileService.resolveIncludes 的 `@include` 允许门「未锚定 startsWith」缺陷(:97):
 *   if (!resolved.startsWith(baseDir) && !resolved.startsWith(os.homedir())) → deny
 * 即「在 baseDir 下 **或** 在 $HOME 下」才允许把外部文件内联进指令/系统提示词。两个前缀判定都用
 * **裸** startsWith,无路径分隔符边界 → 允许集**过宽**:
 *   ① baseDir=`/tmp/proj` 时 `/tmp/proj-evil/inject.md`.startsWith('/tmp/proj')===true → 被允许
 *      内联(名字前缀撞上的兄弟目录里的第三方文件被当「项目内」注入指令);
 *   ② home=`/home/user` 时 `/home/user2/.ssh/id_rsa`.startsWith('/home/user')===true → 允许内联
 *      **另一个用户**的机密文件(`@../user2/.ssh/id_rsa` 形态)。
 * 二者都是「@include 提示词注入 / 机密内联」向量:内联内容进入模型系统提示词。
 *
 * 正确语义(与同仓 instructionExternalIncludes._isInside:51-56 一致):锚定分隔符边界——
 *   `resolved === base || resolved.startsWith(base + sep)`。允许门收紧为严格子集:真在 baseDir/ 或
 *   $HOME/ 之下(或正是其一)的仍允许(逐字节一致),只把「仅名字前缀相同的兄弟目录」从允许改判拒绝。
 *   注意:这里 startsWith 用于**放行**,收紧 = 少放行 = 安全方向(拒绝集是 legacy 的严格超集)。
 *
 * 门控 KHY_INCLUDE_BOUNDARY_ANCHOR(默认开):关(0/false/off/no)/异常/非字符串 → 返回 null,
 * 调用方回退 legacy 裸 `startsWith(baseDir) || startsWith(home)`(逐字节等价)。flagRegistry 优先,
 * 失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_INCLUDE_BOUNDARY_ANCHOR:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function includeBoundaryAnchorEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_INCLUDE_BOUNDARY_ANCHOR', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_INCLUDE_BOUNDARY_ANCHOR;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

// child 与 parent 同路径,或以分隔符边界嵌套其下。parent 空 → false。
function _isInside(child, parent, sep) {
  if (!parent || typeof parent !== 'string') return false;
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}

/**
 * 判 `@include` 目标 `resolved` 是否落在允许范围(baseDir/ 或 home/ 之下,锚定分隔符边界)。
 *   - 门关 / 异常 / resolved 非字符串 → null(调用方回退 legacy 裸 startsWith 双判);
 *   - 门开 → `_isInside(resolved, baseDir) || _isInside(resolved, home)`(布尔)。
 * @param {string} resolved  已解析的绝对路径
 * @param {string} baseDir   include 基目录(绝对)
 * @param {string} home      用户 home 目录(绝对;由调用方传 os.homedir())
 * @param {string} [sep]     路径分隔符(默认 '/';调用方传 path.sep)
 * @param {Record<string,string>} [env]
 * @returns {boolean|null}
 */
function isIncludeAllowed(resolved, baseDir, home, sep, env = process.env) {
  try {
    if (!includeBoundaryAnchorEnabled(env)) return null;
    if (typeof resolved !== 'string') return null;
    const s = (typeof sep === 'string' && sep) ? sep : '/';
    return _isInside(resolved, baseDir, s) || _isInside(resolved, home, s);
  } catch {
    return null;
  }
}

module.exports = {
  includeBoundaryAnchorEnabled,
  isIncludeAllowed,
};
