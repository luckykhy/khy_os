'use strict';

/**
 * isOffValue.js — 「值读作关闭/空」判定单一真源。
 *
 * 收敛 src/ 下 5 处语义相同的私有 `_falsy(v)`(两 byte 变体仅局部变量名 s/x 不同):
 *   keybindings/keybindingCatalog · terminal/terminalSetupPlan · skills/verifierScaffoldPlan ·
 *   issue/issueReport · config/sandboxToggleState。
 * 语义:trim+lowercase 后 ∈ {'', '0', 'false', 'off', 'no'} → true。
 * 用途:default-ON 门控惯用法 `!isOffValue(env.X === undefined ? 'true' : env.X)`——未设→'true'→非
 *   off→启用;显式设 off 值→关闭。
 *
 * **刻意区分**:与 utils/parseBoolean 不同——本判定把空串 '' 也算 off(parseBoolean 空串走 fallback);
 *   且这是「内联字面量自足」的 off-set,不读任何模块局部常量(区别于 C 组 `_off`/`_flagOn` 读模块
 *   `_FALSY`/`OFF_VALUES`,那类委托会孤立常量制造 drift hazard)。
 *
 * 契约:纯函数、确定性、恒返回布尔、不 mutate、绝不抛。
 *
 * 各消费方保留同名本地 `const _falsy = require('.../isOffValue')` → 调用点逐字节不变。
 */

function isOffValue(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no';
}

module.exports = isOffValue;
