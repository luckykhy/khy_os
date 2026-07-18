'use strict';

/**
 * trimLowerNullish.js — 「nullish-coerce + trim + lowercase」规范化键单一真源(纯)。
 *
 * 收敛 src/services 下 5 处 body 逐字节相同的私有 helper:
 *   `String(s == null ? '' : s).trim().toLowerCase()`
 * (cacheMetricsTruth._key · gateway/modelToolingCapability._norm ·
 *  gateway/toolCallingProbe._norm · gateway/visionCapability._normModel ·
 *  gateway/adapterVisionCapability._normKey):
 *   null/undefined → ''(**nullish**,非 falsy);其余 String 强转后去首尾空白、转小写。
 *
 * **刻意不收敛(不可互委)**:
 *   - utils/normLower —— body 相同但**外裹 try/catch**(String 强转抛出的异形对象 → 返 ''),
 *     本 util 裸 return 会**向上抛**;对可抛输入行为分叉(同 R38/R39 裸参 vs 强转纪律)。
 *   - utils/trimLowerCase(R29)—— `String(v || '')` 是 **falsy**-coerce(`0`→''、`false`→''),
 *     本 util nullish 保留 `0`→'0'、`false`→'false',对 0/false/NaN/'' 分叉。
 *   - utils/toLowerCaseSafe —— 同 nullish 但**无 .trim()**。
 *   - utils/trimLowerStripUnderscores(R41)—— 额外 `.replace(/_/g,'')` 去下划线。
 *
 * 契约:纯函数、确定性、不 mutate、不吞异常(异形对象 String 强转抛出向上传递)。
 *
 * 各消费方保留同名本地 `const _localName = require('.../trimLowerNullish')` → 调用点逐字节不变。
 */

function trimLowerNullish(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

module.exports = trimLowerNullish;
