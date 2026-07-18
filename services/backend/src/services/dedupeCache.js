'use strict';

/**
 * dedupeCache.js — TTL-based deduplication cache with LRU eviction.
 *
 * Ported from OpenClaw's dedupe.ts.
 * Provides:
 *   - TTL-based expiration (automatic cleanup)
 *   - LRU-style size-bounded eviction
 *   - check() = read-through touch (first call false, repeat true)
 *   - peek() = read without side effects
 *   - Global singleton support for shared caches
 */

/**
 * Create a TTL-based dedup cache.
 *
 * @param {object} options
 * @param {number} options.ttlMs - Time-to-live in milliseconds
 * @param {number} options.maxSize - Maximum cache entries (LRU eviction)
 * @returns {{ check, peek, delete, clear, size }}
 *
 * @example
 *   const cache = createDedupeCache({ ttlMs: 60000, maxSize: 1000 });
 *   cache.check('msg-123'); // false (first time)
 *   cache.check('msg-123'); // true (duplicate)
 *   // After 60 seconds...
 *   cache.check('msg-123'); // false (expired)
 */
function createDedupeCache(options) {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs || 0));
  const maxSize = Math.max(0, Math.floor(options.maxSize || 0));
  const entries = new Map(); // key → timestamp

  function _touch(key, now) {
    // Delete + re-insert to move to end (LRU ordering)
    entries.delete(key);
    entries.set(key, now);
  }

  function _hasUnexpired(key, now, touchOnRead) {
    const ts = entries.get(key);
    if (ts === undefined) return false;
    if (ttlMs > 0 && (now - ts) >= ttlMs) {
      entries.delete(key);
      return false;
    }
    if (touchOnRead) _touch(key, now);
    return true;
  }

  function _prune(now) {
    // Remove expired entries
    if (ttlMs > 0) {
      const cutoff = now - ttlMs;
      for (const [key, ts] of entries) {
        if (ts <= cutoff) entries.delete(key);
      }
    }
    // LRU size eviction
    if (maxSize <= 0) {
      entries.clear();
    } else if (entries.size > maxSize) {
      const excess = entries.size - maxSize;
      const iter = entries.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) entries.delete(key);
      }
    }
  }

  return {
    /**
     * Check if key is a duplicate. If not, marks it.
     * First call for a key returns false (new), subsequent calls return true (dup).
     */
    check(key, now) {
      if (!key) return false;
      const t = now ?? Date.now();
      if (_hasUnexpired(key, t, true)) return true;
      // Mark as seen
      entries.set(key, t);
      _prune(t);
      return false;
    },

    /**
     * Check if key exists without modifying state.
     */
    peek(key, now) {
      if (!key) return false;
      return _hasUnexpired(key, now ?? Date.now(), false);
    },

    /**
     * Remove a specific key.
     */
    delete(key) {
      if (key) entries.delete(key);
    },

    /**
     * Clear entire cache.
     */
    clear() {
      entries.clear();
    },

    /**
     * Get current entry count.
     */
    size() {
      return entries.size;
    },
  };
}

// ── Global Singleton Support ───────────────────────────────────────

const _globalCaches = new Map();

/**
 * Get or create a named global dedup cache.
 * Shared across modules for the same process.
 *
 * @param {string} name - Cache name
 * @param {object} options - { ttlMs, maxSize }
 * @returns {{ check, peek, delete, clear, size }}
 */
function resolveGlobalDedupeCache(name, options) {
  if (!_globalCaches.has(name)) {
    _globalCaches.set(name, createDedupeCache(options));
  }
  return _globalCaches.get(name);
}

module.exports = {
  createDedupeCache,
  resolveGlobalDedupeCache,
};
