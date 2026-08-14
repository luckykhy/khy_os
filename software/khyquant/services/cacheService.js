'use strict';

/**
 * In-memory TTL cache for khyquant data/news services.
 *
 * Restores the `./cacheService` module that klineDataService,
 * finlightNewsService, routes/news and routes/tradingAgents require but
 * which was missing from the tree (causing "Cannot find module
 * './cacheService'" at load time). The API is intentionally minimal and
 * process-local — no external store — so it works in tests and single-node
 * runs without extra infrastructure. Swap the backing Map for Redis here if
 * a shared cache is needed later; the public contract stays the same.
 *
 * Contract (all methods are async-safe; callers use `await` + `.catch`):
 *   get(key)               -> cached value or null (expired entries return null)
 *   set(key, value, ttlS)  -> stores value with a TTL in seconds (default 3600)
 *   del(key)               -> removes one entry
 *   clearByPrefix(prefix)  -> removes all keys starting with prefix, returns count
 *   getStats()             -> { size, hits, misses, expired }
 */

const DEFAULT_TTL_SECONDS = 3600;

const _store = new Map(); // key -> { value, expiresAt }
const _stats = { hits: 0, misses: 0, expired: 0 };

function _now() {
  return Date.now();
}

function _isExpired(entry) {
  return !entry || (entry.expiresAt !== 0 && entry.expiresAt <= _now());
}

async function get(key) {
  const k = String(key || '');
  const entry = _store.get(k);
  if (!entry) {
    _stats.misses += 1;
    return null;
  }
  if (_isExpired(entry)) {
    _store.delete(k);
    _stats.expired += 1;
    _stats.misses += 1;
    return null;
  }
  _stats.hits += 1;
  return entry.value;
}

async function set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const k = String(key || '');
  if (!k) return;
  const ttl = Number(ttlSeconds);
  // ttl <= 0 means "no expiry" (expiresAt = 0).
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? _now() + ttl * 1000 : 0;
  _store.set(k, { value, expiresAt });
}

async function del(key) {
  _store.delete(String(key || ''));
}

async function clearByPrefix(prefix) {
  const p = String(prefix || '');
  if (!p) return 0;
  let removed = 0;
  for (const k of _store.keys()) {
    if (k.startsWith(p)) {
      _store.delete(k);
      removed += 1;
    }
  }
  return removed;
}

function getStats() {
  return { size: _store.size, hits: _stats.hits, misses: _stats.misses, expired: _stats.expired };
}

module.exports = { get, set, del, clearByPrefix, getStats };
