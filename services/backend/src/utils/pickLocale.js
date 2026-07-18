'use strict';

/**
 * pickLocale.js — 「按是否含 CJK 汉字判 zh/en」语言判定单一真源(纯)。
 *
 * 收敛 src/services 下 4 处 body 逐字节相同的私有 helper:
 *   `/[一-鿿]/.test(String(text || '')) ? 'zh' : 'en'`
 * (cacheMetricsTruth · deliverySummaryFormat · modelIdentityTruth · visionRoutingTruth ·
 *  四者皆经 module.exports shorthand 导出):
 *   文本含 U+4E00–U+9FFF(CJK 统一表意文字)任一字符 → 'zh',否则 'en'。
 *
 * **刻意不收敛(不可互委)**:
 *   - 判更宽 unicode 段(扩展区/假名/谚文)或返回 locale 码不同('zh-CN'/'zho')的变体。
 *   - 依 count / 比例阈值而非「含任一即 zh」的变体。
 *
 * 契约:纯函数、确定性、不 mutate。正则**无 g 标志**(无 lastIndex 状态·可安全复用单例)。
 *   `|| ''` 令 falsy → 判 'en'(空文本默认英文)。
 *
 * 各消费方保留同名本地 `const pickLocale = require('.../pickLocale')`(shorthand 导出续存)→ 调用点逐字节不变。
 */

function pickLocale(text) {
  return /[一-鿿]/.test(String(text || '')) ? 'zh' : 'en';
}

module.exports = pickLocale;
