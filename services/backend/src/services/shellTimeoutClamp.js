'use strict';

/**
 * shellTimeoutClamp.js — 纯叶子:把 shellCommand 的 timeout/idleTimeout 参数 clamp 到合法区间,
 * 修「弱模型撞 schema max:60000 → 不透明 Invalid tool parameters」缺口。
 *
 * 背景:弱模型对全盘递归被 60s 空闲超时杀掉后,重试时常把 timeout 调大(如 600000)想绕过 60s。
 * 但 shellCommand 的 inputSchema 声明 `timeout.max: 60000`,_baseTool 校验直接拒绝 →
 * ccUserFacingToolError 又把校验错误折叠成不透明的字面 "Invalid tool parameters",弱模型看不出
 * 真因(是 timeout 超上限),只能继续瞎试。而 shellCommand 内部本就 `Math.min(timeout, 60000)`,
 * 所以 schema 的 max 是冗余且有害的守门:与其拒绝,不如把超限值 clamp 成 60s 封顶直接跑。
 *
 * 契约:零 IO(只经 flagRegistry 读 env)、绝不抛、纯函数。
 * 门控 KHY_SHELL_TIMEOUT_CLAMP(默认开):
 *   开 → 返回**浅拷贝**,把 timeout/idleTimeout 中「有限数值」clamp 到 [FLOOR, CEIL];
 *        非数值 / 缺省字段一律不动(不新增字段)。
 *   关 / 异常 → **原样返回入参对象**(逐字节回退:schema max 仍会拒绝超限值,今日行为)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 与 shellCommand.js:369 的内部封顶(60000)对齐;下限给一个合理的最小可运行超时。
const CEIL_MS = 60000;
const FLOOR_MS = 1000;

function _isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('./flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_SHELL_TIMEOUT_CLAMP', e);
  } catch {
    const raw = e && e.KHY_SHELL_TIMEOUT_CLAMP;
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

function _clampField(value) {
  // 只 clamp 有限数值;字符串/undefined/NaN/Infinity 一律返回原值(不改字段形态)。
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value > CEIL_MS) return CEIL_MS;
  if (value < FLOOR_MS) return FLOOR_MS;
  return value;
}

/**
 * 把 params 的 timeout/idleTimeout clamp 到 [FLOOR_MS, CEIL_MS]。
 * @param {object} params 原始工具入参
 * @param {object} [env]
 * @returns {object} 门开→浅拷贝(clamp 后);门关/异常/非对象→原 params
 */
function clampTimeoutParams(params, env) {
  try {
    if (!params || typeof params !== 'object') return params;
    if (!_isEnabled(env)) return params;

    const hasTimeout = typeof params.timeout === 'number' && Number.isFinite(params.timeout);
    const hasIdle = typeof params.idleTimeout === 'number' && Number.isFinite(params.idleTimeout);
    const nextTimeout = hasTimeout ? _clampField(params.timeout) : params.timeout;
    const nextIdle = hasIdle ? _clampField(params.idleTimeout) : params.idleTimeout;

    // 无需改动(两字段都非数值或都已在区间内)→ 返回原对象,零分配、逐字节等价。
    if (nextTimeout === params.timeout && nextIdle === params.idleTimeout) return params;

    const out = { ...params };
    if (hasTimeout) out.timeout = nextTimeout;
    if (hasIdle) out.idleTimeout = nextIdle;
    return out;
  } catch {
    return params; // fail-soft:归一异常 → 原样返回(今日行为)
  }
}

module.exports = { clampTimeoutParams, CEIL_MS, FLOOR_MS };
