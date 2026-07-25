'use strict';

/**
 * _gatewayHardDeadline.js — 给 aiGateway 的交付级联加一道**真·墙钟硬死线** + **级联总次数封顶**,
 * 根治「网关卡死 9 分钟、失败 220/1437、ESC 打不断」的病态。
 *
 * 为什么要这个:aiGateway 现有的每一道防线都是**空闲(idle)看门狗**——每适配器 idle 超时、
 * 网关级 idle 看门狗——全靠 `_touchGatewayActivity()` 在每个 chunk/状态上重置计时。而重试级联
 * 自己不断吐 `失败 N/M` 状态 → idle 计时被自己的状态输出永久重置 → **永不触发**。同时重试级联
 * (外层适配器循环 × 密钥池 × 单次尝试,叠加 strict 放宽后从头重走整张适配器表)**没有聚合总次数
 * 上限、也没有跨重试的总墙钟死线** → 1437 次请求相乘膨胀而来。
 *
 * 本叶子提供两个正交兜底:
 *   1) 墙钟硬死线:基于**一次性捕获的 startedAt**(与 touch 活动无关),到点即判定 exceeded → 调用方
 *      abort gatewayAbort(经 linked controller 传播到在途适配器调用,真正取消)。免疫「状态输出重置
 *      计时」的病根。
 *   2) 级联总次数封顶:一个跨所有重试维度的聚合计数上限,让病态 churn 更快收敛。
 *
 * 「让模型/调用方自己设」:硬死线优先取调用方传入的 optionsTimeoutMs(clamp),其次 env,最后按
 * 任务规模的保守默认——健康长流不误杀,只兜住病态。
 *
 * 契约:除读取 env 与注入的时钟外零副作用、绝不抛。时钟经参数注入(默认 Date.now)以便测试用
 * 确定性时钟。**门控关 ⇒ createGatewayDeadline 返 null 哨兵 ⇒ 调用方逐字节回退今日无硬死线行为;
 * resolveMaxTotalAttempts 关 ⇒ 返 Infinity(今日无聚合上限)。**
 *
 * 门控(dogfood flagRegistry):
 *   KHY_GATEWAY_HARD_TIMEOUT        默认 on —— 硬死线总开关;关 → createGatewayDeadline 返 null。
 *   KHY_GATEWAY_HARD_TIMEOUT_MS     numeric —— 显式覆盖硬死线毫秒(clamp[5000, 1800000])。
 *   KHY_GATEWAY_MAX_TOTAL_ATTEMPTS  numeric 默认 48 —— 级联总次数上限(clamp[4, 500]);
 *                                   显式设 0/off/false/no → Infinity(关闭封顶,今日行为)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 任务规模的保守硬死线默认(毫秒):健康长流不误杀,只兜住 churn 病态。
const HARD_TIMEOUT_DEFAULTS = { large: 600000, small: 180000, normal: 300000 };
const HARD_TIMEOUT_MIN = 5000;
const HARD_TIMEOUT_MAX = 1800000;

// 收敛到 utils/resolveEnv 单一真源(逐字节委托,调用点不变)
const _env = require('../../utils/resolveEnv');

function _isEnabled(name, env) {
  const e = _env(env);
  try {
    const flagRegistry = require('../flagRegistry');
    return flagRegistry.isFlagEnabled(name, e);
  } catch {
    const raw = e && e[name];
    if (raw === undefined || raw === null) return true;
    return !OFF_VALUES.includes(String(raw).trim().toLowerCase());
  }
}

function _clampTimeout(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < HARD_TIMEOUT_MIN) return HARD_TIMEOUT_MIN;
  if (n > HARD_TIMEOUT_MAX) return HARD_TIMEOUT_MAX;
  return n;
}

/** 硬死线总开关。默认 on;关 → createGatewayDeadline 返 null。 */
function isGatewayHardTimeoutEnabled(env) {
  return _isEnabled('KHY_GATEWAY_HARD_TIMEOUT', env);
}

/**
 * 解析硬死线毫秒。优先级:调用方 optionsTimeoutMs > 显式 env KHY_GATEWAY_HARD_TIMEOUT_MS >
 * 任务规模保守默认。全部 clamp[5000, 1800000]。
 *
 * @param {object} [opts]
 * @param {number} [opts.optionsTimeoutMs] 调用方/模型显式传入
 * @param {{isLargeTask?:boolean, isSmallTask?:boolean}} [opts.taskScale]
 * @param {object} [opts.env]
 * @returns {number}
 */
function resolveGatewayHardTimeoutMs(opts) {
  const o = opts || {};
  const e = _env(o.env);

  // 1) 调用方/模型显式旋钮优先。
  const fromOptions = _clampTimeout(Number(o.optionsTimeoutMs));
  if (fromOptions != null) return fromOptions;

  // 2) 显式 env 覆盖(仅当真的设了值,否则落到任务规模默认)。
  const rawEnv = e && e.KHY_GATEWAY_HARD_TIMEOUT_MS;
  if (rawEnv !== undefined && rawEnv !== null && String(rawEnv).trim() !== '') {
    const parsed = Number.parseInt(String(rawEnv).trim(), 10);
    const clamped = _clampTimeout(parsed);
    if (clamped != null) return clamped;
  }

  // 3) 任务规模保守默认。
  const scale = o.taskScale || {};
  if (scale.isLargeTask) return HARD_TIMEOUT_DEFAULTS.large;
  if (scale.isSmallTask) return HARD_TIMEOUT_DEFAULTS.small;
  return HARD_TIMEOUT_DEFAULTS.normal;
}

/**
 * 创建墙钟硬死线判定器。门控关 → 返 null(调用方逐字节回退今日无硬死线路径)。
 *
 * @param {object} [opts]
 * @param {number} [opts.optionsTimeoutMs]
 * @param {{isLargeTask?:boolean, isSmallTask?:boolean}} [opts.taskScale]
 * @param {object} [opts.env]
 * @param {() => number} [opts.nowFn] 时钟注入(默认 Date.now),测试用确定性时钟。
 * @returns {{ deadlineMs:number, startedAt:number, exceeded:(now?:number)=>boolean, remainingMs:(now?:number)=>number } | null}
 */
function createGatewayDeadline(opts) {
  try {
    const o = opts || {};
    const e = _env(o.env);
    if (!isGatewayHardTimeoutEnabled(e)) return null;
    const clock = typeof o.nowFn === 'function' ? o.nowFn : Date.now;
    const deadlineMs = resolveGatewayHardTimeoutMs({
      optionsTimeoutMs: o.optionsTimeoutMs,
      taskScale: o.taskScale,
      env: e,
    });
    const startedAt = clock();
    const deadline = startedAt + deadlineMs;
    return {
      deadlineMs,
      startedAt,
      exceeded(now) {
        try {
          const t = Number.isFinite(now) ? now : clock();
          return t >= deadline;
        } catch { return false; }
      },
      remainingMs(now) {
        try {
          const t = Number.isFinite(now) ? now : clock();
          return Math.max(0, deadline - t);
        } catch { return 0; }
      },
    };
  } catch {
    return null; // fail-soft:构造失败 ⇒ 无硬死线(今日行为),绝不拖垮网关
  }
}

/**
 * 解析级联总次数上限。默认 48;显式设 0/off/false/no → Infinity(关闭封顶,今日无上限行为)。
 * @param {object} [env]
 * @returns {number} 正整数上限,或 Infinity 表示不封顶。
 */
function resolveMaxTotalAttempts(env) {
  const e = _env(env);
  try {
    const raw = e && e.KHY_GATEWAY_MAX_TOTAL_ATTEMPTS;
    // 显式关闭 → 不封顶(逐字节回退今日行为)。
    if (raw !== undefined && raw !== null && OFF_VALUES.includes(String(raw).trim().toLowerCase())) {
      return Infinity;
    }
    const flagRegistry = require('../flagRegistry');
    const v = flagRegistry.resolveNumeric('KHY_GATEWAY_MAX_TOTAL_ATTEMPTS', e);
    if (Number.isFinite(v) && v >= 4) return v;
  } catch { /* fall through */ }
  const rawN = Number.parseInt((e && e.KHY_GATEWAY_MAX_TOTAL_ATTEMPTS) || '', 10);
  if (Number.isFinite(rawN) && rawN >= 4) return Math.min(500, rawN);
  return 48;
}

/**
 * 是否已达级联总次数上限。count >= 上限 → true(调用方据此终止级联)。
 * @param {number} count 迄今累计的适配器尝试次数
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldStopForAttemptCap(count, env) {
  try {
    const cap = resolveMaxTotalAttempts(env);
    if (!Number.isFinite(cap)) return false; // 不封顶
    return Number.isFinite(count) && count >= cap;
  } catch {
    return false; // fail-soft:判定失败 ⇒ 不终止(今日行为)
  }
}

module.exports = {
  HARD_TIMEOUT_DEFAULTS,
  HARD_TIMEOUT_MIN,
  HARD_TIMEOUT_MAX,
  isGatewayHardTimeoutEnabled,
  resolveGatewayHardTimeoutMs,
  createGatewayDeadline,
  resolveMaxTotalAttempts,
  shouldStopForAttemptCap,
};
