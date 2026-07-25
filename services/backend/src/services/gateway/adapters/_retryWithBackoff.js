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
const { TRANSIENT_STATUS_CODES } = require('./_errorClassifiers');

// Default transient error message patterns
const TRANSIENT_ERROR_PATTERNS = [
  /econnreset/i, /econnrefused/i, /socket hang up/i, /timed?\s*out/i,
  /bad gateway/i, /service unavailable/i, /network/i, /epipe/i,
  /enotfound/i, /fetch failed/i, /abort/i,
];

/**
 * Default retryable error classifier.
 * @param {Error|object} error
 * @returns {boolean}
 */
function isTransientError(error) {
  if (!error) return false;

  // HTTP status code check
  const status = error.status || error.statusCode || error.code;
  if (typeof status === 'number' && TRANSIENT_STATUS_CODES.has(status)) return true;

  // Error message pattern matching
  const message = String(error.message || error || '');
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
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

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when timer fires normally
      const originalResolve = resolve;
      resolve = () => {
        signal.removeEventListener('abort', onAbort);
        originalResolve();
      };
    }
  });
}

/**
 * Execute a function with exponential backoff retry.
 *
 * @param {function} fn - Async function to execute. Receives { attempt, maxAttempts }.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts (including first)
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
    maxAttempts = 3,
    baseDelayMs = 350,
    maxDelayMs = 1800,
    backoffFactor = 1.8,
    isRetryable = isTransientError,
    signal = null,
    onRetry = null,
  } = options;

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
      if (error.name === 'AbortError') throw error;

      // Last attempt — don't retry
      if (attempt >= maxAttempts) break;

      // Check if error is retryable
      if (!isRetryable(error)) break;

      // Calculate delay with jitter
      const rawDelay = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
      const jitter = Math.random() * baseDelayMs * 0.3;
      const delayMs = Math.min(maxDelayMs, Math.round(rawDelay + jitter));

      if (onRetry) {
        try { onRetry(error, attempt, delayMs); } catch { /* non-critical */ }
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
