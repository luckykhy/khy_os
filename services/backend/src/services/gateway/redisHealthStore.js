/**
 * Redis-backed Adapter Health Store
 *
 * Provides distributed, persistent circuit breaker state for the AI Gateway.
 * Gracefully degrades to an in-memory Map when Redis is unavailable.
 *
 * Features:
 * - Atomic failure counting (Redis INCR)
 * - TTL-based auto-cleanup (no manual eviction needed)
 * - Half-open circuit state with consecutive-success tracking
 * - Exponential cooldown backoff across process restarts
 */
'use strict';

const { REDIS_KEY_PREFIX } = require('../../constants/serviceDefaults');

// Sliding error-rate window length (ms). Failures/successes are tallied over a
// fixed tumbling window so the circuit breaker can open on a high *error rate*
// (e.g. a flaky adapter alternating success/failure) in addition to the legacy
// consecutive-failure trigger. Override via env; floor 10s to avoid noise.
const WINDOW_TTL_MS = (() => {
  const raw = parseInt(process.env.GATEWAY_CIRCUIT_WINDOW_MS, 10);
  return Number.isFinite(raw) && raw >= 10000 ? raw : 120000;
})();
const WINDOW_TTL_SEC = Math.max(1, Math.ceil(WINDOW_TTL_MS / 1000));

// ── In-Memory Fallback Store ────────────────────────────────────────────────
class MemoryHealthStore {
  constructor() {
    this._failures = {};   // key → count
    this._errors = {};     // key → { record, expiresAt }
    this._cooldowns = {};  // key → expiresAt
    this._halfOk = {};     // key → { count, expiresAt }
    this._window = {};     // key → { total, failed, expiresAt } (error-rate window)
  }

  async incrFailure(key) {
    this._failures[key] = (this._failures[key] || 0) + 1;
    return this._failures[key];
  }

  async clearFailure(key) {
    delete this._failures[key];
    delete this._errors[key];
    delete this._cooldowns[key];
    delete this._halfOk[key];
    delete this._window[key];
  }

  async getFailureCount(key) {
    return this._failures[key] || 0;
  }

  async recordLastError(key, record, ttlMs) {
    this._errors[key] = { record, expiresAt: Date.now() + (ttlMs || 120000) };
  }

  async getLastError(key) {
    const item = this._errors[key];
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      delete this._errors[key];
      return null;
    }
    return item.record;
  }

  async setCooldown(key, ttlMs) {
    this._cooldowns[key] = Date.now() + ttlMs;
  }

  async isInCooldown(key) {
    const exp = this._cooldowns[key];
    if (!exp) return false;
    if (Date.now() > exp) {
      delete this._cooldowns[key];
      return false;
    }
    return true;
  }

  async getCooldownRemainingMs(key) {
    const exp = this._cooldowns[key];
    if (!exp) return 0;
    const remaining = exp - Date.now();
    if (remaining <= 0) {
      delete this._cooldowns[key];
      return 0;
    }
    return remaining;
  }

  async recordSuccess(key) {
    this._halfOk[key] = {
      count: ((this._halfOk[key] || {}).count || 0) + 1,
      expiresAt: Date.now() + 120000,
    };
    return this._halfOk[key].count;
  }

  async getConsecutiveSuccesses(key) {
    const item = this._halfOk[key];
    if (!item) return 0;
    if (Date.now() > item.expiresAt) {
      delete this._halfOk[key];
      return 0;
    }
    return item.count;
  }

  async resetHalfOpen(key) {
    delete this._halfOk[key];
  }

  // ── Error-Rate Window ─────────────────────────────────────────────────────

  // Tally one request outcome into the current tumbling window. The window
  // resets once expired so the rate reflects recent traffic, not all-time.
  async recordWindowOutcome(key, success) {
    const now = Date.now();
    let w = this._window[key];
    if (!w || now > w.expiresAt) {
      w = { total: 0, failed: 0, expiresAt: now + WINDOW_TTL_MS };
      this._window[key] = w;
    }
    w.total += 1;
    if (!success) w.failed += 1;
    return { total: w.total, failed: w.failed };
  }

  async getWindowStats(key) {
    const w = this._window[key];
    if (!w || Date.now() > w.expiresAt) {
      delete this._window[key];
      return { total: 0, failed: 0, rate: 0 };
    }
    const rate = w.total > 0 ? w.failed / w.total : 0;
    return { total: w.total, failed: w.failed, rate };
  }

  async getAllAdapterStates(adapterKeys) {
    const states = {};
    for (const key of adapterKeys) {
      const win = await this.getWindowStats(key);
      states[key] = {
        failureCount: this._failures[key] || 0,
        lastError: (this._errors[key] && Date.now() <= this._errors[key].expiresAt)
          ? this._errors[key].record : null,
        inCooldown: await this.isInCooldown(key),
        cooldownRemainingMs: await this.getCooldownRemainingMs(key),
        consecutiveSuccesses: await this.getConsecutiveSuccesses(key),
        windowTotal: win.total,
        windowFailed: win.failed,
        errorRate: win.rate,
      };
    }
    return states;
  }

  cleanup(validKeys) {
    const valid = new Set(validKeys);
    for (const k of Object.keys(this._failures)) if (!valid.has(k)) delete this._failures[k];
    for (const k of Object.keys(this._errors)) if (!valid.has(k)) delete this._errors[k];
    for (const k of Object.keys(this._cooldowns)) if (!valid.has(k)) delete this._cooldowns[k];
    for (const k of Object.keys(this._halfOk)) if (!valid.has(k)) delete this._halfOk[k];
    for (const k of Object.keys(this._window)) if (!valid.has(k)) delete this._window[k];
  }
}

// ── Redis Health Store ──────────────────────────────────────────────────────
class RedisHealthStore {
  /**
   * @param {object} opts
   * @param {Function} opts.getRedisClient  — () => redis client or null
   * @param {string}  [opts.keyPrefix]      — Redis key prefix
   */
  constructor(opts = {}) {
    this._getClient = opts.getRedisClient || (() => null);
    this._prefix = opts.keyPrefix || REDIS_KEY_PREFIX;
    this._memory = new MemoryHealthStore();
    this._useRedis = false;
    this._redisErrorLogged = false;
  }

  async init() {
    try {
      const client = this._getClient();
      if (client && client.isReady) {
        await client.ping();
        this._useRedis = true;
        return;
      }
    } catch { /* fallback to memory */ }
    this._useRedis = false;
  }

  async destroy() {
    // We don't own the Redis connection (shared via cacheService), so just clean up local state
    this._useRedis = false;
  }

  isRedisAvailable() {
    if (!this._useRedis) return false;
    try {
      const client = this._getClient();
      return !!(client && client.isReady);
    } catch {
      return false;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  _key(suffix) {
    return `${this._prefix}${suffix}`;
  }

  _client() {
    if (!this._useRedis) return null;
    try {
      const c = this._getClient();
      return (c && c.isReady) ? c : null;
    } catch {
      return null;
    }
  }

  _logRedisError(method, err) {
    if (!this._redisErrorLogged) {
      this._redisErrorLogged = true;
      console.warn(`[RedisHealthStore] Redis ${method} failed, falling back to memory: ${err.message}`);
      // Reset flag after 30s to allow logging again
      setTimeout(() => { this._redisErrorLogged = false; }, 30000);
    }
  }

  // ── Failure Counting ────────────────────────────────────────────────────

  async incrFailure(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`fail:${adapterKey}`);
        const count = await client.incr(key);
        await client.expire(key, 300); // 5 min TTL
        // Mirror to memory for fast reads
        this._memory._failures[adapterKey] = count;
        return count;
      } catch (err) {
        this._logRedisError('incrFailure', err);
      }
    }
    return this._memory.incrFailure(adapterKey);
  }

  async clearFailure(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        await client.del([
          this._key(`fail:${adapterKey}`),
          this._key(`err:${adapterKey}`),
          this._key(`cd:${adapterKey}`),
          this._key(`halfok:${adapterKey}`),
          this._key(`wtot:${adapterKey}`),
          this._key(`wfail:${adapterKey}`),
        ]);
      } catch (err) {
        this._logRedisError('clearFailure', err);
      }
    }
    return this._memory.clearFailure(adapterKey);
  }

  async getFailureCount(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const val = await client.get(this._key(`fail:${adapterKey}`));
        const count = val ? parseInt(val, 10) : 0;
        this._memory._failures[adapterKey] = count; // sync to memory
        return count;
      } catch (err) {
        this._logRedisError('getFailureCount', err);
      }
    }
    return this._memory.getFailureCount(adapterKey);
  }

  // ── Last Error Record ───────────────────────────────────────────────────

  async recordLastError(adapterKey, record, ttlMs = 120000) {
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`err:${adapterKey}`);
        const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
        await client.setEx(key, ttlSec, JSON.stringify(record));
      } catch (err) {
        this._logRedisError('recordLastError', err);
      }
    }
    return this._memory.recordLastError(adapterKey, record, ttlMs);
  }

  async getLastError(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const val = await client.get(this._key(`err:${adapterKey}`));
        if (val) {
          const record = JSON.parse(val);
          this._memory._errors[adapterKey] = { record, expiresAt: Date.now() + 120000 };
          return record;
        }
        return null;
      } catch (err) {
        this._logRedisError('getLastError', err);
      }
    }
    return this._memory.getLastError(adapterKey);
  }

  // ── Cooldown ────────────────────────────────────────────────────────────

  async setCooldown(adapterKey, ttlMs) {
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`cd:${adapterKey}`);
        const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
        await client.setEx(key, ttlSec, '1');
      } catch (err) {
        this._logRedisError('setCooldown', err);
      }
    }
    return this._memory.setCooldown(adapterKey, ttlMs);
  }

  async isInCooldown(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const exists = await client.exists(this._key(`cd:${adapterKey}`));
        return exists === 1;
      } catch (err) {
        this._logRedisError('isInCooldown', err);
      }
    }
    return this._memory.isInCooldown(adapterKey);
  }

  async getCooldownRemainingMs(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const ttl = await client.pTTL(this._key(`cd:${adapterKey}`));
        return ttl > 0 ? ttl : 0;
      } catch (err) {
        this._logRedisError('getCooldownRemainingMs', err);
      }
    }
    return this._memory.getCooldownRemainingMs(adapterKey);
  }

  // ── Half-Open Success Tracking ──────────────────────────────────────────

  async recordSuccess(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`halfok:${adapterKey}`);
        const count = await client.incr(key);
        await client.expire(key, 120); // 2 min TTL
        return count;
      } catch (err) {
        this._logRedisError('recordSuccess', err);
      }
    }
    return this._memory.recordSuccess(adapterKey);
  }

  async getConsecutiveSuccesses(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const val = await client.get(this._key(`halfok:${adapterKey}`));
        return val ? parseInt(val, 10) : 0;
      } catch (err) {
        this._logRedisError('getConsecutiveSuccesses', err);
      }
    }
    return this._memory.getConsecutiveSuccesses(adapterKey);
  }

  async resetHalfOpen(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        await client.del(this._key(`halfok:${adapterKey}`));
      } catch (err) {
        this._logRedisError('resetHalfOpen', err);
      }
    }
    return this._memory.resetHalfOpen(adapterKey);
  }

  // ── Error-Rate Window ─────────────────────────────────────────────────────

  // Tally one request outcome into the current window. Implemented as two
  // INCR counters (total + failed) sharing a TTL. The TTL is set only on the
  // first write of a window (when INCR returns 1), so each window is a fixed
  // tumbling interval rather than a sliding one — once it expires both keys
  // vanish together and the next outcome opens a fresh window.
  async recordWindowOutcome(adapterKey, success) {
    const client = this._client();
    if (client) {
      try {
        const totKey = this._key(`wtot:${adapterKey}`);
        const total = await client.incr(totKey);
        if (total === 1) await client.expire(totKey, WINDOW_TTL_SEC);
        let failed = 0;
        if (!success) {
          const failKey = this._key(`wfail:${adapterKey}`);
          failed = await client.incr(failKey);
          if (failed === 1) await client.expire(failKey, WINDOW_TTL_SEC);
        } else {
          const failRaw = await client.get(this._key(`wfail:${adapterKey}`));
          failed = failRaw ? parseInt(failRaw, 10) : 0;
        }
        return { total, failed };
      } catch (err) {
        this._logRedisError('recordWindowOutcome', err);
      }
    }
    return this._memory.recordWindowOutcome(adapterKey, success);
  }

  async getWindowStats(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const totRaw = await client.get(this._key(`wtot:${adapterKey}`));
        const failRaw = await client.get(this._key(`wfail:${adapterKey}`));
        const total = totRaw ? parseInt(totRaw, 10) : 0;
        const failed = failRaw ? parseInt(failRaw, 10) : 0;
        const rate = total > 0 ? failed / total : 0;
        return { total, failed, rate };
      } catch (err) {
        this._logRedisError('getWindowStats', err);
      }
    }
    return this._memory.getWindowStats(adapterKey);
  }

  // ── Bulk State Query (for health dashboard) ─────────────────────────────

  async getAllAdapterStates(adapterKeys) {
    const client = this._client();
    if (!client) return this._memory.getAllAdapterStates(adapterKeys);

    const states = {};
    try {
      // Pipeline multiple reads for efficiency
      const FIELDS = 6; // fail, err, cd-ttl, halfok, wtot, wfail
      const pipeline = client.multi();
      for (const key of adapterKeys) {
        pipeline.get(this._key(`fail:${key}`));
        pipeline.get(this._key(`err:${key}`));
        pipeline.pTTL(this._key(`cd:${key}`));
        pipeline.get(this._key(`halfok:${key}`));
        pipeline.get(this._key(`wtot:${key}`));
        pipeline.get(this._key(`wfail:${key}`));
      }
      const results = await pipeline.exec();

      for (let i = 0; i < adapterKeys.length; i++) {
        const key = adapterKeys[i];
        const base = i * FIELDS;
        const failCount = results[base] ? parseInt(results[base], 10) : 0;
        const errRaw = results[base + 1];
        const cdTTL = results[base + 2];
        const halfOk = results[base + 3] ? parseInt(results[base + 3], 10) : 0;
        const windowTotal = results[base + 4] ? parseInt(results[base + 4], 10) : 0;
        const windowFailed = results[base + 5] ? parseInt(results[base + 5], 10) : 0;

        let lastError = null;
        if (errRaw) {
          try { lastError = JSON.parse(errRaw); } catch { /* corrupted */ }
        }

        states[key] = {
          failureCount: failCount,
          lastError,
          inCooldown: cdTTL > 0,
          cooldownRemainingMs: cdTTL > 0 ? cdTTL : 0,
          consecutiveSuccesses: halfOk,
          windowTotal,
          windowFailed,
          errorRate: windowTotal > 0 ? windowFailed / windowTotal : 0,
        };
      }
      return states;
    } catch (err) {
      this._logRedisError('getAllAdapterStates', err);
      return this._memory.getAllAdapterStates(adapterKeys);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  cleanup(validKeys) {
    this._memory.cleanup(validKeys);
    // Redis keys auto-expire via TTL — no manual cleanup needed
  }
}

module.exports = { RedisHealthStore, MemoryHealthStore };
