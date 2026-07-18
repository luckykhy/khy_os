'use strict';

/**
 * rateLimiter.js — Fixed-window rate limiter for API calls.
 *
 * Ported from OpenClaw's fixed-window-rate-limit.ts.
 * Simple but effective: tracks requests in a fixed time window (window resets entirely on expiry).
 *
 * Usage:
 *   const limiter = createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60000 });
 *   const { allowed, retryAfterMs, remaining } = limiter.consume();
 */

/**
 * Create a fixed-window rate limiter.
 *
 * @param {object} opts
 * @param {number} opts.maxRequests - Maximum requests per window
 * @param {number} opts.windowMs - Window duration in milliseconds
 * @param {function} [opts.now] - Time function (for testing). Default: Date.now
 * @returns {{ consume: () => RateLimitResult, reset: () => void, getState: () => object }}
 */
function createFixedWindowRateLimiter({ maxRequests, windowMs, now = Date.now }) {
  let windowStart = now();
  let count = 0;

  function _maybeResetWindow() {
    const currentTime = now();
    if (currentTime - windowStart >= windowMs) {
      windowStart = currentTime;
      count = 0;
    }
  }

  /**
   * Try to consume one request from the rate limiter.
   * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number }}
   */
  function consume() {
    _maybeResetWindow();

    if (count < maxRequests) {
      count++;
      return {
        allowed: true,
        retryAfterMs: 0,
        remaining: maxRequests - count,
      };
    }

    // Rate limited — calculate wait time until window resets
    const elapsed = now() - windowStart;
    const retryAfterMs = Math.max(0, windowMs - elapsed);
    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
    };
  }

  /**
   * Reset the rate limiter.
   */
  function reset() {
    windowStart = now();
    count = 0;
  }

  /**
   * Get current limiter state (for diagnostics).
   */
  function getState() {
    _maybeResetWindow();
    return {
      windowStart,
      count,
      remaining: Math.max(0, maxRequests - count),
      windowMs,
      maxRequests,
    };
  }

  return { consume, reset, getState };
}

/**
 * Create a per-key rate limiter (e.g., per-provider, per-model).
 *
 * @param {object} opts - Same as createFixedWindowRateLimiter
 * @returns {{ consume: (key: string) => RateLimitResult, reset: (key?: string) => void }}
 */
function createKeyedRateLimiter(opts) {
  const limiters = new Map();

  function _getOrCreate(key) {
    if (!limiters.has(key)) {
      limiters.set(key, createFixedWindowRateLimiter(opts));
    }
    return limiters.get(key);
  }

  function consume(key) {
    return _getOrCreate(key).consume();
  }

  function reset(key) {
    if (key) {
      limiters.delete(key);
    } else {
      limiters.clear();
    }
  }

  return { consume, reset };
}

module.exports = {
  createFixedWindowRateLimiter,
  createKeyedRateLimiter,
};
