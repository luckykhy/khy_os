'use strict';

/**
 * onValueOr.js — 「值型『默认开』布尔解析器」单一真源(gateway/* 家族)。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_envOn(raw, dflt = true)`
 * (services/gateway/glmVisionImageDownscale · glmVisionTextBudget · manualRelayAutoFallbackPolicy):
 *   收**原始值**(非按名读 env);null 或 trim 后为空 → dflt;
 *   否则 trim+lowercase,∈ {'0','false','off','no'} → false,其余 → true;
 *   任何异常 → false(fail-safe 关)。
 *
 * **与 utils/envOnByName 的区别(刻意分开)**:envOnByName 是**按名读 env**(env,key)、严格比较不 trim、
 *   off-set 无 'no'、无 dflt 参;本 util 是**值型**(收原始值)、trim+lowercase、off-set 含 'no'、带 dflt。
 *   两者签名与口径均不同,不可互相委托。
 *
 * **与 utils/isOffValue 的区别**:isOffValue 把空串算 off(返 true);本 util 空串走 dflt(默认开)。
 *   为保等价证明干净、避免耦合漂移,内联 off-set 而非委托 isOffValue。
 *
 * 契约:确定性、不 mutate、恒返布尔。纯值计算(不读 process.env)。
 *
 * 各消费方保留同名本地 `const _envOn = require('../../utils/onValueOr')` → 调用点逐字节不变。
 */

function onValueOr(raw, dflt = true) {
  try {
    if (raw == null || String(raw).trim() === '') return dflt;
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

module.exports = onValueOr;
