'use strict';

/**
 * envOnByName.js — 「按名读 env 的『默认开』布尔标志」单一真源(search/* 家族)。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_envOn(env, key)`
 * (services/search/searchNecessity · searchSourceDiscovery · searchFreshness):
 *   读 `(env || process.env || {})[key]`;
 *   **未设(undefined)→ true(默认开)**;否则仅当值严格 === '0' | 'false' | 'off' 才关。
 *
 * **注意语义**:default-ON。不 trim、不 lowercase——'OFF' / ' off ' 视为「开」(保留原始严格比较)。
 *   off-set 仅 {'0','false','off'}(不含 'no',与 gateway/* 的 `_envOn(raw,dflt)` 值型变体不同)。
 *
 * **刻意不收敛**:services/gateway 的 `_envOn(raw, dflt = true)` 是**值型**(收原始值非按名读 env)、
 *   带 try/catch、trim+lowercase、off-set 含 'no'——签名与语义均不同,留原样(C 组,另行收敛)。
 *
 * 契约:确定性、不 mutate、恒返布尔。读全局 process.env 作兜底(非纯·name-based env 读取惯用)。
 *
 * 各消费方保留同名本地 `const _envOn = require('../../utils/envOnByName')` → 调用点逐字节不变。
 */

function envOnByName(env, key) {
  const v = (env || process.env || {})[key];
  return v === undefined || !(v === '0' || v === 'false' || v === 'off');
}

module.exports = envOnByName;
