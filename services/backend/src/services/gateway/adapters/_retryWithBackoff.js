'use strict';

/**
 * _retryWithBackoff.js — Unified retry logic with exponential backoff.
 *
 * Replaces adapter-specific retry loops in relay/claude/codex adapters.
 * Learned from Claude Code's retry patterns and relayApiAdapter.js.
 *
 * Phase 3D of industrial-grade modularization.
 * Dependencies: _errorClassifiers (仅复用 TRANSIENT_STATUS_CODES 单一真源)。
 */

// Default transient HTTP status codes that warrant retry —— 与 sibling
// _errorClassifiers.js 逐字节相同的 9 元集,收敛到其单一真源(它已 export),
// 避免两处各自维护同一张表(改一处漏另一处 = silent drift)。
// 重试轮次硬上界的单一真源(与 services/retryWithBackoff.js 共用同一个 10)。本文件是
// 那个 helper 的适配器侧精简副本,若两处各自维护上界必然 silent drift。
const { clampRetryRounds } = require('../../../constants/retryBudget');

const { TRANSIENT_STATUS_CODES } = require('./_errorClassifiers');

// Default transient error message patterns
const TRANSIENT_ERROR_PATTERNS = [
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /timed?\s*out/i,
  /bad gateway/i,
  /service unavailable/i,
  /network/i,
  /epipe/i,
  /enotfound/i,
  /fetch failed/i,
  /abort/i,
];

/**
 * Default retryable error classifier.
 * @param {Error|object} error
 * @returns {boolean}
 */
function isTransientError(error) {
  if (!error) {
    return false;
  }

  // HTTP status code check
  const status = error.status || error.statusCode || error.code;
  if (typeof status === 'number' && TRANSIENT_STATUS_CODES.has(status)) {
    return true;
  }

  // Error message pattern matching
  const message = String(error.message || error || '');
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Sleep that can be aborted via AbortSignal.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new DOMException('Aborted', 'AbortError'));
    }

    // Leak fix: the previous version did `setTimeout(resolve, ms)` first and
    // reassigned `resolve` afterwards — the timer captured the original resolve
    // before reassignment, so the cleanup wrapper never ran and the abort
    // listener was never removed on the normal completion path. On long-lived
    // signals with frequent retries, listeners accumulated. Declare the abort
    // handler up-front so the timer callback detaches it before resolving.
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Execute a function with exponential backoff retry.
 *
 * @param {function} fn - Async function to execute. Receives { attempt, maxAttempts }.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts (including first),上界 MAX_RETRY_ROUNDS
 * @param {number} [options.baseDelayMs=350] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=1800] - Maximum delay cap
 * @param {number} [options.backoffFactor=1.8] - Exponential factor
 * @param {function} [options.isRetryable] - Custom error classifier
 * @param {AbortSignal} [options.signal] - Abort signal
 * @param {function} [options.onRetry] - Callback before each retry: (error, attempt, delay) => void
 * @returns {Promise<*>} Result from fn
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxAttempts: _maxAttemptsRequested = 3,
    baseDelayMs = 350,
    maxDelayMs = 1800,
    backoffFactor = 1.8,
    isRetryable = isTransientError,
    signal = null,
    onRetry = null,
  } = options;

  // 轮次封顶(只封顶不抬升):传 3 还是 3,传 999 收成 10。fn 收到的 maxAttempts 也是
  // 收敛后的真值,adapter 侧「第 N/M 次」文案不会承诺做不到的轮数。
  const maxAttempts = clampRetryRounds(_maxAttemptsRequested, 3);

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Check abort before each attempt
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      return await fn({ attempt, maxAttempts });
    } catch (error) {
      lastError = error;

      // Don't retry AbortError
      if (error.name === 'AbortError') {
        throw error;
      }

      // Last attempt — don't retry
      if (attempt >= maxAttempts) {
        break;
      }

      // Check if error is retryable
      if (!isRetryable(error)) {
        break;
      }

      // Calculate delay with jitter
      const rawDelay = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
      const jitter = Math.random() * baseDelayMs * 0.3;
      const delayMs = Math.min(maxDelayMs, Math.round(rawDelay + jitter));

      if (onRetry) {
        try {
          onRetry(error, attempt, delayMs);
        } catch {
          /* non-critical */
        }
      }

      await sleepAbortable(delayMs, signal);
    }
  }

  throw lastError;
}

module.exports = {
  retryWithBackoff,
  isTransientError,
  sleepAbortable,
  TRANSIENT_STATUS_CODES,
};
