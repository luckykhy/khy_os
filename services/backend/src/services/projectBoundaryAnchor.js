'use strict';

/**
 * projectBoundaryAnchor.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 tools/inputValidators 的项目边界判定「未锚定 startsWith」缺陷:
 *   validateNoPathTraversal(:170) `if (!resolved.startsWith(normalizedBase))`(写)
 *   validateReadAccess(:226)      `if (resolved.startsWith(normalizedBase))`(严格读)
 * 均用**裸** `resolved.startsWith(normalizedBase)` 判「是否在项目内」。裸前缀匹配无路径分隔符
 * 边界 → **共享名字前缀的兄弟目录**被误判为「项目内」:base=`/home/u/proj` 时
 *   `/home/u/proj-secrets/steal.txt`.startsWith('/home/u/proj') === true
 *   → 写路径:`!true=false` → 跳过越界拦截 → 直接放行写入(连 trusted-root/审批都不过就落盘);
 *   → 读路径(strict):返 valid:true → 严格读边界被绕过。
 * 即项目旁的 `proj-secrets`/`proj.bak`/`project2` 等只要名字前缀撞上就逃出边界(信息泄露 / 越界写)。
 *
 * 正确语义(与孪生 services/toolGuards:85-86 一致):`resolved === base || resolved.startsWith(base + sep)`
 * ——要么正是 base 本身,要么在 base 之下且下一字符是路径分隔符。这是**严格收紧**:凡 legacy 判「内」
 * 且真在 base/ 之下的仍判「内」(逐字节一致),只把「仅名字前缀相同的兄弟目录」从「内」改判「外」。
 *
 * 门控 KHY_PROJECT_BOUNDARY_ANCHOR(默认开):关(0/false/off/no)/异常/非字符串 → 返回 null,
 * 调用方回退 legacy 裸 `startsWith`(逐字节等价)。flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_PROJECT_BOUNDARY_ANCHOR:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function projectBoundaryAnchorEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_PROJECT_BOUNDARY_ANCHOR', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_PROJECT_BOUNDARY_ANCHOR;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 判 `resolved` 是否在项目根 `base` 之内,带分隔符边界锚定。
 *   - 门关 / 异常 / resolved 或 base 非字符串 → null(调用方回退 legacy 裸 startsWith);
 *   - 门开 → `resolved === base || resolved.startsWith(base + sep)`(布尔)。
 * @param {string} resolved  已解析的绝对路径
 * @param {string} base      已归一的项目根绝对路径
 * @param {string} [sep]     路径分隔符(默认 '/';调用方传 path.sep 以跨平台正确)
 * @param {Record<string,string>} [env]
 * @returns {boolean|null}
 */
function anchorWithinBase(resolved, base, sep, env = process.env) {
  try {
    if (!projectBoundaryAnchorEnabled(env)) return null;
    if (typeof resolved !== 'string' || typeof base !== 'string') return null;
    const s = (typeof sep === 'string' && sep) ? sep : '/';
    return resolved === base || resolved.startsWith(base + s);
  } catch {
    return null;
  }
}

module.exports = {
  projectBoundaryAnchorEnabled,
  anchorWithinBase,
};
