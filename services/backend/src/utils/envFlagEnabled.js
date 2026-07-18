'use strict';

/**
 * envFlagEnabled.js — 「三态 env 开关(显式 on/off·空→默认)」单一真源(纯)。
 *
 * 收敛 3 处 body 逐字节相同的 helper:
 *   空/undefined/null→defaultValue;trim+lowercase 后
 *   ∈{1,true,on,yes,y}→true;∈{0,false,off,no,n}→false;其它→defaultValue。
 *   (capabilityMatrix/predicates.envFlagEnabled ·
 *    capabilityAssessment.envFlagEnabled · toolUseLoopCore._envFlagEnabled)。
 *
 * **刻意不收敛(不可互委)**:
 *   - auditFixLoop/triggerGate._envFlagEnabled(raw, dflt):`!/^(0|false|off|no)$/i` —
 *     签名与语义各异(默认为「非 off 即 on」·无 yes/y 接受集·无空串默认参),不并入。
 *   - baseSelfCheckService._envBool 等未识别→false 而非 fallback 的变体(见 C 组)。
 *
 * 契约:纯函数、确定性、不 mutate。默认参 `defaultValue = true`——各消费方均以此调用。
 *
 * 各消费方保留同名本地 `const NAME = require('.../envFlagEnabled')`→ 调用点逐字节不变
 *   (predicates.js 经 `module.exports = { envFlagEnabled, ... }` shorthand 再导出,委托保绑定)。
 */

function envFlagEnabled(rawValue, defaultValue = true) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return defaultValue;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no', 'n'].includes(normalized)) return false;
  return defaultValue;
}

module.exports = envFlagEnabled;
