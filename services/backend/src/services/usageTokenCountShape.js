'use strict';

/**
 * usageTokenCountShape.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 usageFormatter.formatTokenCount 的「舍入越界仍标旧单位」缺陷:该函数用
 * **舍入前**的商判断单位档,却用**舍入后**的值拼串,于是落在单位边界正下方的
 * token 数被印成非法/不一致的标签:
 *   - v∈[999500, 999999]:k=v/1000∈[999.5,999.999],`k >= 1_000` 为假 → 落到
 *     `Math.round(k)` 分支 → 舍入到 1000 → 印成 "1000k"(四位数 k,作者行内注释
 *     `// 999,500+ rounds up` 正说明本应升到 "1.0m")。
 *   - v∈[9950?, 9999]:k∈[9.95,9.999],`k >= 10` 为假 → 落到 `k.toFixed(1)`,当浮点使
 *     toFixed(1) 进位到 "10.0"(如 9995/9999)→ 印成 "10.0k"(既带尾随 .0 又本应跨进 >=10 档
 *     显示 "10k")。
 * 两者同属「round-past-threshold」越界:边界正下方的值单位没跟着进位。
 *
 * 本叶子给出**修正后**的格式串(舍入后再定单位档),门控 KHY_USAGE_TOKEN_PROMOTION
 * (默认开)。关(0/false/off/no)/异常/非有限 → 返回 null,调用方逐字节回退到
 * 原 legacy 分支输出("1000k"/"10.0k" 原样),从而门关时逐字节等于历史行为。
 * flagRegistry 优先,失败回退本地 CANON 解析;绝不抛。
 *
 * 严格超集:仅修正边界正下方(v∈toFixed→"10.0" 者 ∪ [999500,999999])的输出,
 * 其余所有输入(0/负/非有限/常规 k/m 档)与 legacy 逐字节相同。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_USAGE_TOKEN_PROMOTION:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function usageTokenPromotionEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_USAGE_TOKEN_PROMOTION', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_USAGE_TOKEN_PROMOTION;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 修正后的 token 计数格式串(单位在**舍入后**再定档,消除边界越界)。
 *   - 门关 / 异常 / 非有限 → 返回 null(调用方回退 legacy 输出);
 *   - 门开 → 返回修正串:
 *       >=1M(含被 k 档舍入进位到 1000k 的 [999500,999999])→ "X.Xm"
 *       [10k,1M) → "Nk"(整数);其中 [9950,9999] 由 "10.0k" 归一为 "10k"
 *       [1k,10k) → "X.Xk"
 *       <1k → 舍入整数串
 * @param {number} [value]
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function shapeTokenCount(value, env = process.env) {
  try {
    if (!usageTokenPromotionEnabled(env)) return null;
    if (value == null || !Number.isFinite(value)) return '0';
    const v = Math.abs(value);

    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;

    if (v >= 1_000) {
      const k = v / 1_000;
      if (k >= 10) {
        const rk = Math.round(k);
        // 舍入后达到 1000k → 升到 m 档(修 "1000k")。
        if (rk >= 1_000) return `${(v / 1_000_000).toFixed(1)}m`;
        return `${rk}k`;
      }
      // k∈[1,10):toFixed(1) 若舍入到 "10.0" 则跨档,归一到整数 "10k"(修 "10.0k")。
      const fixed = k.toFixed(1);
      if (parseFloat(fixed) >= 10) return `${Math.round(parseFloat(fixed))}k`;
      return `${fixed}k`;
    }

    return String(Math.round(v));
  } catch {
    return null;
  }
}

module.exports = {
  usageTokenPromotionEnabled,
  shapeTokenCount,
};
