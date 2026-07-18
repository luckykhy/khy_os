'use strict';

/**
 * gatewayIdleTimeoutPolicy.js — 纯叶子:决定启动器(bin/khy.js)给网关看门狗写入的
 * idle/stall(硬)超时默认值,修「中段超时现象」——长思考 / 首 token 慢 / 下一次模型调用
 * 先吞巨大工具结果时,20 秒无内容 chunk 就被误判「流已停滞」中断整个 turn。
 *
 * 背景(已逐行核实):
 *   bin/khy.js:903-904 把 KHY_GATEWAY_TIMEOUT_MS='45000'(喂 stall/硬看门狗)、
 *   KHY_GATEWAY_IDLE_TIMEOUT_MS='20000'(idle 窗口)硬设为极短默认。cli/ai.js 的
 *   _generateWithGateway 里 idle poll 只被**内容类回调**刷新 lastActivityTs,思考/吞大
 *   工具结果这类「连接健康但无内容」的间隙被当成停滞 → abort。且 poll 仅在
 *   `idle > 0 && idle < stall` 时布防,故两个窗口必须一起抬,否则只抬 idle 会让 poll
 *   静默失效、转由 45s 的 stall 看门狗更早 abort。
 *
 * 契约:零 IO(只经 flagRegistry 读 env)、绝不抛、纯函数、确定性。
 * 门控 KHY_GATEWAY_IDLE_TIMEOUT_POLICY(默认开):
 *   开   → launcherTimeoutDefaults 返回 ON_DEFAULTS(idle 60s / hard 180s,CC 量级),
 *          从源头消除 20s 误触发;300s 级真·停滞兜底与 KHY_GATEWAY_HARD_TIMEOUT 墙钟不动。
 *   关   → LEGACY_DEFAULTS(idle 20s / hard 45s),与今日 bin/khy.js 写死值逐字节等价。
 *   异常 → 同样回退 LEGACY_DEFAULTS(fail-soft:与今日行为一致)。
 *
 * 不变式:ON.idleTimeoutMs < ON.hardTimeoutMs(60000 < 180000),满足 ai.js:2651 的
 * poll 布防条件 `idle > 0 && idle < stall`,门开后 idle poll 仍正常工作。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 门开:CC 量级的内容间隙窗口。hard=stall 看门狗,idle=无内容中断窗口。
const ON_DEFAULTS = Object.freeze({ hardTimeoutMs: 180000, idleTimeoutMs: 60000 });
// 门关 / 异常:与今日 bin/khy.js:903-904 写死值逐字节等价。
const LEGACY_DEFAULTS = Object.freeze({ hardTimeoutMs: 45000, idleTimeoutMs: 20000 });

function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('./flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_GATEWAY_IDLE_TIMEOUT_POLICY', e);
  } catch {
    const raw = e && e.KHY_GATEWAY_IDLE_TIMEOUT_POLICY;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

/**
 * 启动器应写入的网关超时默认值。
 * @param {object} [env]
 * @returns {{ hardTimeoutMs: number, idleTimeoutMs: number }}
 *   门开 → ON_DEFAULTS 的浅拷贝;门关 / 异常 → LEGACY_DEFAULTS 的浅拷贝。
 */
function launcherTimeoutDefaults(env) {
  try {
    const src = isEnabled(env) ? ON_DEFAULTS : LEGACY_DEFAULTS;
    return { hardTimeoutMs: src.hardTimeoutMs, idleTimeoutMs: src.idleTimeoutMs };
  } catch {
    return { hardTimeoutMs: LEGACY_DEFAULTS.hardTimeoutMs, idleTimeoutMs: LEGACY_DEFAULTS.idleTimeoutMs };
  }
}

module.exports = { isEnabled, launcherTimeoutDefaults, ON_DEFAULTS, LEGACY_DEFAULTS };
