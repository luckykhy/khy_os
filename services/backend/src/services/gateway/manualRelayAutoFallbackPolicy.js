'use strict';

/**
 * manualRelayAutoFallbackPolicy — 纯叶子:决定「人肉中转通道(relay / clipboard)」
 * 是否应在**自动级联**里被跳过。
 *
 * 背景 / 排障根因(「为什么会出现剪贴板中转模式」):
 *   剪贴板中转(clipboardRelayAdapter)本质是**人肉复制粘贴 + 监听剪贴板**——把提示词写进
 *   系统剪贴板,然后**最长等人 5 分钟**把网页 AI 的回复贴回来;网页中转(webRelayAdapter)
 *   同样要人把提示词粘进网页再把回复贴回。这类**需要人在场**的通道**绝不该作为自动兜底**:
 *   云端通道全部失败后,generate 级联若静默走到它们,用户就会莫名其妙被要求手动复制粘贴。
 *
 *   正确的自动兜底应落到**本地模式(ollama / localLLM)**;云端 + 本地都不可用时应**明确失败
 *   并引导**(见 aiGatewayGenerateMethod 终端失败引导),而不是静默进入人肉中转。
 *
 *   本叶子只做一个纯决策:给定「该通道是否属于 manual-fallback 集合」以及是否被用户**显式指定**,
 *   返回自动级联是否应跳过它。是否属于 manual-fallback 集合由调用方用唯一真源
 *   (DEFAULT_ROUTE_MANUAL_FALLBACK_KEYS)判定后以布尔传入——本叶子不含任何适配器名字面量,
 *   既避免与 SSOT 漂移,也让判定逻辑可独立单测。
 *
 * 设计红线:
 *   - 纯函数、零 IO、**绝不抛**(异常 → 保守回退今日行为:不跳过);
 *   - 无第三方依赖、无适配器名字面量;
 *   - 显式选择(preferredAdapter / forceAdapter 命中该通道)永远放行,不跳过。
 *
 * 门控 KHY_MANUAL_RELAY_NO_AUTO_FALLBACK(默认开;0/false/off/no → 关)。
 * 关门 → 一律不跳过 → 逐字节回退今日「人肉通道仍在自动级联队尾兜底」的行为。
 */

const GATE_FLAG = 'KHY_MANUAL_RELAY_NO_AUTO_FALLBACK';

/**
 * 环境布尔门:缺省 / 空 → dflt;0/false/off/no → false。异常 → false。
 * @param {*} raw
 * @param {boolean} [dflt]
 * @returns {boolean}
 */
// 收敛到 utils/onValueOr 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/onValueOr');

/**
 * 门控 KHY_MANUAL_RELAY_NO_AUTO_FALLBACK:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * 关门表示「不启用本策略」→ 人肉通道回退到今日行为(自动级联仍可兜底)。
 * @param {object} [env]
 * @returns {boolean}
 */
function manualRelayNoAutoFallbackEnabled(env = process.env) {
  return _envOn(env && env[GATE_FLAG], true);
}

/**
 * 判定自动级联是否应跳过某个人肉中转通道。纯函数、绝不抛。
 *
 * @param {object} args
 * @param {boolean} args.isManualFallbackOnly 该通道是否属于 manual-fallback 集合(由调用方用 SSOT 判定)
 * @param {string}  args.adapterKey           当前适配器 key(如 'clipboard' / 'relay')
 * @param {string}  [args.preferredAdapter]   用户显式首选通道(命中 → 放行)
 * @param {string}  [args.forceAdapter]       强制通道(命中 → 放行)
 * @param {object}  [env]
 * @returns {boolean} true = 自动级联应跳过该通道;false = 不跳过(今日行为 / 显式选择 / 非人肉通道)
 */
function shouldSkipManualRelayInAutoCascade(args = {}, env = process.env) {
  try {
    if (!manualRelayNoAutoFallbackEnabled(env)) return false;
    if (!args || !args.isManualFallbackOnly) return false;
    const key = String(args.adapterKey == null ? '' : args.adapterKey).trim().toLowerCase();
    if (!key) return false;
    const preferred = String(args.preferredAdapter == null ? '' : args.preferredAdapter).trim().toLowerCase();
    const forced = String(args.forceAdapter == null ? '' : args.forceAdapter).trim().toLowerCase();
    // 用户显式指定该人肉通道 → 放行(定向路由 / 手动中转随时可用)。
    if (key === preferred || key === forced) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  manualRelayNoAutoFallbackEnabled,
  shouldSkipManualRelayInAutoCascade,
  GATE_FLAG,
};
