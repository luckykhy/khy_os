/**
 * Redis-backed Distributed Sliding-Window Rate Limiter
 *
 * Uses a Redis ZSET with a Lua script for atomic sliding window.
 * Falls back to in-memory fixed-window limiter when Redis unavailable.
 *
 * Interface is identical to createKeyedRateLimiter() from rateLimiter.js.
 */
'use strict';

const { REDIS_KEY_PREFIX } = require('../../constants/serviceDefaults');

// Lua script for atomic sliding-window rate limiting
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local maxReqs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local uid = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)

if count < maxReqs then
  redis.call('ZADD', key, now, uid)
  redis.call('PEXPIRE', key, windowMs)
  return {1, maxReqs - count - 1, 0}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 0
  if oldest and #oldest >= 2 then
    retryAfter = tonumber(oldest[2]) + windowMs - now
    if retryAfter < 0 then retryAfter = 0 end
  end
  return {0, 0, retryAfter}
end
`;

let _scriptSha = null;

/**
 * Create a distributed rate limiter.
 *
 * @param {object} opts
 * @param {Function} opts.getRedisClient  — () => redis client or null
 * @param {number}  [opts.maxRequests=10] — max requests per window
 * @param {number}  [opts.windowMs=60000] — window duration in ms
 * @param {string}  [opts.keyPrefix]      — Redis key prefix
 * @returns {{ consume(key: string): Promise<{allowed: boolean, remaining: number, retryAfterMs: number}>, reset(key: string): Promise<void> }}
 */
function createRedisRateLimiter(opts = {}) {
  const getClient = opts.getRedisClient || (() => null);
  const maxRequests = parseInt(process.env.GATEWAY_RATELIMIT_MAX_REQUESTS || String(opts.maxRequests || 10), 10);
  const windowMs = parseInt(process.env.GATEWAY_RATELIMIT_WINDOW_MS || String(opts.windowMs || 60000), 10);
  const prefix = (opts.keyPrefix || REDIS_KEY_PREFIX) + 'rl:';

  // In-memory fallback (same as existing createKeyedRateLimiter)
  const memoryStore = {};

  function memoryConsume(key) {
    const now = Date.now();
    if (!memoryStore[key]) memoryStore[key] = [];
    const timestamps = memoryStore[key];

    // Remove expired entries
    while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
      timestamps.shift();
    }

    if (timestamps.length < maxRequests) {
      timestamps.push(now);
      return { allowed: true, remaining: maxRequests - timestamps.length, retryAfterMs: 0 };
    }

    const retryAfterMs = timestamps[0] + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  async function consume(adapterKey) {
    const client = getClient();
    if (!client || !client.isReady) return memoryConsume(adapterKey);

    try {
      const redisKey = `${prefix}${adapterKey}`;
      const now = Date.now();
      const uid = `${now}:${Math.random().toString(36).slice(2, 8)}`;

      // Load script if not cached
      if (!_scriptSha) {
        try {
          _scriptSha = await client.scriptLoad(SLIDING_WINDOW_LUA);
        } catch {
          // Script load failed — use EVAL directly
          const result = await client.eval(SLIDING_WINDOW_LUA, {
            keys: [redisKey],
            arguments: [String(windowMs), String(maxRequests), String(now), uid],
          });
          return {
            allowed: result[0] === 1,
            remaining: result[1],
            retryAfterMs: result[2] || 0,
          };
        }
      }

      const result = await client.evalSha(_scriptSha, {
        keys: [redisKey],
        arguments: [String(windowMs), String(maxRequests), String(now), uid],
      });

      return {
        allowed: result[0] === 1,
        remaining: result[1],
        retryAfterMs: result[2] || 0,
      };
    } catch (err) {
      // Redis error — fall back to memory
      _scriptSha = null; // Reset cached SHA in case of NOSCRIPT
      return memoryConsume(adapterKey);
    }
  }

  async function reset(adapterKey) {
    delete memoryStore[adapterKey];
    const client = getClient();
    if (client && client.isReady) {
      try {
        await client.del(`${prefix}${adapterKey}`);
      } catch { /* best effort */ }
    }
  }

  return { consume, reset };
}

module.exports = { createRedisRateLimiter };
