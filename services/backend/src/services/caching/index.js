'use strict';

/**
 * Caching service — intelligent LLM response caching.
 * Reduces costs and latency by caching frequent queries.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function _env(name) {
  return String(process.env[`KHY_CACHE_${name}`] || '').trim();
}

function _getCacheDir() {
  const dir = path.join(os.homedir(), '.khy', 'cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function _hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function _getCacheFile(key) {
  return path.join(_getCacheDir(), `${_hashKey(key)}.json`);
}

// ── Memory Cache (L1) ──
const _memoryCache = new Map();
const _memoryCacheTTL = new Map();

function _memoryGet(key) {
  if (!_memoryCache.has(key)) return null;
  const ttl = _memoryCacheTTL.get(key);
  if (ttl && Date.now() > ttl) {
    _memoryCache.delete(key);
    _memoryCacheTTL.delete(key);
    return null;
  }
  return _memoryCache.get(key);
}

function _memorySet(key, value, ttlMs = 300000) {
  _memoryCache.set(key, value);
  _memoryCacheTTL.set(key, Date.now() + ttlMs);
}

function _memoryDelete(key) {
  _memoryCache.delete(key);
  _memoryCacheTTL.delete(key);
}

function _memoryClear() {
  _memoryCache.clear();
  _memoryCacheTTL.clear();
}

function _memorySize() {
  return _memoryCache.size;
}

// ── Disk Cache (L2) ──
function _diskGet(key) {
  const cacheFile = _getCacheFile(key);
  if (!fs.existsSync(cacheFile)) return null;

  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      fs.unlinkSync(cacheFile);
      return null;
    }
    return entry.value;
  } catch (e) {
    return null;
  }
}

function _diskSet(key, value, ttlMs = 86400000) {
  const cacheFile = _getCacheFile(key);
  const entry = {
    key,
    value,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    hits: 0,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
}

function _diskDelete(key) {
  const cacheFile = _getCacheFile(key);
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
  }
}

function _diskClear() {
  const dir = _getCacheDir();
  try {
    fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  } catch (e) { /* empty */ }
}

// ── Cache Operations ──

async function get(key) {
  // L1: Memory
  let value = _memoryGet(key);
  if (value !== null) {
    value._cacheHit = 'memory';
    return value;
  }

  // L2: Disk
  value = _diskGet(key);
  if (value !== null) {
    value._cacheHit = 'disk';
    // Promote to memory
    _memorySet(key, value);
    return value;
  }

  return null;
}

async function set(key, value, options = {}) {
  const ttlMs = options.ttlMs || 300000;
  _memorySet(key, value, ttlMs);
  if (options.persist !== false) {
    _diskSet(key, value, ttlMs * 2); // Disk cache lives longer
  }
  return { success: true, key };
}

async function deleteKey(key) {
  _memoryDelete(key);
  _diskDelete(key);
  return { success: true, key };
}

async function has(key) {
  return _memoryGet(key) !== null || _diskGet(key) !== null;
}

async function clear() {
  _memoryClear();
  _diskClear();
  return { success: true, cleared: true };
}

async function stats() {
  const memoryKeys = _memoryCache.size;
  let diskKeys = 0;
  try {
    diskKeys = fs.readdirSync(_getCacheDir()).filter((f) => f.endsWith('.json')).length;
  } catch (e) { /* empty */ }

  return {
    memory: { keys: memoryKeys },
    disk: { keys: diskKeys },
    total: memoryKeys + diskKeys,
  };
}

// ── Cache Key Generation ──
function generateKey(model, messages, options = {}) {
  const keyData = { model, messages, temperature: options.temperature, maxTokens: options.maxTokens };
  return _hashKey(JSON.stringify(keyData));
}

module.exports = {
  get,
  set,
  deleteKey,
  has,
  clear,
  stats,
  generateKey,
  _memoryCache,
  _memoryClear,
};
