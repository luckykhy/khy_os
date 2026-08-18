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

// Default TTL (ms) for the persisted HALF_OPEN circuit state (hostate: keys).
// Callers normally pass an explicit TTL derived from the effective cooldown;
// this default only backstops calls without one. Override via env; floor 30s.
const HALF_OPEN_STATE_TTL_MS = (() => {
  const raw = parseInt(process.env.GATEWAY_HALF_OPEN_STATE_TTL_MS, 10);
  return Number.isFinite(raw) && raw >= 30000 ? raw : 600000;
})();

// 连续失败计数的存活时间(ms)。**两条路径共用同一个值**:Redis 路径以前把 300 写死在
// incrFailure 里,内存路径则完全没有过期 —— 于是同一份代码在装了 Redis 的机器上会自愈,
// 在默认(无 Redis)安装上永不衰减:计数只能被 clearFailure(=一次成功)清零,而一旦
// 连续失败数把熔断退避推到 300s 上限,「等一次成功」本身就已经很难发生了。这就是用户报的
// 「一次失败永久失败、无法恢复」。语义按 Redis 的滑动 TTL 对齐:**最后一次**失败之后
// 静默满 TTL,计数归零。env 覆盖,下限 10s 防抖。
const FAILURE_TTL_MS = (() => {
  const raw = parseInt(process.env.GATEWAY_FAILURE_COUNT_TTL_MS, 10);
  return Number.isFinite(raw) && raw >= 10000 ? raw : 300000;
})();
const FAILURE_TTL_SEC = Math.max(1, Math.ceil(FAILURE_TTL_MS / 1000));

// ── In-Memory Fallback Store ────────────────────────────────────────────────
class MemoryHealthStore {
  constructor() {
    this._failures = {}; // key → count
    this._failureExpiry = {}; // key → expiresAt(与 Redis 的 fail: TTL 语义一致)
    this._errors = {}; // key → { record, expiresAt }
    this._cooldowns = {}; // key → expiresAt
    this._halfOk = {}; // key → { count, expiresAt }
    this._window = {}; // key → { total, failed, expiresAt } (error-rate window)
    this._hostate = {}; // key → { record, expiresAt } (persisted HALF_OPEN state)
  }

  // 过期即视为 0(惰性淘汰,和本类其它字段一个写法)。返回值供 incr/get 复用。
  _liveFailureCount(key) {
    const exp = this._failureExpiry[key];
    if (exp !== undefined && Date.now() > exp) {
      delete this._failures[key];
      delete this._failureExpiry[key];
      return 0;
    }
    return this._failures[key] || 0;
  }

  // Redis 路径把权威计数镜像回内存(供 Redis 抖动时降级读取)。必须连同过期戳一起写,
  // 否则镜像进来的计数会变成一条永不衰减的记录 —— 正是这里原本的 bug。
  _mirrorFailureCount(key, count) {
    this._failures[key] = count;
    this._failureExpiry[key] = Date.now() + FAILURE_TTL_MS;
  }

  async incrFailure(key) {
    const count = this._liveFailureCount(key) + 1;
    this._failures[key] = count;
    this._failureExpiry[key] = Date.now() + FAILURE_TTL_MS; // 滑动:每次失败都续期
    return count;
  }

  async clearFailure(key) {
    delete this._failures[key];
    delete this._failureExpiry[key];
    delete this._errors[key];
    delete this._cooldowns[key];
    delete this._halfOk[key];
    delete this._window[key];
    delete this._hostate[key];
  }

  async getFailureCount(key) {
    return this._liveFailureCount(key);
  }

  async recordLastError(key, record, ttlMs) {
    this._errors[key] = { record, expiresAt: Date.now() + (ttlMs || 120000) };
  }

  async getLastError(key) {
    const item = this._errors[key];
    if (!item) {
      return null;
    }
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
    if (!exp) {
      return false;
    }
    if (Date.now() > exp) {
      delete this._cooldowns[key];
      return false;
    }
    return true;
  }

  async getCooldownRemainingMs(key) {
    const exp = this._cooldowns[key];
    if (!exp) {
      return 0;
    }
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
    if (!item) {
      return 0;
    }
    if (Date.now() > item.expiresAt) {
      delete this._halfOk[key];
      return 0;
    }
    return item.count;
  }

  async resetHalfOpen(key) {
    delete this._halfOk[key];
  }

  // ── Persisted HALF_OPEN State ─────────────────────────────────────────────

  // Persist HALF_OPEN circuit progress so it survives process restarts.
  // Expiry is simulated with an expiresAt timestamp (checked on read).
  async setHalfOpenState(key, successCount, ttlMs) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : HALF_OPEN_STATE_TTL_MS;
    this._hostate[key] = {
      record: {
        state: 'half_open',
        successes: Math.max(0, Number(successCount) || 0),
        updatedAt: Date.now(),
      },
      expiresAt: Date.now() + ttl,
    };
  }

  async getHalfOpenState(key) {
    const item = this._hostate[key];
    if (!item) {
      return null;
    }
    if (Date.now() > item.expiresAt) {
      delete this._hostate[key];
      return null;
    }
    return item.record;
  }

  async clearHalfOpenState(key) {
    delete this._hostate[key];
  }

  // List every non-expired persisted HALF_OPEN state as { key → record }.
  async listHalfOpenStates() {
    const now = Date.now();
    const out = {};
    for (const key of Object.keys(this._hostate)) {
      const item = this._hostate[key];
      if (!item || now > item.expiresAt) {
        delete this._hostate[key];
        continue;
      }
      out[key] = item.record;
    }
    return out;
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
    if (!success) {
      w.failed += 1;
    }
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
        failureCount: this._liveFailureCount(key),
        lastError:
          this._errors[key] && Date.now() <= this._errors[key].expiresAt
            ? this._errors[key].record
            : null,
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
    for (const k of Object.keys(this._failures)) {
      if (!valid.has(k)) {
        delete this._failures[k];
        delete this._failureExpiry[k];
      }
    }
    for (const k of Object.keys(this._errors)) {
      if (!valid.has(k)) {
        delete this._errors[k];
      }
    }
    for (const k of Object.keys(this._cooldowns)) {
      if (!valid.has(k)) {
        delete this._cooldowns[k];
      }
    }
    for (const k of Object.keys(this._halfOk)) {
      if (!valid.has(k)) {
        delete this._halfOk[k];
      }
    }
    for (const k of Object.keys(this._window)) {
      if (!valid.has(k)) {
        delete this._window[k];
      }
    }
    for (const k of Object.keys(this._hostate)) {
      if (!valid.has(k)) {
        delete this._hostate[k];
      }
    }
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
    } catch {
      /* fallback to memory */
    }
    this._useRedis = false;
  }

  async destroy() {
    // We don't own the Redis connection (shared via cacheService), so just clean up local state
    this._useRedis = false;
  }

  isRedisAvailable() {
    if (!this._useRedis) {
      return false;
    }
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
    if (!this._useRedis) {
      return null;
    }
    try {
      const c = this._getClient();
      return c && c.isReady ? c : null;
    } catch {
      return null;
    }
  }

  _logRedisError(method, err) {
    if (!this._redisErrorLogged) {
      this._redisErrorLogged = true;
      console.warn(
        `[RedisHealthStore] Redis ${method} failed, falling back to memory: ${err.message}`
      );
      // Reset flag after 30s to allow logging again
      setTimeout(() => {
        this._redisErrorLogged = false;
      }, 30000);
    }
  }

  // ── Failure Counting ────────────────────────────────────────────────────

  async incrFailure(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`fail:${adapterKey}`);
        const count = await client.incr(key);
        await client.expire(key, FAILURE_TTL_SEC); // 与内存路径共用 FAILURE_TTL_MS
        // Mirror to memory for fast reads
        this._memory._mirrorFailureCount(adapterKey, count);
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
          this._key(`hostate:${adapterKey}`),
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
        this._memory._mirrorFailureCount(adapterKey, count); // sync to memory
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

  // ── Persisted HALF_OPEN State ─────────────────────────────────────────────

  async setHalfOpenState(adapterKey, successCount, ttlMs) {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : HALF_OPEN_STATE_TTL_MS;
    const client = this._client();
    if (client) {
      try {
        const key = this._key(`hostate:${adapterKey}`);
        const ttlSec = Math.max(1, Math.ceil(ttl / 1000));
        const record = {
          state: 'half_open',
          successes: Math.max(0, Number(successCount) || 0),
          updatedAt: Date.now(),
        };
        await client.setEx(key, ttlSec, JSON.stringify(record));
      } catch (err) {
        this._logRedisError('setHalfOpenState', err);
      }
    }
    // Always mirror to memory so single-process reads survive a Redis blip.
    return this._memory.setHalfOpenState(adapterKey, successCount, ttl);
  }

  async getHalfOpenState(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        const val = await client.get(this._key(`hostate:${adapterKey}`));
        if (val) {
          try {
            return JSON.parse(val);
          } catch {
            return null; /* corrupted */
          }
        }
        return null;
      } catch (err) {
        this._logRedisError('getHalfOpenState', err);
      }
    }
    return this._memory.getHalfOpenState(adapterKey);
  }

  async clearHalfOpenState(adapterKey) {
    const client = this._client();
    if (client) {
      try {
        await client.del(this._key(`hostate:${adapterKey}`));
      } catch (err) {
        this._logRedisError('clearHalfOpenState', err);
      }
    }
    return this._memory.clearHalfOpenState(adapterKey);
  }

  // List every persisted HALF_OPEN state as { adapterKey → record }. Uses
  // SCAN (never KEYS) with the shared prefix convention; TTL expiry is handled
  // by Redis itself. Fail-soft: any scan/read error degrades to the memory
  // mirror (which returns an empty object when it holds nothing).
  async listHalfOpenStates() {
    const client = this._client();
    if (client) {
      try {
        const prefix = this._key('hostate:');
        const out = {};
        for await (const scanKey of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
          const val = await client.get(scanKey);
          if (!val) {
            continue;
          }
          let record = null;
          try {
            record = JSON.parse(val);
          } catch {
            continue; /* corrupted entry */
          }
          const adapterKey = String(scanKey).slice(prefix.length);
          if (adapterKey) {
            out[adapterKey] = record;
          }
        }
        return out;
      } catch (err) {
        this._logRedisError('listHalfOpenStates', err);
      }
    }
    return this._memory.listHalfOpenStates();
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
        if (total === 1) {
          await client.expire(totKey, WINDOW_TTL_SEC);
        }
        let failed = 0;
        if (!success) {
          const failKey = this._key(`wfail:${adapterKey}`);
          failed = await client.incr(failKey);
          if (failed === 1) {
            await client.expire(failKey, WINDOW_TTL_SEC);
          }
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
    if (!client) {
      return this._memory.getAllAdapterStates(adapterKeys);
    }

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
          try {
            lastError = JSON.parse(errRaw);
          } catch {
            /* corrupted */
          }
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
