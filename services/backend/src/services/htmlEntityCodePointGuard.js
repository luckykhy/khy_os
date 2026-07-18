'use strict';

/**
 * htmlEntityCodePointGuard.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 services/webFetchDecode.decodeEntities 的「越界码点崩溃」缺陷(:70-77):
 *   .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
 *     const cp = parseInt(h, 16);
 *     return Number.isFinite(cp) ? String.fromCodePoint(cp) : _;   // ← 崩
 *   })
 * 守卫 `Number.isFinite(cp)` 对任意 `[0-9a-f]+`/`\d+` 恒为 true(parseInt 永不返 Infinity),
 * 但 `String.fromCodePoint(cp)` 在 `cp > 0x10FFFF`(Unicode 上限)时抛 `RangeError: Invalid
 * code point`。正确守卫是 `cp <= 0x10FFFF`。decodeEntities → htmlToText → decodeAndExtract
 * 全链**无 try/catch**,异常直接冒泡,整个 webFetch 失败。
 *
 * 触发:任何远端页面含 `&#x110000;`(比上限多一个码点)或十进制 `&#9999999999;` 即崩。
 * 而 webFetch 处理的是**不可信远端字节**(模型可调用的联网抓取工具),攻击者或普通页面
 * 只需一个越界数字字符引用就能让整次抓取崩溃,而非优雅降级(把该实体留字面)。
 *
 * 本叶子把「码点→字符」的越界判定收成单一真源:
 *   - safeDecodeCodePoint(cp, fallback, env):
 *       门开 ∧ 合法码点(整数且 0≤cp≤0x10FFFF)→ String.fromCodePoint(cp)(合法路径与
 *         legacy 逐字节一致);
 *       门开 ∧ 越界/非整数 → 返回 fallback(原始实体串,留字面,不崩);
 *       门关 / 异常 → 返回 null(调用方逐字节回退到 legacy 表达式,保留原崩溃写法)。
 *
 * 门控 KHY_HTML_ENTITY_CODEPOINT_GUARD(默认开;0/false/off/no 关 → null 回退)。
 * flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// Unicode 码点上限(含):U+10FFFF。
const MAX_CODE_POINT = 0x10ffff;

/**
 * 门控 KHY_HTML_ENTITY_CODEPOINT_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function htmlEntityCodePointGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_HTML_ENTITY_CODEPOINT_GUARD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_HTML_ENTITY_CODEPOINT_GUARD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 把一个数字字符引用的码点安全解码成字符。
 * @param {number} cp        parseInt 得到的码点数值
 * @param {string} fallback  越界时返回的字面串(通常是原始实体匹配 `_`)
 * @param {Record<string,string>} [env]
 * @returns {string|null} 合法→字符;越界→fallback;门关/异常→null(调用方走 legacy)
 */
function safeDecodeCodePoint(cp, fallback, env = process.env) {
  try {
    if (!htmlEntityCodePointGuardEnabled(env)) return null;
    if (!Number.isInteger(cp) || cp < 0 || cp > MAX_CODE_POINT) {
      return fallback == null ? '' : String(fallback);
    }
    return String.fromCodePoint(cp);
  } catch {
    return null;
  }
}

module.exports = {
  htmlEntityCodePointGuardEnabled,
  safeDecodeCodePoint,
  MAX_CODE_POINT,
};
