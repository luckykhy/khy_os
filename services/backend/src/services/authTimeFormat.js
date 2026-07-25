'use strict';

/**
 * authTimeFormat — 纯叶子:零 IO、确定性、fail-soft 的认证时间戳格式化与会话到期派生。
 *
 * 背景:whoami 面板(router.js)用 `new Date(x).toLocaleString('zh-CN')` 直接渲染 registeredAt /
 * loginAt / sessionExpires 三个时间戳,对无效/缺失值不做校验。真正的根因:_saveSession 从不写
 * `expiresAt`(SESSION_MAX_AGE_MS=7 天常量定义了却未使用),故 sessionExpires 恒为 undefined →
 * `new Date(undefined)` → 面板显示「会话到期: Invalid Date」。用户痛点:登录日期缺少合理管理、
 * 显示为非法日期。
 *
 * 本叶子把「时间戳安全格式化」与「会话到期派生」代码化:
 *   - formatAuthTimestamp:任何无效/缺失值 → 稳定回退文案(默认「未知」),绝不输出 Invalid Date;
 *     可选对已过期的到期时间追加「(已过期)」后缀,便于诚实地呈现会话状态(不强制登出)。
 *   - deriveSessionExpiry:为缺 expiresAt 的历史 session 从 loginAt + maxAgeMs 派生到期时间,
 *     实现向后兼容的「合理管理」。
 *
 * 契约:零 IO、确定性(不读时钟,除非调用方显式传入 now)、绝不抛;env 门控 KHY_AUTH_DATE_SANE
 * 默认开(仅 {0,false,off,no} 关)。门控关 → 调用方逐字节回退旧的 `new Date(x).toLocaleString` 行为。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_AUTH_DATE_SANE 默认开,仅 {0,false,off,no} 关。env 由调用方注入以便测试。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_AUTH_DATE_SANE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** 把任意输入解析为有效 Date;无效/缺失 → null。绝不抛。 */
function _toValidDate(value) {
  try {
    if (value === undefined || value === null || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * 安全格式化认证时间戳。
 * @param {*} value ISO 字符串 / Date / 时间戳
 * @param {object} [opts]
 * @param {string} [opts.locale='zh-CN'] toLocaleString 语言
 * @param {string} [opts.fallback='未知'] 无效/缺失值的回退文案
 * @param {boolean} [opts.markExpired=false] 到期时间已过 → 追加「(已过期)」
 * @param {number} [opts.now] 判断过期用的当前毫秒时间(默认 Date.now();注入以保确定性测试)
 * @returns {string} 本地化时间字符串(可能带「(已过期)」)或回退文案;绝不返回 "Invalid Date"
 */
function formatAuthTimestamp(value, opts = {}) {
  const locale = opts.locale || 'zh-CN';
  const fallback = opts.fallback !== undefined ? opts.fallback : '未知';
  try {
    const d = _toValidDate(value);
    if (!d) return fallback;
    let text = d.toLocaleString(locale);
    if (typeof text !== 'string' || text.toLowerCase().includes('invalid')) return fallback;
    if (opts.markExpired) {
      const now = typeof opts.now === 'number' ? opts.now : Date.now();
      if (d.getTime() < now) text += ' (已过期)';
    }
    return text;
  } catch {
    return fallback;
  }
}

/**
 * 为历史/缺失 expiresAt 的会话派生到期时间。
 * @param {*} expiresAt 已存的到期时间(优先使用,若有效)
 * @param {*} loginAt 登录时间
 * @param {number} maxAgeMs 会话最大存活毫秒(如 7*24*3600*1000)
 * @returns {string|null} ISO 到期时间字符串;无法派生 → null。绝不抛。
 */
function deriveSessionExpiry(expiresAt, loginAt, maxAgeMs) {
  try {
    const existing = _toValidDate(expiresAt);
    if (existing) return existing.toISOString();
    const base = _toValidDate(loginAt);
    if (!base) return null;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null;
    return new Date(base.getTime() + maxAgeMs).toISOString();
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  formatAuthTimestamp,
  deriveSessionExpiry,
};
