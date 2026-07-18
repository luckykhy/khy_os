'use strict';

/**
 * scaleToZeroPolicy — 纯叶子:决定长期部署下的网关常驻进程是否应「降到零」(scale-to-zero)。
 * 零 IO、确定性、绝不抛。移植自 Hermes v0.18.0「Gateway 支持 scale-to-zero,更适合长期部署」。
 *
 * 背景(已逐行核实):
 *   - serviceLifecyclePolicy.js 只管**启动调度**(resident/startup-oneshot/on-demand),无关停/闲置判断。
 *   - gatewayIdleTimeoutPolicy.js 是**单次请求 turn 内**的 idle/stall 看门狗默认值,不是进程级降零。
 *   - daemonManager.daemonStop()/daemonStart() 是现成执行器,但无「闲置到点自动降零」的决策层。
 *   本叶子补上这唯一缺失的**决策**:给定「闲置毫秒 + 在途请求数 + 配置」→ 判定是否应降零 + 冷启预热描述。
 *
 * 契约:
 *   - 零 IO —— 时钟/信号(idleMs、activeRequests)由调用方喂入,叶子只做纯判定(无 Date.now / 无文件)。
 *   - 门控 KHY_GATEWAY_SCALE_TO_ZERO(**opt-in、默认关**)—— 自动停常驻进程有破坏性,须为长期部署显式开启,
 *     语义对齐 KHY_20X_MODE:仅 '1'|'true'|'on' 视为开。关门 → describeScaleDecision 返 reason:'disabled'。
 *   - 闲置窗口 KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS(numeric,默认 900000=15min,clamp[60000, 86400000])。
 *   - 冷启预热沿用现有 KHY_GATEWAY_WARMUP_ON_BOOT(不新造预热门)。
 *   - 绝不抛:全程 try/catch,异常一律保守回退(门关 false / 决策 reason:'error' 且 scaleDown:false)。
 *
 * 诚实边界:本叶子只**决策**,不执行关停;真正的自杀式降零看门狗(常驻进程闲置到点自调 daemonStop())
 * 未接线,避免 daemon 意外死亡。daemonManager.daemonStatus() 仅把本决策作**只读建议**呈现。
 * 无任何模型名字面量。
 */

const KHY_GATEWAY_SCALE_TO_ZERO = 'KHY_GATEWAY_SCALE_TO_ZERO';
const KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS = 'KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS';
const KHY_GATEWAY_WARMUP_ON_BOOT = 'KHY_GATEWAY_WARMUP_ON_BOOT';

const DEFAULT_IDLE_WINDOW_MS = 900000; // 15 min,与 flagRegistry KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS.default 一致

/**
 * 门控 KHY_GATEWAY_SCALE_TO_ZERO —— opt-in(默认关)。仅 '1'|'true'|'on'(去空白小写)→ true。
 * 优先经 flagRegistry(权威),异常 → 内联兜底;任何意外 → false(保守:不自动降零)。
 * @param {object} [env]
 * @returns {boolean}
 */
function scaleToZeroEnabled(env = process.env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../flagRegistry');
    return flagRegistry.isFlagEnabled(KHY_GATEWAY_SCALE_TO_ZERO, e);
  } catch {
    try {
      const raw = e && e[KHY_GATEWAY_SCALE_TO_ZERO];
      if (raw == null) return false;
      const v = String(raw).trim().toLowerCase();
      return v === '1' || v === 'true';
    } catch {
      return false;
    }
  }
}

/**
 * 闲置窗口毫秒 —— 委托 flagRegistry.resolveNumeric(parseInt + 非负 + clamp[min,max] + fail-soft)。
 * 异常 → 默认 900000。
 * @param {object} [env]
 * @returns {number}
 */
function resolveIdleWindowMs(env = process.env) {
  try {
    const flagRegistry = require('../flagRegistry');
    const n = flagRegistry.resolveNumeric(KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS, env);
    return Number.isFinite(n) ? n : DEFAULT_IDLE_WINDOW_MS;
  } catch {
    return DEFAULT_IDLE_WINDOW_MS;
  }
}

/**
 * 冷启是否预热 —— 沿用现有 KHY_GATEWAY_WARMUP_ON_BOOT 的**权威语义**(bootstrap/prefetch.js:111、
 * bin/khy.js:924):默认 'true',仅字面量 'false'(大小写不敏感)关闭。该 flag 未登记进 flagRegistry,
 * 故直接按此语义读,不走 isFlagEnabled(未登记项恒放行,无法兑现 'false' 关闭)。异常 → true(默认开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function warmupOnNextStart(env = process.env) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    return String((e && e[KHY_GATEWAY_WARMUP_ON_BOOT]) || 'true').trim().toLowerCase() !== 'false';
  } catch {
    return true;
  }
}

/**
 * 一次性降零决策。零 IO、绝不抛。
 * @param {{idleMs?:number, activeRequests?:number}} signal 由调用方喂入的进程级信号
 * @param {object} [env]
 * @returns {{eligible:boolean, scaleDown:boolean, reason:string, idleMs:number, idleWindowMs:number, warmupOnNext:boolean}}
 *   reason ∈ 'disabled'|'active-requests'|'within-window'|'idle-exceeded'|'error'
 */
function describeScaleDecision(signal = {}, env = process.env) {
  try {
    const idleWindowMs = resolveIdleWindowMs(env);
    const rawIdle = signal && Number(signal.idleMs);
    const idleMs = Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : 0;
    const rawActive = signal && Number(signal.activeRequests);
    const activeRequests = Number.isFinite(rawActive) && rawActive > 0 ? rawActive : 0;
    const warmupOnNext = warmupOnNextStart(env);

    if (!scaleToZeroEnabled(env)) {
      return { eligible: false, scaleDown: false, reason: 'disabled', idleMs, idleWindowMs, warmupOnNext: false };
    }
    if (activeRequests > 0) {
      return { eligible: true, scaleDown: false, reason: 'active-requests', idleMs, idleWindowMs, warmupOnNext };
    }
    if (idleMs < idleWindowMs) {
      return { eligible: true, scaleDown: false, reason: 'within-window', idleMs, idleWindowMs, warmupOnNext };
    }
    return { eligible: true, scaleDown: true, reason: 'idle-exceeded', idleMs, idleWindowMs, warmupOnNext };
  } catch {
    return { eligible: false, scaleDown: false, reason: 'error', idleMs: 0, idleWindowMs: DEFAULT_IDLE_WINDOW_MS, warmupOnNext: false };
  }
}

module.exports = {
  KHY_GATEWAY_SCALE_TO_ZERO,
  KHY_GATEWAY_SCALE_TO_ZERO_IDLE_MS,
  KHY_GATEWAY_WARMUP_ON_BOOT,
  DEFAULT_IDLE_WINDOW_MS,
  scaleToZeroEnabled,
  resolveIdleWindowMs,
  warmupOnNextStart,
  describeScaleDecision,
};
