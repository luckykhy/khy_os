'use strict';

/**
 * Prompt Cache Service — share prompt caches across sub-agents.
 *
 * When forking sub-agents, the system prompt and tool definitions are
 * often identical. This service computes cache keys and maintains a
 * shared prompt cache so sub-agents can skip re-sending the same prefix.
 *
 * Features:
 *   - Content-hash based cache keys (SHA-256)
 *   - LRU eviction when memory budget is exceeded
 *   - TTL-based expiry for stale entries
 *   - Metrics tracking (hits, misses, evictions)
 *
 * @module promptCacheService
 */

const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

// ── Constants ──

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// ── Cache Entry ──

/**
 * @typedef {object} CacheEntry
 * @property {string} key - SHA-256 hash
 * @property {object} content - Cached prompt content
 * @property {number} byteSize - Approximate size in bytes
 * @property {number} createdAt - Timestamp
 * @property {number} lastAccessAt - Last access timestamp
 * @property {number} accessCount - Number of accesses
 * @property {string[]} users - Agent IDs that use this entry
 */

// ── Prompt Cache Class ──

class PromptCache {
  /**
   * @param {object} [options]
   * @param {number} [options.maxEntries] - Max cache entries (default: 64)
   * @param {number} [options.maxBytes] - Max cache size in bytes (default: 50MB)
   * @param {number} [options.ttlMs] - Entry TTL in milliseconds (default: 30min)
   */
  constructor(options) {
    const opts = options || {};
    this._maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this._maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    this._ttlMs = opts.ttlMs || DEFAULT_TTL_MS;

    /** @type {Map<string, CacheEntry>} */
    this._entries = new Map();
    this._totalBytes = 0;

    // Metrics
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
    this._accessClock = 0;
  }

  /**
   * Compute a cache key from content.
   * @param {object} content - Prompt content to hash
   * @param {string} [content.systemPrompt]
   * @param {Array} [content.tools]
   * @param {string} [content.model]
   * @returns {string} SHA-256 hash
   */
  computeKey(content) {
    const normalized = {
      system: content.systemPrompt || '',
      tools: (content.tools || []).map((t) => t.name || t.function?.name || '').sort(),
      model: content.model || '',
    };
    return crypto.createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
  }

  /**
   * Get a cached prompt entry.
   * @param {string} key - Cache key
   * @param {string} [agentId] - Agent requesting the cache
   * @returns {object|null} Cached content or null
   */
  get(key, agentId) {
    const entry = this._entries.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._evict(key);
      this._misses++;
      return null;
    }

    // Update access stats
    entry.lastAccessAt = Date.now();
    entry.lastAccessOrder = ++this._accessClock;
    entry.accessCount++;
    if (agentId && !entry.users.includes(agentId)) {
      entry.users.push(agentId);
    }

    this._hits++;
    return entry.content;
  }

  /**
   * Store a prompt in the cache.
   * @param {string} key - Cache key
   * @param {object} content - Prompt content to cache
   * @param {string} [agentId] - Agent storing the cache
   * @returns {boolean} True if stored
   */
  put(key, content, agentId) {
    // Don't duplicate
    if (this._entries.has(key)) {
      const entry = this._entries.get(key);
      entry.lastAccessAt = Date.now();
      entry.lastAccessOrder = ++this._accessClock;
      entry.accessCount++;
      if (agentId && !entry.users.includes(agentId)) {
        entry.users.push(agentId);
      }
      return true;
    }

    const byteSize = _estimateBytes(content);

    // Evict if needed
    while (this._entries.size >= this._maxEntries || this._totalBytes + byteSize > this._maxBytes) {
      if (this._entries.size === 0) break;
      this._evictLRU();
    }

    // Still too large?
    if (byteSize > this._maxBytes) {
      log.debug('Prompt cache: content too large to cache');
      return false;
    }

    const entry = {
      key,
      content,
      byteSize,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      lastAccessOrder: ++this._accessClock,
      accessCount: 1,
      users: agentId ? [agentId] : [],
    };

    this._entries.set(key, entry);
    this._totalBytes += byteSize;

    return true;
  }

  /**
   * Check if a key exists and is valid.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const entry = this._entries.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > this._ttlMs) {
      this._evict(key);
      return false;
    }
    return true;
  }

  /**
   * Invalidate a cache entry.
   * Default behavior: deferred (entry stays active this session, not persisted to disk).
   * Pass `{ immediate: true }` for instant eviction.
   *
   * @param {string} key
   * @param {{ immediate?: boolean }} [opts]
   */
  invalidate(key, opts) {
    if (opts && opts.immediate) {
      this._evict(key);
      return;
    }
    this.invalidateDeferred(key);
  }

  /**
   * Deferred invalidation — mark entry so it stays active this session
   * but is NOT persisted to disk (takes effect next session).
   * Implements Hermes pattern: "commands default to delayed effect, --now for immediate".
   *
   * @param {string} key
   */
  invalidateDeferred(key) {
    const entry = this._entries.get(key);
    if (!entry) return;
    entry._pendingInvalidation = true;
  }

  /**
   * Immediate invalidation — evicts the entry right now.
   * Equivalent to `invalidate(key, { immediate: true })`.
   *
   * @param {string} key
   */
  invalidateNow(key) {
    this._evict(key);
  }

  /**
   * Invalidate all entries for a specific agent.
   * Only removes entries not used by other agents.
   * @param {string} agentId
   */
  invalidateAgent(agentId) {
    for (const [key, entry] of this._entries) {
      entry.users = entry.users.filter((u) => u !== agentId);
      if (entry.users.length === 0) {
        this._evict(key);
      }
    }
  }

  /**
   * Clear all cache entries.
   */
  clear() {
    this._entries.clear();
    this._totalBytes = 0;
  }

  /**
   * Get cache metrics.
   * @returns {{size, totalBytes, maxBytes, maxEntries, hits, misses, evictions, hitRate}}
   */
  getMetrics() {
    const total = this._hits + this._misses;
    return {
      size: this._entries.size,
      totalBytes: this._totalBytes,
      maxBytes: this._maxBytes,
      maxEntries: this._maxEntries,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: total > 0 ? (this._hits / total * 100).toFixed(1) + '%' : '0%',
    };
  }

  /**
   * Get summary of cached entries.
   * @returns {Array<{key, byteSize, accessCount, users, age}>}
   */
  getSummary() {
    const now = Date.now();
    return [...this._entries.values()].map((e) => ({
      key: e.key.substring(0, 12) + '...',
      byteSize: e.byteSize,
      accessCount: e.accessCount,
      users: e.users.length,
      ageSec: Math.round((now - e.createdAt) / 1000),
    }));
  }

  // ── Disk Persistence ──

  /**
   * Persist high-value cache entries to disk for cross-session reuse.
   * Only entries accessed more than `minAccessCount` times are persisted.
   * @param {string} [filePath] - Override default path (~/.khyquant/cache/prompt_cache.json)
   * @param {number} [minAccessCount=2] - Minimum access count to qualify for persistence
   * @returns {number} Number of entries persisted
   */
  persistToDisk(filePath, minAccessCount = 2) {
    const target = filePath || _defaultCachePath();
    const dir = path.dirname(target);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }

    const entries = [];
    for (const entry of this._entries.values()) {
      // Skip entries with pending deferred invalidation — they die with this session
      if (entry._pendingInvalidation) continue;
      if (entry.accessCount >= minAccessCount) {
        entries.push({
          key: entry.key,
          content: entry.content,
          byteSize: entry.byteSize,
          accessCount: entry.accessCount,
          users: entry.users,
        });
      }
    }

    fs.writeFileSync(target, JSON.stringify({ version: 1, entries, savedAt: Date.now() }, null, 2), 'utf-8');
    return entries.length;
  }

  /**
   * Load persisted cache entries from disk.
   * Restores entries that are not already in memory.
   * @param {string} [filePath] - Override default path
   * @returns {number} Number of entries loaded
   */
  loadFromDisk(filePath) {
    const target = filePath || _defaultCachePath();
    let data;
    try {
      data = JSON.parse(fs.readFileSync(target, 'utf-8'));
    } catch {
      return 0;
    }

    if (!data || data.version !== 1 || !Array.isArray(data.entries)) return 0;

    let loaded = 0;
    for (const entry of data.entries) {
      if (!entry.key || !entry.content) continue;
      if (this._entries.has(entry.key)) continue;

      const byteSize = entry.byteSize || _estimateBytes(entry.content);
      if (this._entries.size >= this._maxEntries || this._totalBytes + byteSize > this._maxBytes) break;

      this._entries.set(entry.key, {
        key: entry.key,
        content: entry.content,
        byteSize,
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        lastAccessOrder: ++this._accessClock,
        accessCount: entry.accessCount || 1,
        users: entry.users || [],
      });
      this._totalBytes += byteSize;
      loaded++;
    }

    return loaded;
  }

  /**
   * Get keys of high-frequency, recently-accessed entries that are implicitly protected.
   * These entries should not be casually invalidated.
   *
   * @param {{ minAccess?: number, maxAgeSec?: number }} [opts]
   * @returns {string[]}
   */
  getProtectedKeys(opts) {
    const minAccess = (opts && opts.minAccess) || 3;
    const maxAgeSec = (opts && opts.maxAgeSec) || 600;
    const now = Date.now();
    const keys = [];
    for (const entry of this._entries.values()) {
      if (entry._pendingInvalidation) continue;
      if (entry.accessCount >= minAccess && (now - entry.createdAt) / 1000 < maxAgeSec) {
        keys.push(entry.key);
      }
    }
    return keys;
  }

  // ── Internal ──

  _evict(key) {
    const entry = this._entries.get(key);
    if (entry) {
      this._totalBytes -= entry.byteSize;
      this._entries.delete(key);
      this._evictions++;
    }
  }

  _evictLRU() {
    let oldest = null;
    let oldestKey = null;

    for (const [key, entry] of this._entries) {
      if (!oldest) {
        oldest = entry;
        oldestKey = key;
        continue;
      }
      const entryOrder = Number.isFinite(entry.lastAccessOrder) ? entry.lastAccessOrder : entry.lastAccessAt;
      const oldestOrder = Number.isFinite(oldest.lastAccessOrder) ? oldest.lastAccessOrder : oldest.lastAccessAt;
      if (entryOrder < oldestOrder) {
        oldest = entry;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._evict(oldestKey);
    }
  }
}

// ── Helpers ──

function _estimateBytes(obj) {
  // Fast approximate size estimation
  const json = JSON.stringify(obj);
  return Buffer.byteLength(json, 'utf8');
}

function _defaultCachePath() {
  const home = os.homedir();
  return path.join(home, '.khyquant', 'cache', 'prompt_cache.json');
}

// ── Singleton ──

let _defaultCache = null;

/**
 * Get the shared prompt cache instance.
 * @param {object} [options]
 * @returns {PromptCache}
 */
function getPromptCache(options) {
  if (!_defaultCache) {
    _defaultCache = new PromptCache(options);
  }
  return _defaultCache;
}

module.exports = {
  PromptCache,
  getPromptCache,
};
