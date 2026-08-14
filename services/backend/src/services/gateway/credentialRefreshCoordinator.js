'use strict';

/**
 * credentialRefreshCoordinator — single-flight credential refresh per adapter.
 *
 * When multiple in-flight gateway requests hit 401/403 on the same adapter at
 * the same time, only ONE refresh runs; concurrent callers await the same
 * promise. Every refresh attempt is bounded by a hard timeout
 * (KHY_CREDENTIAL_REFRESH_TIMEOUT_MS, default 10000 ms) via Promise.race so no
 * caller can hang on a stuck refresh. The in-flight entry is unconditionally
 * cleared in finally, so a failed/timed-out refresh never wedges future ones.
 *
 * Contract: refreshCredential() never throws — it resolves
 * { ok: boolean, error?: string } so callers can fall back to existing
 * account-pool rotation without try/catch ceremony.
 *
 * @module services/gateway/credentialRefreshCoordinator
 */

// In-flight refresh promises keyed by adapterKey (single-flight dedup).
const _inFlight = new Map();

/**
 * Resolve the refresh timeout upper bound.
 * Reads KHY_CREDENTIAL_REFRESH_TIMEOUT_MS via flagRegistry (default 10000 ms,
 * clamped [1000, 120000]); falls back to 10000 if the registry is unavailable.
 * @param {object} [env]
 * @returns {number}
 */
function _resolveTimeoutMs(env = process.env) {
  try {
    const { resolveNumeric } = require('../flagRegistry');
    return resolveNumeric('KHY_CREDENTIAL_REFRESH_TIMEOUT_MS', env);
  } catch {
    return 10000; // default upper bound when registry is unavailable
  }
}

/**
 * Run a credential refresh for an adapter with single-flight dedup and a hard
 * timeout. Concurrent callers for the same adapterKey share one refresh.
 *
 * @param {string} adapterKey - Stable adapter key (e.g. 'trae', 'cursor')
 * @param {() => Promise<*>} refreshFn - The adapter's refreshCredential()
 * @param {object} [env] - Env override for tests
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function refreshCredential(adapterKey, refreshFn, env = process.env) {
  const key = String(adapterKey || '').trim();
  if (!key || typeof refreshFn !== 'function') {
    return { ok: false, error: 'invalid adapterKey or refreshFn' };
  }
  if (_inFlight.has(key)) {
    return _inFlight.get(key);
  }

  const timeoutMs = _resolveTimeoutMs(env);
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `refresh timeout after ${timeoutMs}ms` }),
      timeoutMs
    );
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  const attempt = (async () => {
    try {
      const result = await refreshFn();
      // Adapters may return a refreshed token object (truthy) or a boolean.
      if (result === false || result === null || result === undefined) {
        return { ok: false, error: 'refresh returned no credential' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  })();

  const raced = Promise.race([attempt, timeoutPromise]).finally(() => {
    // Unconditional cleanup: never leave a stale in-flight entry behind.
    if (timer) {
      clearTimeout(timer);
    }
    _inFlight.delete(key);
  });

  _inFlight.set(key, raced);
  return raced;
}

/**
 * Test helper: number of in-flight refreshes.
 * @returns {number}
 */
function inFlightCount() {
  return _inFlight.size;
}

module.exports = { refreshCredential, inFlightCount };
