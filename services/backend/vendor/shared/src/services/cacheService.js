/**
 * Cache Service (数据治理层 - Level 1 Cache)
 *
 * Provides millisecond-level data access via Redis.
 * Gracefully degrades to in-memory Map when Redis is unavailable.
 * This is the first level in the four-level fallback chain
 * described in thesis Chapter 4.5, Table 15.
 * @pattern Singleton
 */

let redisClient = null;
let useRedis = false;

// 内存缓存降级方案
const memoryCache = new Map();

// 尝试连接 Redis
async function initRedis() {
  try {
    const { createClient } = require('redis');
    const client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: { connectTimeout: 3000, reconnectStrategy: false }
    });

    client.on('error', () => {}); // 静默错误，避免日志污染

    await client.connect();
    redisClient = client;
    useRedis = true;
  } catch (e) {
    // Redis 不可用时静默降级到内存缓存
    useRedis = false;
  }
}

/**
 * 获取缓存
 */
async function get(key) {
  try {
    if (useRedis && redisClient) {
      const val = await redisClient.get(key);
      return val ? JSON.parse(val) : null;
    }
    // 内存缓存
    const item = memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expireAt) {
      memoryCache.delete(key);
      return null;
    }
    return item.value;
  } catch (e) {
    return null;
  }
}

/**
 * 设置缓存
 * @param {string} key
 * @param {*} value
 * @param {number} ttl 秒
 */
async function set(key, value, ttl = 300) {
  try {
    if (useRedis && redisClient) {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
      return;
    }
    // 内存缓存
    memoryCache.set(key, {
      value,
      expireAt: Date.now() + ttl * 1000
    });
  } catch (e) {
    // 缓存失败不影响主流程
  }
}

/**
 * 删除缓存
 */
async function del(key) {
  try {
    if (useRedis && redisClient) {
      await redisClient.del(key);
      return;
    }
    memoryCache.delete(key);
  } catch (e) {}
}

/**
 * 按前缀清除缓存
 */
async function clearByPrefix(prefix) {
  try {
    if (useRedis && redisClient) {
      // 使用 SCAN + 批量删除替代 KEYS，避免大键空间下阻塞 Redis
      const pattern = `${prefix}*`;
      let cursor = '0';
      do {
        const scanResult = await redisClient.scan(cursor, {
          MATCH: pattern,
          COUNT: 200
        });
        cursor = scanResult.cursor;
        const keys = scanResult.keys || [];
        if (keys.length > 0) {
          await redisClient.del(keys);
        }
      } while (cursor !== '0');
      return;
    }
    for (const key of memoryCache.keys()) {
      if (key.startsWith(prefix)) memoryCache.delete(key);
    }
  } catch (e) {}
}

/**
 * 获取缓存状态
 */
async function getStats() {
  if (useRedis && redisClient) {
    const info = await redisClient.info('stats').catch(() => '');
    const dbSize = await redisClient.dbSize().catch(() => 0);
    return { type: 'redis', keys: dbSize, info: info.split('\n').slice(0, 5).join('\n') };
  }
  // 清理过期内存缓存
  const now = Date.now();
  let valid = 0;
  for (const [k, v] of memoryCache.entries()) {
    if (now > v.expireAt) memoryCache.delete(k);
    else valid++;
  }
  return { type: 'memory', keys: valid };
}

/**
 * Get the shared Redis client (or null if Redis is not available).
 * Allows other modules to reuse the same connection.
 */
function getRedisClient() {
  return useRedis ? redisClient : null;
}

/**
 * Check if Redis is currently connected and ready.
 */
function isRedisConnected() {
  return useRedis && redisClient && redisClient.isReady;
}

// 初始化
initRedis();

module.exports = { get, set, del, clearByPrefix, getStats, getRedisClient, isRedisConnected };
