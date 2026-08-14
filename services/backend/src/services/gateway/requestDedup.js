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
  const bucketMs = parseInt(
    process.env.GATEWAY_DEDUP_BUCKET_MS || String(opts.bucketMs || 30000),
    10
  );
  const prefix = (opts.keyPrefix || REDIS_KEY_PREFIX) + 'dedup:';
  const enabled =
    String(process.env.GATEWAY_REDIS_DEDUP_ENABLED || 'true').toLowerCase() !== 'false';

  // In-memory fallback
  const memoryLocks = new Map(); // fingerprint → expiresAt
  const memoryResponses = new Map(); // fingerprint → { response, expiresAt }

  function _cleanupMemory() {
    const now = Date.now();
    for (const [k, exp] of memoryLocks) {
      if (now > exp) {
        memoryLocks.delete(k);
      }
    }
    for (const [k, v] of memoryResponses) {
      if (now > v.expiresAt) {
        memoryResponses.delete(k);
      }
    }
  }

  // Periodic cleanup every 30s
  const cleanupTimer = setInterval(_cleanupMemory, 30000);
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }

  /**
   * Build a cheap digest of image content so that different images never share
   * a fingerprint. Vision prompts are near-identical text, so without an image
   * component distinct images within one time bucket collide onto ONE
   * fingerprint and the 2nd+ image returns the 1st image's cached reply.
   *
   * To avoid hashing megabytes of base64, each image contributes only a leading
   * slice of its base64 plus its byte length — enough entropy to distinguish
   * images while staying O(1) per request.
   * @param {Array<{base64?: string, dataUrl?: string, url?: string}>} images
   * @returns {string} hex digest, or '' when there are no usable images
   */
  function _imagesDigest(images) {
    if (!Array.isArray(images) || images.length === 0) {
      return '';
    }
    const parts = [];
    for (const img of images) {
      if (!img) {
        continue;
      }
      let b64 = typeof img.base64 === 'string' ? img.base64 : '';
      // Fall back to a data URL's payload when base64 is not populated yet.
      if (!b64 && typeof img.dataUrl === 'string') {
        const comma = img.dataUrl.indexOf(',');
        b64 = comma >= 0 ? img.dataUrl.slice(comma + 1) : img.dataUrl;
      }
      // Remote-only images (url without inline bytes) still contribute their url.
      if (!b64 && typeof img.url === 'string') {
        b64 = img.url;
      }
      if (!b64) {
        continue;
      }
      parts.push(`${b64.slice(0, 256)}:${b64.length}`);
    }
    if (parts.length === 0) {
      return '';
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  }

  /**
   * Generate a fingerprint for a request.
   * @param {string} [sessionId] — optional session id to scope dedup per session
   * @param {string} [imagesHash] — precomputed image digest (takes precedence)
   * @param {Array}  [images]     — image list; digested when imagesHash is absent
   */
  function fingerprint({ userId, model, prompt, sessionId, imagesHash, images }) {
    const bucket = Math.floor(Date.now() / bucketMs);
    // Hash the FULL prompt (cheap: sha256 over even tens of KB is microseconds).
    // A leading slice collides across distinct messages because the prompt is
    // system-prompt-led — see the file header.
    const promptHash = crypto
      .createHash('sha256')
      .update(String(prompt || ''))
      .digest('hex');
    // Optional image component. Absent by default → byte-identical fingerprints
    // to the pre-image behavior, preserving backward compatibility.
    const imgHash =
      typeof imagesHash === 'string' && imagesHash ? imagesHash : _imagesDigest(images);
    const raw = `${userId || 'anon'}:${model || 'auto'}:${promptHash}:${bucket}:${sessionId || ''}:${imgHash}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  /**
   * Try to acquire the dedup lock for a fingerprint.
   * @returns {Promise<boolean>} true = new request (proceed), false = duplicate (check cache)
   */
  async function tryAcquire(fp) {
    if (!enabled) {
      return true;
    }

    const client = getClient();
    if (client && client.isReady) {
      try {
        // SET key "pending" EX ttl NX — returns 'OK' if new, null if exists
        const result = await client.set(`${prefix}${fp}`, 'pending', {
          PX: ttlMs,
          NX: true,
        });
        return result === 'OK';
      } catch {
        /* fall through to memory */
      }
    }

    // Memory fallback
    _cleanupMemory();
    if (memoryLocks.has(fp)) {
      return false;
    }
    memoryLocks.set(fp, Date.now() + ttlMs);
    return true;
  }

  /**
   * Store a cached response for a fingerprint.
   */
  async function storeResponse(fp, response) {
    if (!enabled || !response) {
      return;
    }

    const client = getClient();
    if (client && client.isReady) {
      try {
        const respKey = `${prefix}resp:${fp}`;
        const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
        await client.setEx(respKey, ttlSec, JSON.stringify(response));
        return;
      } catch {
        /* fall through */
      }
    }

    // Memory fallback
    memoryResponses.set(fp, { response, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Get a cached response for a fingerprint.
   * @returns {Promise<object|null>}
   */
  async function getCached(fp) {
    if (!enabled) {
      return null;
    }

    const client = getClient();
    if (client && client.isReady) {
      try {
        const val = await client.get(`${prefix}resp:${fp}`);
        return val ? JSON.parse(val) : null;
      } catch {
        /* fall through */
      }
    }

    // Memory fallback
    const item = memoryResponses.get(fp);
    if (!item) {
      return null;
    }
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
