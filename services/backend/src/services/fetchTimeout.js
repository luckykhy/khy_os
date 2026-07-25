'use strict';

/**
 * fetchTimeout.js — Fetch timeout with abort signal composition.
 *
 * Ported from OpenClaw's fetch-timeout.ts.
 * Provides:
 *   - Composable AbortSignal building (timeout + external signal)
 *   - Event-loop stall detection (timer delay diagnostics)
 *   - Memory-safe abort relay via .bind() (no closure leaks)
 *   - Refreshable timeout for long-running streaming operations
 */

const LOG_URL_MAX_CHARS = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 120000; // 2 minutes — prevents indefinite hangs

// Lazy-load circuit breaker
let _circuitBreaker;
function _getCircuitBreaker() {
  if (_circuitBreaker !== undefined) return _circuitBreaker;
  try {
    _circuitBreaker = require('./circuitBreaker');
  } catch {
    _circuitBreaker = null;
  }
  return _circuitBreaker;
}

// Lazy-load timeout multiplier
let _adaptiveOutput;
function _getMultiplier() {
  if (_adaptiveOutput !== undefined) return _adaptiveOutput;
  try {
    _adaptiveOutput = require('./adaptiveOutput');
  } catch {
    _adaptiveOutput = null;
  }
  return _adaptiveOutput;
}

/**
 * Apply global timeout multiplier if available.
 * @param {number} ms
 * @returns {number}
 */
function _applyMultiplier(ms) {
  const ao = _getMultiplier();
  return ao ? ao.applyMultiplier(ms) : ms;
}

/**
 * Memory-safe abort relay — uses .bind() instead of closure
 * to avoid unintended scope capture.
 */
function _relayAbort() {
  // `this` is bound to the AbortController instance
  this.abort();
}

function bindAbortRelay(controller) {
  return _relayAbort.bind(controller);
}

/**
 * Build a composable timeout + abort signal.
 *
 * @param {object} params
 * @param {number} [params.timeoutMs] - Timeout in milliseconds
 * @param {AbortSignal} [params.signal] - External abort signal to compose with
 * @param {string} [params.operation] - Diagnostic label
 * @param {string} [params.url] - URL for diagnostic logging
 * @param {object} [params.logger] - Logger instance
 * @param {Function} [params.onStale] - Stale 检测回调（借鉴 Hermes Agent）。
 *   在流式操作中，调用方通过 refresh() 重置超时；若长时间未 refresh，
 *   达到 staleWarningMs 时触发 onStale('warning')，超时时触发 onStale('critical')。
 * @param {number} [params.staleWarningMs] - Stale warning 阈值 (默认超时的50%)
 * @returns {{ signal: AbortSignal|undefined, cleanup: function, refresh: function }}
 */
function buildTimeoutAbortSignal(params) {
  const { timeoutMs: rawTimeoutMs, signal, operation, url, logger, onStale, staleWarningMs: customStaleWarningMs } = params;

  // Apply default timeout to prevent indefinite hangs when caller forgets to specify
  const timeoutMs = rawTimeoutMs ? _applyMultiplier(rawTimeoutMs)
    : (signal ? undefined : _applyMultiplier(DEFAULT_FETCH_TIMEOUT_MS));

  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup() {}, refresh() {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup() {}, refresh() {} };
  }

  const controller = new AbortController();
  const normalizedTimeout = Math.max(1, Math.floor(timeoutMs));
  let active = true;
  let timeoutId;
  let staleWarningTimerId;

  // Stale warning 定时器（借鉴 Hermes Agent _interruptible_api_call）
  const staleWarningMs = customStaleWarningMs || Math.max(10000, Math.floor(normalizedTimeout * 0.5));
  let staleWarningFired = false;

  function scheduleStaleWarning() {
    if (!onStale || staleWarningFired) return;
    if (staleWarningTimerId) clearTimeout(staleWarningTimerId);
    staleWarningTimerId = setTimeout(() => {
      if (!active || controller.signal.aborted) return;
      staleWarningFired = true;
      try { onStale('warning', { operation, elapsedMs: staleWarningMs }); } catch { /* ignore */ }
    }, staleWarningMs);
    if (staleWarningTimerId.unref) staleWarningTimerId.unref();
  }

  function scheduleTimeout() {
    const startedAt = Date.now();
    timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return;

      // Event-loop stall detection
      const elapsed = Date.now() - startedAt;
      const delay = Math.max(0, elapsed - normalizedTimeout);
      const stallThreshold = Math.max(1000, normalizedTimeout * 0.5);
      const stallHint = delay >= stallThreshold
        ? `timer delayed ${delay}ms, likely event-loop starvation`
        : null;

      const sanitizedUrl = _sanitizeLogUrl(url);
      const logCtx = {
        timeoutMs: normalizedTimeout,
        elapsedMs: elapsed,
        ...(stallHint ? { timerDelayMs: delay, stallHint } : {}),
        ...(operation ? { operation } : {}),
        ...(sanitizedUrl ? { url: sanitizedUrl } : {}),
      };

      if (logger?.warn) {
        logger.warn('Fetch timeout reached; aborting operation', logCtx);
      }

      // Stale critical 回调
      if (onStale) {
        try { onStale('critical', { operation, elapsedMs: elapsed }); } catch { /* ignore */ }
      }

      const error = new Error('request timed out');
      error.name = 'TimeoutError';
      controller.abort(error);
    }, normalizedTimeout);

    if (timeoutId.unref) timeoutId.unref();
  }

  scheduleTimeout();
  scheduleStaleWarning();

  // Compose with external signal
  const onAbort = bindAbortRelay(controller);
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,

    /** Refresh the timeout (for streaming operations that need more time). */
    refresh() {
      if (!active || controller.signal.aborted) return;
      if (timeoutId) clearTimeout(timeoutId);
      staleWarningFired = false; // 重置 stale warning 状态
      scheduleTimeout();
      scheduleStaleWarning();
    },

    /** Clean up timers and listeners. MUST call when done. */
    cleanup() {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
      if (staleWarningTimerId) clearTimeout(staleWarningTimerId);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Execute a fetch-like operation with timeout.
 *
 * @param {function} fn - (signal: AbortSignal) => Promise<T>
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.operation]
 * @param {string} [opts.url]
 * @param {object} [opts.logger]
 * @returns {Promise<T>}
 */
async function fetchWithTimeout(fn, opts) {
  const { signal: composedSignal, cleanup } = buildTimeoutAbortSignal(opts);
  try {
    return await fn(composedSignal);
  } finally {
    cleanup();
  }
}

/**
 * Sanitize URL for logging (strip auth, query params, control chars).
 */
function _sanitizeLogUrl(rawUrl) {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const value = parsed.toString();
    return value.length > LOG_URL_MAX_CHARS ? value.slice(0, LOG_URL_MAX_CHARS) + '...' : value;
  } catch {
    const clean = trimmed
      .split(/[?#]/, 1)[0]
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return undefined;
    return clean.length > LOG_URL_MAX_CHARS ? clean.slice(0, LOG_URL_MAX_CHARS) + '...' : clean;
  }
}

/**
 * Fetch with timeout + SSRF validation.
 * Validates the URL against SSRF policy before executing.
 *
 * @param {function} fn - (signal: AbortSignal) => Promise<T>
 * @param {object} opts
 * @param {string} opts.url - URL to validate
 * @param {number} opts.timeoutMs
 * @param {object} [opts.ssrfPolicy] - SSRF policy overrides
 * @returns {Promise<T>}
 */
async function fetchWithSsrfGuard(fn, opts) {
  if (opts.url) {
    try {
      const { validateUrl } = require('./ssrfGuard');
      await validateUrl(opts.url, opts.ssrfPolicy || {});
    } catch (err) {
      if (err.name === 'SsrfBlockedError') throw err;
      // DNS resolution failures are not SSRF — let the fetch itself handle them
    }
  }
  return fetchWithTimeout(fn, opts);
}

/**
 * Fetch with timeout + circuit breaker.
 * Wraps the call in a circuit breaker to prevent hammering a failing service.
 *
 * @param {function} fn - (signal: AbortSignal) => Promise<T>
 * @param {object} opts
 * @param {string} opts.serviceName - Circuit breaker key
 * @param {number} opts.timeoutMs
 * @param {object} [opts.breakerOptions] - CircuitBreaker constructor options
 * @returns {Promise<T>}
 */
async function fetchWithCircuitBreaker(fn, opts) {
  const cb = _getCircuitBreaker();
  if (!cb || !opts.serviceName) {
    return fetchWithTimeout(fn, opts);
  }

  const breaker = cb.getBreaker(opts.serviceName, opts.breakerOptions);
  return breaker.execute(() => fetchWithTimeout(fn, opts));
}

module.exports = {
  buildTimeoutAbortSignal,
  fetchWithTimeout,
  fetchWithSsrfGuard,
  fetchWithCircuitBreaker,
  bindAbortRelay,
  DEFAULT_FETCH_TIMEOUT_MS,
};
