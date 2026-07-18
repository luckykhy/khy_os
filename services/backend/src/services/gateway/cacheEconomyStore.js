'use strict';

/**
 * cacheEconomyStore.js — 缓存计费透明探针存储 (DESIGN-ARCH-047).
 *
 * Records, per gateway adapter, how much of the input we sent was served from
 * the upstream prompt cache vs. billed fresh, and whether the adapter exposes
 * cache-billing fields at all. This surfaces relays that "enjoy caching but
 * charge full price" (享受缓存却全价计费) or simply never cache, so the default
 * route can softly down-weight them.
 *
 * Mirrors the persistence shape of runtimeDiagnosticsStore.js (getDataDir +
 * in-memory cache + synchronous JSON) but is a SEPARATE store: its lifecycle
 * (cumulative economics across the process lifetime) differs from the
 * latest-error diagnostics store, so they must not share a file.
 *
 * Pure telemetry + one derived verdict. It changes no wire bytes and cannot
 * alter model output. The only behavioral lever is the verdict, consumed by
 * aiGateway._assessDefaultRouteCandidate as a soft penalty (never a hard block).
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

// Families that do not bill for prompt caching at all (local inference). For
// these, a zero hit rate is expected and must NOT be read as gouging.
const NON_CACHEABLE_FAMILIES = new Set([
  'ollama', 'local', 'lmstudio', 'llamacpp', 'llama.cpp', 'vllm-local',
]);

function _envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function _envFloat(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// Minimum observed requests before we trust an "always missing fields" verdict.
function _minRequests() {
  return _envInt('GATEWAY_CACHE_ECONOMY_MIN_REQUESTS', 8);
}

// Hit-rate floor below which a cache-capable adapter is deemed to give no
// cache benefit.
function _hitRateFloor() {
  return _envFloat('GATEWAY_CACHE_ECONOMY_HITRATE_FLOOR', 0.05);
}

function _isCacheCapableFamily(family) {
  const f = String(family || '').trim().toLowerCase();
  if (!f) return true; // unknown → assume cloud/cacheable (conservative: still probe)
  for (const token of NON_CACHEABLE_FAMILIES) {
    if (f.includes(token)) return false;
  }
  return true;
}

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../../utils/finiteNumber').toPositiveOr0;

function _normalizeKey(adapterKey) {
  return String(adapterKey || '').trim().toLowerCase() || 'unknown';
}

function _emptyEntry(adapterKey) {
  return {
    adapterKey,
    requests: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    exposesCacheFields: false,
    cacheCapableFamily: true,
    alerted: false,
    firstSeen: 0,
    lastSeen: 0,
  };
}

function _file() {
  return path.join(getDataDir('gateway'), 'cache_economy.json');
}

// In-memory authoritative state (this process owns the file). Seeded lazily
// from disk so cumulative economics survive restarts.
let _state = null;

function _loadState() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(_file(), 'utf-8'));
    const adapters = {};
    if (raw && typeof raw === 'object' && raw.adapters && typeof raw.adapters === 'object') {
      for (const [key, value] of Object.entries(raw.adapters)) {
        const k = _normalizeKey(key);
        const base = _emptyEntry(k);
        if (value && typeof value === 'object') {
          base.requests = _num(value.requests);
          base.totalInputTokens = _num(value.totalInputTokens);
          base.totalCacheReadTokens = _num(value.totalCacheReadTokens);
          base.totalCacheWriteTokens = _num(value.totalCacheWriteTokens);
          base.exposesCacheFields = !!value.exposesCacheFields;
          base.cacheCapableFamily = value.cacheCapableFamily !== false;
          base.alerted = !!value.alerted;
          base.firstSeen = _num(value.firstSeen);
          base.lastSeen = _num(value.lastSeen);
        }
        adapters[k] = base;
      }
    }
    _state = { adapters };
  } catch {
    _state = { adapters: {} };
  }
  return _state;
}

function _persist() {
  try {
    fs.writeFileSync(_file(), `${JSON.stringify(_loadState(), null, 2)}\n`, 'utf-8');
  } catch { /* best effort */ }
}

/**
 * Derive the transparency verdict for an entry.
 *
 *   not_cacheable            — local family that never bills for caching.
 *   opaque_suspected_gouging — cache-capable, never returned any cache field
 *                              across >= K requests (we DID send a cacheable
 *                              stable prefix, yet billing is opaque).
 *   no_cache_benefit         — exposes fields but hit rate below floor.
 *   transparent_caching      — exposes fields and hit rate at/above floor.
 *   insufficient_data        — too few requests to judge.
 */
function _deriveVerdict(entry) {
  if (!entry.cacheCapableFamily) return 'not_cacheable';
  const minReq = _minRequests();
  if (!entry.exposesCacheFields) {
    if (entry.requests >= minReq) return 'opaque_suspected_gouging';
    return 'insufficient_data';
  }
  const hitRate = entry.totalInputTokens > 0
    ? entry.totalCacheReadTokens / entry.totalInputTokens
    : 0;
  if (hitRate >= _hitRateFloor()) return 'transparent_caching';
  return 'no_cache_benefit';
}

function _hitRate(entry) {
  return entry.totalInputTokens > 0
    ? entry.totalCacheReadTokens / entry.totalInputTokens
    : 0;
}

/**
 * Record one completed request's cache economics for an adapter.
 *
 * @param {string} adapterKey
 * @param {object} opts
 * @param {object|null} opts.tokenUsage - { inputTokens, cacheReadInputTokens, cacheWriteInputTokens, ... }
 * @param {string} [opts.family] - provider/protocol family, used to derive cacheCapableFamily
 */
function record(adapterKey, opts = {}) {
  const key = _normalizeKey(adapterKey);
  const state = _loadState();
  const entry = state.adapters[key] || _emptyEntry(key);

  const usage = opts.tokenUsage && typeof opts.tokenUsage === 'object' ? opts.tokenUsage : {};
  const inputTokens = _num(usage.inputTokens);
  const cacheRead = _num(usage.cacheReadInputTokens);
  const cacheWrite = _num(usage.cacheWriteInputTokens);
  // A field is "exposed" only when the usage object actually carries the
  // canonical key — presence, not a positive value (0 is still a disclosure).
  const hasCacheField = Object.prototype.hasOwnProperty.call(usage, 'cacheReadInputTokens')
    || Object.prototype.hasOwnProperty.call(usage, 'cacheWriteInputTokens');

  const now = Date.now();
  entry.requests += 1;
  entry.totalInputTokens += inputTokens;
  entry.totalCacheReadTokens += cacheRead;
  entry.totalCacheWriteTokens += cacheWrite;
  if (hasCacheField) entry.exposesCacheFields = true; // sticky
  entry.cacheCapableFamily = _isCacheCapableFamily(opts.family);
  if (!entry.firstSeen) entry.firstSeen = now;
  entry.lastSeen = now;

  // One-time alert when the verdict first crosses into suspected gouging.
  const verdict = _deriveVerdict(entry);
  if (verdict === 'opaque_suspected_gouging' && !entry.alerted) {
    entry.alerted = true;
    try {
      // eslint-disable-next-line no-console
      console.warn(
        `[cacheEconomy] 适配器 "${key}" 经 ${entry.requests} 次请求从未回传缓存计费字段，`
        + '疑似缓存不透明计费（享受缓存却全价计费或根本不缓存），默认路由已降权。',
      );
    } catch { /* best effort */ }
  }

  state.adapters[key] = entry;
  _persist();
  return entry;
}

/**
 * Get the verdict for a single adapter (used by the route penalty).
 */
function getVerdict(adapterKey) {
  const key = _normalizeKey(adapterKey);
  const state = _loadState();
  const entry = state.adapters[key];
  if (!entry) return 'insufficient_data';
  return _deriveVerdict(entry);
}

/**
 * Full report across all observed adapters, with derived hitRate + verdict.
 */
function getReport() {
  const state = _loadState();
  const adapters = {};
  for (const [key, entry] of Object.entries(state.adapters)) {
    adapters[key] = {
      ...entry,
      hitRate: Number(_hitRate(entry).toFixed(4)),
      verdict: _deriveVerdict(entry),
    };
  }
  return {
    minRequests: _minRequests(),
    hitRateFloor: _hitRateFloor(),
    adapters,
  };
}

// Test/maintenance hooks.
function _reset() {
  _state = { adapters: {} };
  try { fs.unlinkSync(_file()); } catch { /* ignore */ }
}

module.exports = {
  record,
  getVerdict,
  getReport,
  _deriveVerdict,
  _isCacheCapableFamily,
  _reset,
};
