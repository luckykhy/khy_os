'use strict';

/**
 * Recent-models store — persists the last N (model, adapter) pairs the user
 * explicitly selected, so the TUI and frontend model pickers can surface a
 * "最近使用" section and F2 can cycle through them.
 *
 * Persistence: <dataHome>/recent_models.json (default ~/.khy; override via
 * KHY_RECENT_MODELS_FILE). Same dynamic resolution + atomic temp→rename
 * pattern as sibling lastVerifiedModelStore.js. Zero hardcoded paths.
 *
 * Fail-soft everywhere: read/write errors degrade to "no memory" and never
 * affect the request path.
 */

const fs = require('fs');
const path = require('path');

const { getDataHome } = require('../../utils/dataHome');

const RECENT_LIMIT = 5;

function _storeFile() {
  const override = process.env.KHY_RECENT_MODELS_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return path.join(getDataHome(), 'recent_models.json');
}

let _cache = null;
let _cacheLoaded = false;

function _normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const adapter = String(rec.adapter || '').trim();
  if (!adapter || adapter === 'none') return null;
  return {
    model: String(rec.model || '').trim() || null,
    adapter,
    timestamp: Number(rec.timestamp) || Date.now(),
  };
}

/**
 * @returns {Array<{model: string|null, adapter: string, timestamp: number}>}
 */
function readRecentModels() {
  if (_cacheLoaded) return _cache || [];
  try {
    const raw = fs.readFileSync(_storeFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      _cache = parsed.map(_normalize).filter(Boolean).slice(0, RECENT_LIMIT);
    } else {
      _cache = [];
    }
  } catch {
    _cache = [];
  }
  _cacheLoaded = true;
  return _cache;
}

/**
 * Prepend a (model, adapter) pair, de-duplicate, and cap at RECENT_LIMIT.
 * Skips disk IO when the pair is already at the front of the list.
 * @param {{model?: string|null, adapter?: string|null}} rec
 * @returns {boolean} true when the list changed and was persisted
 */
function pushRecentModel(rec = {}) {
  const next = _normalize(rec);
  if (!next) return false;
  const list = readRecentModels();
  if (list.length && list[0].adapter === next.adapter && list[0].model === next.model) {
    return false;
  }
  const merged = [next, ...list.filter((m) => !(m.adapter === next.adapter && m.model === next.model))].slice(
    0,
    RECENT_LIMIT
  );
  try {
    const file = _storeFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    _cache = merged;
    _cacheLoaded = true;
    return true;
  } catch {
    return false;
  }
}

/** Test helper: drop the in-process cache so the next read hits disk. */
function _resetCache() {
  _cache = null;
  _cacheLoaded = false;
}

module.exports = {
  readRecentModels,
  pushRecentModel,
  RECENT_LIMIT,
  _storeFile,
  _resetCache,
};
