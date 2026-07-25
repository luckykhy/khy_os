'use strict';

/**
 * modernKeyRedaction.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 services/honestFailureReason.sanitizeCause 的「现代 OpenAI key 脱敏漏网」缺陷(:45):
 *   /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/g
 * 首个 `[-_]` 之后的字符类 `[A-Za-z0-9]{8,}` **不含 `-`**。而 OpenAI 现行默认密钥形态是
 * `sk-proj-…`/`sk-svcacct-…`/`sk-admin-…`——第一、二段连字符之间的段(proj=4、svcacct=7)
 * 短于 8 → `{8,}` 匹配失败 → key **未脱敏**,被 sanitizeCause 原样带进用户可见失败文案
 * (resolveFriendlyFailureMessage),现行默认 key 形态存在实时泄密缺口。
 * (兄弟模块 errorClassifier.js:187 用 `sk-[A-Za-z0-9_-]{8,}`——把 `-` 放进类里——是正解,
 *  印证本处应有的意图。)
 *
 * 本叶子提供「现代密钥再脱敏」一趟(把 `-`/`_` 纳入 body 字符类,`sk-proj-…` 整体命中),
 * 作为 legacy 脱敏之后的**追加严格超集**(只多抹密钥、绝不动 ECONNREFUSED/HTTP 502/host:port
 * 这类真因):
 *   - redactModernKeys(s, env):
 *       门开 ∧ s 为非空串 → 用修正正则把命中整体抹成 `***`(已抹的 `***` 不再命中,幂等);
 *       门关 / 非串 / 空 / 异常 → 返回 null(调用方逐字节回退,不追加这趟)。
 *
 * 门控 KHY_MODERN_KEY_REDACTION(默认开;0/false/off/no 关 → null 回退)。
 * flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 与 errorClassifier.js:187 对齐:body 字符类纳入 `-`/`_`,使 `sk-proj-…` 等多段现代 key 整体命中。
const MODERN_KEY_RE = /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g;

/**
 * 门控 KHY_MODERN_KEY_REDACTION:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function modernKeyRedactionEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_MODERN_KEY_REDACTION', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_MODERN_KEY_REDACTION;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 追加一趟现代密钥脱敏。
 * @param {string} s   legacy 脱敏后的中间串
 * @param {Record<string,string>} [env]
 * @returns {string|null} 门开→抹过现代 key 的串;门关/非串/空/异常→null(调用方回退)
 */
function redactModernKeys(s, env = process.env) {
  try {
    if (!modernKeyRedactionEnabled(env)) return null;
    if (typeof s !== 'string' || !s) return null;
    return s.replace(MODERN_KEY_RE, '***');
  } catch {
    return null;
  }
}

module.exports = {
  modernKeyRedactionEnabled,
  redactModernKeys,
  MODERN_KEY_RE,
};
