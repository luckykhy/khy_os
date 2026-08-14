'use strict';

/**
 * Last-verified-model store — persists the (model, adapter) pair that most
 * recently COMPLETED a successful generation, so the next startup can prefer a
 * channel proven to work over the blind "first available adapter's default
 * model" pick (which previously surfaced unusable models, e.g. a codex
 * config.toml review model on an installed-but-logged-out CLI).
 *
 * Selection priority consumed by AIGateway.getActiveAdapter():
 *   1. this store (last verified model — user's last explicit TUI selection,
 *      adapter must still detect as available)
 *   2. GATEWAY_PREFERRED_ADAPTER / GATEWAY_PREFERRED_MODEL env (initial default,
 *      used when no runtime memory exists or stored adapter is unavailable)
 *   3. adapter-priority first-available default (historical behavior)
 *
 * Persistence: <dataHome>/last_verified_model.json (default ~/.khy; override
 * via KHY_LAST_VERIFIED_MODEL_FILE) — same dynamic resolution + atomic
 * temp→rename pattern as sibling modelCuration.js. Zero hardcoded paths.
 *
 * Fail-soft everywhere: read/write errors degrade to "no memory" and never
 * affect the request path that triggered the write.
 */

const fs = require('fs');
const path = require('path');

const { getDataHome } = require('../../utils/dataHome');

function _storeFile() {
  const override = process.env.KHY_LAST_VERIFIED_MODEL_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return path.join(getDataHome(), 'last_verified_model.json');
}

let _cache = null; // last successfully read/written record
let _cacheLoaded = false;

/**
 * @returns {{model: string|null, adapter: string, timestamp: number}|null}
 */
function readLastVerifiedModel() {
  if (_cacheLoaded && _cache) {
    return _cache;
  }
  try {
    const raw = fs.readFileSync(_storeFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && String(parsed.adapter || '').trim()) {
      _cache = {
        model: String(parsed.model || '').trim() || null,
        adapter: String(parsed.adapter).trim(),
        timestamp: Number(parsed.timestamp) || 0,
      };
    } else {
      _cache = null;
    }
  } catch {
    _cache = null;
  }
  _cacheLoaded = true;
  return _cache;
}

/**
 * Record a successful generation. Skips disk IO when the (model, adapter)
 * pair is unchanged — the store answers "which channel worked last", so
 * refreshing only the timestamp on every request would be wasted writes.
 * @param {{model?: string|null, adapter?: string|null}} rec
 * @returns {boolean} true when a new record was persisted
 */
function recordLastVerifiedModel(rec = {}) {
  const adapter = String(rec.adapter || '').trim();
  if (!adapter || adapter === 'none') {
    return false;
  }
  const model = String(rec.model || '').trim() || null;
  const prev = readLastVerifiedModel();
  if (prev && prev.adapter === adapter && prev.model === model) {
    return false;
  }
  const next = { model, adapter, timestamp: Date.now() };
  try {
    const file = _storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic write: temp → rename (mirrors modelCuration._save).
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    _cache = next;
    _cacheLoaded = true;
    return true;
  } catch {
    return false; // persistence is best-effort
  }
}

/** Test helper: drop the in-process cache so the next read hits disk. */
function _resetCache() {
  _cache = null;
  _cacheLoaded = false;
}

module.exports = {
  readLastVerifiedModel,
  recordLastVerifiedModel,
  _storeFile,
  _resetCache,
};
