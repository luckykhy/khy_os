'use strict';

/**
 * toStr.js — 纯 util:「值 → 字符串」强转家族的单一真源。
 *
 * 收敛 src/ 下三个私有 `_str(v)` 簇(共 11 处):
 *   - toStr     :`v == null ? '' : String(v)`  —— null/undefined → 空串,其余 String 强转。
 *                 覆盖两簇:
 *                   · `typeof v === 'string' ? v : v == null ? '' : String(v)`(×5·对所有输入输出等价)
 *                   · `v == null ? '' : String(v)`(×3·逐字节)
 *   - toStrSafe :toStr 的 fail-soft 版(try/catch,防御 toString/valueOf 抛错的对象 → '')。(×3)
 *
 * **刻意区分**:`toStr` 不吞异常——若入参是 toString 抛错的对象,它会抛,与被收敛的两簇原体
 *   一致(它们本就无 try/catch)。只有 `toStrSafe` 兜错。切勿给 toStr 加 try/catch(会放宽行为)。
 *
 * 契约:确定性、不 mutate。区别于:utils/cleanText(trim)· utils/normLower(trim+lowercase)。
 *
 * 各消费方保留同名本地 `const _str = require('.../toStr').toStr|toStrSafe` → 调用点逐字节不变。
 */

function toStr(v) {
  return v == null ? '' : String(v);
}

function toStrSafe(v) {
  try { return v == null ? '' : String(v); } catch { return ''; }
}

module.exports = { toStr, toStrSafe };
