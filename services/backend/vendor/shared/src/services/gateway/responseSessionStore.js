'use strict';

/**
 * Response Session Store — backs the OpenAI Responses API session-chaining
 * features `previous_response_id` and `store`.
 *
 * When a client sends `store: true` (the Responses API default), the server
 * persists the turn under a freshly minted `resp_…` id. A later request may set
 * `previous_response_id` to that id; the server then prepends the stored
 * conversation history so the model sees the full thread without the client
 * re-sending it.
 *
 * This is an in-process LRU+TTL map — intentionally the simplest thing that
 * works for a single proxy process. The `put`/`get` contract is stable so the
 * backing store can later be swapped for sqlite/redis without touching callers.
 *
 * ⚠ Multi-process limitation: under a clustered deployment a follow-up request
 * may land on a worker that never saw the `put`, so `get` returns null and the
 * caller treats it as an expired/unknown id (HTTP 400). Sticky sessions or a
 * shared backing store are required for horizontal scaling.
 *
 * Env:
 *   RESPONSES_STORE_TTL_MS  entry lifetime in ms (default 3600000 = 1h)
 *   RESPONSES_STORE_MAX     max retained entries before LRU eviction (default 1000)
 */

function envInt(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Insertion-ordered Map doubles as the LRU recency list: re-inserting on access
// moves an entry to the newest position; eviction drops the oldest (first) key.
const _entries = new Map(); // id → { payload, expiresAt }

function _ttlMs() { return envInt('RESPONSES_STORE_TTL_MS', 3600000); }
function _maxEntries() { return envInt('RESPONSES_STORE_MAX', 1000); }

function _isExpired(entry, now) {
  return !entry || entry.expiresAt <= now;
}

/**
 * Persist a response payload under `id`. Overwrites any existing entry and marks
 * it most-recently-used. Evicts the least-recently-used entries past the cap.
 * @param {string} id   the `resp_…` id
 * @param {object} payload arbitrary serialisable turn state (e.g. { messages })
 */
function put(id, payload) {
  if (!id || typeof id !== 'string') return;
  if (_entries.has(id)) _entries.delete(id); // re-insert to refresh recency
  _entries.set(id, { payload, expiresAt: Date.now() + _ttlMs() });
  const max = _maxEntries();
  while (_entries.size > max) {
    const oldest = _entries.keys().next().value;
    if (oldest === undefined) break;
    _entries.delete(oldest);
  }
}

/**
 * Retrieve a stored payload. Returns null for unknown or expired ids (expired
 * entries are purged on access). A hit is promoted to most-recently-used.
 * @param {string} id
 * @returns {object|null}
 */
function get(id) {
  if (!id || typeof id !== 'string') return null;
  const entry = _entries.get(id);
  const now = Date.now();
  if (_isExpired(entry, now)) {
    if (entry) _entries.delete(id);
    return null;
  }
  // Touch: refresh recency (sliding window is intentional — an actively chained
  // session stays warm) without extending the TTL beyond its original lifetime.
  _entries.delete(id);
  _entries.set(id, entry);
  return entry.payload;
}

/** Remove an entry explicitly (e.g. a `store:false` overwrite). */
function remove(id) {
  return _entries.delete(id);
}

/** Test/diagnostic helpers — not part of the persistence contract. */
function _size() { return _entries.size; }
function _clear() { _entries.clear(); }

module.exports = { put, get, remove, _size, _clear };
