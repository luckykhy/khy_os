'use strict';

/** Persistent, route-scoped results of runtime vision capability probes. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getBaseDataDir } = require('../../utils/dataHome');
const probe = require('./visionCapabilityProbe');

const SCHEMA_VERSION = 1;
let _cache = null;

function _file() {
  const override = process.env.KHY_VISION_CAP_FILE;
  return override && String(override).trim()
    ? String(override).trim()
    : path.join(getBaseDataDir('.'), 'vision_capability.json');
}

function _hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

/**
 * Build a non-secret identity. Credential material is hashed and never persisted.
 */
function makeRouteKey(route = {}) {
  const parts = [
    route.adapter,
    route.pool,
    route.endpoint,
    route.apiFormat,
    route.model,
    route.credentialFingerprint || (route.apiKey ? _hash(route.apiKey) : ''),
  ].map((value) => String(value == null ? '' : value).trim().toLowerCase());
  if (!parts[5]) {
    parts[5] = 'no-credential';
  }
  return parts.map((value) => encodeURIComponent(value)).join('|');
}

function _empty() {
  return { version: SCHEMA_VERSION, entries: {} };
}

function _load() {
  if (_cache) return _cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(_file(), 'utf8'));
    _cache = parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed : _empty();
  } catch {
    _cache = _empty();
  }
  return _cache;
}

function _save(state) {
  _cache = state;
  try {
    const file = _file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch {
    /* best effort */
  }
}

function getRecord(route, env = process.env) {
  try {
    const key = makeRouteKey(route);
    const entry = _load().entries[key];
    if (!entry || probe.shouldReprobe(entry, env)) return null;
    return { routeKey: key, ...entry };
  } catch {
    return null;
  }
}

function getVerdict(route, env = process.env) {
  const record = getRecord(route, env);
  return record ? record.verdict : null;
}

function recordVerdict(route, verdict, meta = {}) {
  try {
    if (verdict !== 'supported' && verdict !== 'unsupported') return false;
    const key = makeRouteKey(route);
    const state = _load();
    state.entries[key] = {
      verdict,
      model: String(route.model || ''),
      adapter: String(route.adapter || ''),
      pool: String(route.pool || ''),
      apiFormat: String(route.apiFormat || ''),
      endpoint: String(route.endpoint || ''),
      measuredAt: Date.now(),
      latencyMs: Number.isFinite(meta.latencyMs) ? meta.latencyMs : null,
      reason: String(meta.reason || ''),
      source: String(meta.source || 'probe'),
    };
    _save(state);
    return true;
  } catch {
    return false;
  }
}

function resetCache() {
  _cache = null;
}

module.exports = { makeRouteKey, getRecord, getVerdict, recordVerdict, resetCache, _hash };
