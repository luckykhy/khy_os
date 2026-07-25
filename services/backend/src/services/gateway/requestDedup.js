/**
 * Request Deduplication via Redis (or in-memory fallback)
 *
 * Prevents duplicate AI requests from double-clicks, SSE reconnects,
 * or network retries by fingerprinting request content.
 *
 * Fingerprint: SHA-256 of `{userId}:{model}:{SHA-256 of FULL prompt}:{time bucket}`
 * Time bucket: 30-second window ensures near-simultaneous duplicates are caught.
 *
 * The prompt MUST be hashed in full — not a leading slice. The conversation
 * prompt is assembled system-prompt-first, so its first few hundred chars are an
 * identical preamble on every turn; fingerprinting a leading slice made every
 * request (and every tool-loop iteration) within a bucket collide on ONE
 * fingerprint, so the 2nd+ request returned the 1st's cached reply and the new
 * user message never reached the model. Hashing the whole prompt still catches
 * true double-submits (byte-identical full prompt) while letting distinct
 * messages and successive tool-loop turns through.
 */
'use strict';

const crypto = require('crypto');
const { REDIS_KEY_PREFIX } = require('../../constants/serviceDefaults');

/**
 * @param {object} opts
 * @param {Function} opts.getRedisClient  — () => redis client or null
 * @param {number}  [opts.ttlMs=60000]    — dedup window TTL
 * @param {number}  [opts.bucketMs=30000] — time bucketing window
 * @param {string}  [opts.keyPrefix]      — Redis key prefix
 */
function createRequestDedup(opts = {}) {
  const getClient = opts.getRedisClient || (() => null);
  const ttlMs = parseInt(process.env.GATEWAY_DEDUP_TTL_MS || String(opts.ttlMs || 60000), 10);
  const bucketMs = parseInt(process.env.GATEWAY_DEDUP_BUCKET_MS || String(opts.bucketMs || 30000), 10);
  const prefix = (opts.keyPrefix || REDIS_KEY_PREFIX) + 'dedup:';
  const enabled = String(process.env.GATEWAY_REDIS_DEDUP_ENABLED || 'true').toLowerCase() !== 'false';

  // In-memory fallback
  const memoryLocks = new Map(); // fingerprint → expiresAt
  const memoryResponses = new Map(); // fingerprint → { response, expiresAt }

  function _cleanupMemory() {
    const now = Date.now();
    for (const [k, exp] of memoryLocks) {
      if (now > exp) memoryLocks.delete(k);
    }
    for (const [k, v] of memoryResponses) {
      if (now > v.expiresAt) memoryResponses.delete(k);
    }
  }

  // Periodic cleanup every 30s
  const cleanupTimer = setInterval(_cleanupMemory, 30000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  /**
   * Generate a fingerprint for a request.
   */
  function fingerprint({ userId, model, prompt }) {
    const bucket = Math.floor(Date.now() / bucketMs);
    // Hash the FULL prompt (cheap: sha256 over even tens of KB is microseconds).
    // A leading slice collides across distinct messages because the prompt is
    // system-prompt-led — see the file header.
    const promptHash = crypto.createHash('sha256').update(String(prompt || '')).digest('hex');
    const raw = `${userId || 'anon'}:${model || 'auto'}:${promptHash}:${bucket}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  /**
   * Try to acquire the dedup lock for a fingerprint.
   * @returns {Promise<boolean>} true = new request (proceed), false = duplicate (check cache)
   */
  async function tryAcquire(fp) {
    if (!enabled) return true;

    const client = getClient();
    if (client && client.isReady) {
      try {
        // SET key "pending" EX ttl NX — returns 'OK' if new, null if exists
        const result = await client.set(`${prefix}${fp}`, 'pending', {
          PX: ttlMs,
          NX: true,
        });
        return result === 'OK';
      } catch { /* fall through to memory */ }
    }

    // Memory fallback
    _cleanupMemory();
    if (memoryLocks.has(fp)) return false;
    memoryLocks.set(fp, Date.now() + ttlMs);
    return true;
  }

  /**
   * Store a cached response for a fingerprint.
   */
  async function storeResponse(fp, response) {
    if (!enabled || !response) return;

    const client = getClient();
    if (client && client.isReady) {
      try {
        const respKey = `${prefix}resp:${fp}`;
        const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
        await client.setEx(respKey, ttlSec, JSON.stringify(response));
        return;
      } catch { /* fall through */ }
    }

    // Memory fallback
    memoryResponses.set(fp, { response, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Get a cached response for a fingerprint.
   * @returns {Promise<object|null>}
   */
  async function getCached(fp) {
    if (!enabled) return null;

    const client = getClient();
    if (client && client.isReady) {
      try {
        const val = await client.get(`${prefix}resp:${fp}`);
        return val ? JSON.parse(val) : null;
      } catch { /* fall through */ }
    }

    // Memory fallback
    const item = memoryResponses.get(fp);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      memoryResponses.delete(fp);
      return null;
    }
    return item.response;
  }

  function destroy() {
    clearInterval(cleanupTimer);
    memoryLocks.clear();
    memoryResponses.clear();
  }

  return { fingerprint, tryAcquire, storeResponse, getCached, destroy };
}

module.exports = { createRequestDedup };
