'use strict';

/**
 * nativeAffinityRouter.js — 原生亲和路由器（§3.3）。
 *
 * 核心意图统一、执行路径分裂的「分裂闸口」：把一个平台无关的意图（open_url / monitor_process）
 * 按环境指纹派发到该环境最锋利的原生工具。三条铁律刻进路由逻辑：
 *
 *   防呆③ 无指纹（或指纹未识别）→ 拒绝路由，绝不盲调任何平台特异性 API。
 *   防呆① 该环境无对应原生器官（表中缺位）→ 判定「器官空洞」交淬火，**绝不**回退到一套
 *         跨平台统一低效 API。Polyfill 在本架构里是被废弃的反模式。
 *   防呆⑤ 该环境某原生特长已被熔断（breaker 标记）→ 不再派发该特长，降级为通用安全方案，
 *         并透出「已有回滚需求」信号。
 *
 * 纯函数、表驱动、无可变状态：同一 (intent, fingerprint) 在任何宿主机上路由结果一致
 * （防呆④）；唯一外部读取是 breaker 的熔断态查询，且只读不写。
 */

const { affinityFor } = require('./platformIds');

/** 通用安全降级路径（防呆⑤）：原生特长熔断后退守的最小、只读、不触底层的保守执行。 */
const SAFE_DEGRADED = Object.freeze({ tool: 'generic-safe(只读/通用最小实现)', kind: 'safe-fallback' });

const ROUTE_STATUS = Object.freeze({
  NATIVE: 'native',             // 命中原生器官，派发成功
  ORGAN_VOID: 'organ-void',     // 器官空洞 → 需淬火新生（绝非 Polyfill）
  NO_FINGERPRINT: 'no-fingerprint', // 无/未识别指纹 → 拒绝盲调
  DEGRADED_SAFE: 'degraded-safe',   // 特长已熔断 → 降级通用安全
});

class NativeAffinityRouter {
  /**
   * @param {object} [opts]
   * @param {object} [opts.breaker]  特长熔断器（只读查询 isFused(platform, specialty)）；可选
   */
  constructor(opts = {}) {
    this.breaker = opts.breaker || null;
  }

  /**
   * 把意图路由到指纹环境的原生执行路径。永不抛、永不臆造。
   * @param {string} intent       核心意图（open_url / monitor_process …）
   * @param {object} fingerprint  EnvFingerprintScanner.scan() 产物
   * @returns {{status:string, intent:string, platform:string, native:boolean,
   *            tool?:string, kind?:string, fallback?:string, specialty?:string, reason:string}}
   */
  route(intent, fingerprint) {
    // 防呆③：没有（或未识别）指纹，绝不盲调平台特异性 API。
    if (!fingerprint || !fingerprint.recognized || !fingerprint.platform || fingerprint.platform === 'unknown') {
      return {
        status: ROUTE_STATUS.NO_FINGERPRINT, intent, platform: (fingerprint && fingerprint.platform) || 'unknown',
        native: false, reason: '缺少已识别的环境指纹——禁止盲调平台特异性 API（防呆③），先刺探再执行。',
      };
    }

    const platform = fingerprint.platform;
    const subTable = affinityFor(intent);
    const native = subTable ? subTable[platform] : undefined;

    // 防呆①：该环境无此原生器官 = 器官空洞，交淬火长出新原生器官，绝不退回统一 Polyfill。
    if (!native) {
      return {
        status: ROUTE_STATUS.ORGAN_VOID, intent, platform, native: false,
        specialty: `${intent}@${platform}`,
        reason: subTable
          ? `${platform} 缺少意图「${intent}」的原生器官——判定器官空洞，触发特长淬火（防呆①：绝不 Polyfill）。`
          : `未知意图「${intent}」在 ${platform} 无亲和登记——判定器官空洞，触发特长淬火。`,
      };
    }

    const specialty = `${intent}@${platform}`;

    // 防呆⑤：该原生特长已熔断 → 不再派发，降级通用安全方案。
    if (this.breaker && this.breaker.isFused(platform, specialty)) {
      return {
        status: ROUTE_STATUS.DEGRADED_SAFE, intent, platform, native: false, specialty,
        tool: SAFE_DEGRADED.tool, kind: SAFE_DEGRADED.kind,
        reason: `原生特长 ${specialty} 已被熔断（曾引发安全降级/崩溃），降级为通用安全方案（防呆⑤）。`,
      };
    }

    // 命中原生器官：执行路径分裂落点。
    return {
      status: ROUTE_STATUS.NATIVE, intent, platform, native: true, specialty,
      tool: native.tool, kind: native.kind, fallback: native.fallback || null,
      reason: `${platform} 原生亲和命中：意图「${intent}」→ ${native.tool}（${native.kind}）。`,
    };
  }
}

module.exports = { NativeAffinityRouter, ROUTE_STATUS, SAFE_DEGRADED };
