'use strict';

/**
 * selfHealingWrapper.js — 自愈中间件：为任意异步函数提供瞬时错误自动重试。
 *
 * 为什么存在:流式处理、网络调用、JSON 解析等场景常遇到瞬时错误(截断、抖动、畸形 fragment),
 * 重试一次往往就能成功。把"判断瞬时 → 重试 → 降级"的逻辑收敛到一处,避免每个调用点各自实现。
 *
 * 契约 (CONTRACT):纯叶子 + 零 IO + 确定性 + 绝不抛 + env 门控(KHY_SELF_HEALING,默认开)。
 *   fail-soft:包装器自身任何异常都透传原始结果,绝不因自愈逻辑本身引入新故障。
 *
 * 与既有件的关系:
 *   - chatErrorGuard.js:本模块提供重试机制,chatErrorGuard 提供兜底结果
 *   - retryWithBackoff.js:本模块面向单次瞬时重试,retryWithBackoff 面向有界退避重试
 *   - circuitBreaker.js:本模块处理请求级瞬时错误,circuitBreaker 处理服务级故障隔离
 */

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BASE_DELAY_MS = 100;

// 瞬时错误类型集合 — 这些错误重试有意义
const RETRYABLE_TYPES = new Set([
  'parse_error',    // JSON 解析失败(截断/畸形)
  'network',        // 网络抖动(ECONNRESET/ETIMEDOUT)
  'timeout',        // 请求超时
  'server_error',   // 服务端瞬时错误(500/502/503)
  'rate_limit',     // 速率限制(可退避重试)
  'overloaded',     // 服务过载
  'empty',          // 空响应(可能是瞬时)
]);

/**
 * 判断错误是否为瞬时(可重试)类型。
 * @param {*} err - 错误对象或分类结果
 * @returns {boolean}
 */
function isRetryableError(err) {
  if (!err) return false;
  // 直接有 retryable 标记
  if (err.retryable === true) return true;
  // 有 type 字段且在瞬时集合中
  if (err.type && RETRYABLE_TYPES.has(err.type)) return true;
  // SyntaxError(通常是 JSON 解析失败)
  if (err.constructor && err.constructor.name === 'SyntaxError') return true;
  // 消息模式匹配
  const msg = String(err.message || err || '').toLowerCase();
  if (/unexpected token.*in json|is not valid json|json\s+at\s+position/.test(msg)) return true;
  if (/econnreset|econnrefused|etimedout|socket hang|network/.test(msg)) return true;
  if (/timeout|timed out|deadline/.test(msg)) return true;
  if (/temporarily unavailable|service unavailable|bad gateway/.test(msg)) return true;
  return false;
}

/**
 * 判断自愈中间件是否启用。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_SELF_HEALING;
    if (raw == null) return true; // 默认开
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  } catch {
    return true; // fail-safe: 默认启用
  }
}

/**
 * 计算重试延迟(固定 + 轻微抖动,避免惊群)。
 * @param {number} attempt - 当前重试次数(从 0 开始)
 * @param {number} baseMs - 基础延迟毫秒
 * @returns {number}
 */
function computeDelayMs(attempt, baseMs = DEFAULT_BASE_DELAY_MS) {
  // 固定延迟 + ±25% 抖动
  const jitter = baseMs * 0.25 * (Math.random() * 2 - 1);
  return Math.max(0, baseMs * attempt + jitter);
}

/**
 * 为异步函数提供自愈能力(瞬时错误自动重试)。
 *
 * @param {Function} fn - 要包装的异步函数
 * @param {object} [options]
 * @param {number} [options.maxRetries=1] - 最大重试次数
 * @param {number} [options.baseDelayMs=100] - 基础延迟毫秒
 * @param {Function} [options.isRetryable] - 自定义判断函数(err) => boolean
 * @param {Function} [options.onRetry] - 重试回调(err, attempt)
 * @param {Function} [options.onRetrySuccess] - 重试成功回调(err, attempt)
 * @param {Function} [options.onRetryExhausted] - 重试耗尽回调(err, attempts)
 * @returns {Function} 包装后的函数
 */
function withSelfHealing(fn, options = {}) {
  if (typeof fn !== 'function') {
    return fn;
  }
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    isRetryable = isRetryableError,
    onRetry = null,
    onRetrySuccess = null,
    onRetryExhausted = null,
  } = options;
  // 包装后的函数 — 透传所有参数
  return async function selfHealingWrapper(...args) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn(...args);
        // 重试成功后通知
        if (attempt > 0 && typeof onRetrySuccess === 'function') {
          try {
            onRetrySuccess(lastErr, attempt);
          } catch {
            /* callback must not break flow */
          }
        }
        return result;
      } catch (err) {
        lastErr = err;
        // 还有重试预算且错误是瞬时的
        if (attempt < maxRetries && isRetryable(err)) {
          if (typeof onRetry === 'function') {
            try {
              onRetry(err, attempt + 1);
            } catch {
              /* callback must not break flow */
            }
          }
          // 短暂延迟后退避
          const delay = computeDelayMs(attempt, baseDelayMs);
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
          }
          continue;
        }
        // 不可重试或预算耗尽 — 抛出
        if (attempt >= maxRetries && typeof onRetryExhausted === 'function') {
          try {
            onRetryExhausted(err, attempt);
          } catch {
            /* callback must not break flow */
          }
        }
        throw err;
      }
    }
    // 理论上不会到达这里,但 fail-safe
    throw lastErr || new Error('selfHealing: unexpected exhaustion');
  };
}

/**
 * 同步版本 — 为同步函数提供自愈能力。
 * @param {Function} fn
 * @param {object} [options]
 * @returns {Function}
 */
function withSelfHealingSync(fn, options = {}) {
  if (typeof fn !== 'function') {
    return fn;
  }
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    isRetryable = isRetryableError,
    onRetry = null,
  } = options;
  return function selfHealingSyncWrapper(...args) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return fn(...args);
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && isRetryable(err)) {
          if (typeof onRetry === 'function') {
            try {
              onRetry(err, attempt + 1);
            } catch {
              /* callback must not break flow */
            }
          }
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('selfHealingSync: unexpected exhaustion');
  };
}

module.exports = {
  withSelfHealing,
  withSelfHealingSync,
  isRetryableError,
  isEnabled,
  computeDelayMs,
  RETRYABLE_TYPES,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
};
