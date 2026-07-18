/**
 * API Key Pool — request-level round-robin selection with cooldown.
 *
 * Inspired by CLIProxyAPI's RoundRobinSelector + Conductor pattern.
 * Pure in-memory state + JSON file persistence. No database required.
 *
 * Features:
 * - Same provider supports multiple API keys
 * - Round-robin rotation within priority groups
 * - Exponential backoff cooldown on 429/403/401
 * - Priority: higher number = preferred
 * - Auto-merges environment variables as single-key fallback
 * - Persistent config at ~/.khyquant/api_keys.json
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 数据家单一真源:复用主 backend 的 getAppHome()/getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppHome, getAppDataDir } = require('../utils/dataHome');
const KHY_DIR = getAppHome();
const POOL_FILE = getAppDataDir('api_keys.json');

// Max backoff level (2^5 * 10s = 320s ≈ 5min)
const MAX_BACKOFF_LEVEL = 5;
const BASE_COOLDOWN_MS = 10000; // 10 seconds
const MAX_COOLDOWN_MS = 300000; // 5 minutes
const MAX_RETRY_AFTER_MS = 600000; // 10 minutes (max server-specified cooldown)

// ── State ──────────────────────────────────────���─────────────────────────

/**
 * @typedef {object} KeyEntry
 * @property {string} id         - Unique identifier (hash of key)
 * @property {string} provider   - Provider name
 * @property {string} key        - API key string
 * @property {string} endpoint   - API endpoint URL
 * @property {number} priority   - Selection priority (higher = preferred)
 * @property {string} label      - Human-readable label
 * @property {'active'|'cooldown'|'disabled'} status
 * @property {number} cooldownUntil  - Timestamp when cooldown expires
 * @property {number} backoffLevel   - 0-5
 * @property {number} totalRequests
 * @property {number} totalFailures
 * @property {number} lastUsedAt
 * @property {string|null} lastError
 */

/** @type {Map<string, KeyEntry[]>} provider → entries */
const _pool = new Map();

/** @type {Map<string, KeyEntry>} keyId → entry */
const _stateMap = new Map();

/** @type {Object<string, number>} provider → cursor index */
const _cursors = {};

let _initialized = false;

const PROVIDER_ALIAS_MAP = Object.freeze({
  qwen: 'alibaba',
  dashscope: 'alibaba',
  tongyi: 'alibaba',
  bailian: 'alibaba',
  aliyun: 'alibaba',
  hf: 'huggingface',
  'hugging-face': 'huggingface',
  'hugging_face': 'huggingface',
});

function normalizeProviderName(raw = '') {
  const provider = String(raw || '').trim().toLowerCase();
  if (!provider) return '';
  return PROVIDER_ALIAS_MAP[provider] || provider;
}

function readFirstEnv(keys = []) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

// Provider → env key mapping (for auto-merge)
const ENV_KEY_MAP = {
  deepseek: {
    keys: ['DEEPSEEK_API_KEY'],
    endpoints: ['DEEPSEEK_API_ENDPOINT'],
    default: 'https://api.deepseek.com/v1',
  },
  alibaba: {
    keys: ['ALIBABA_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    endpoints: ['ALIBABA_API_ENDPOINT', 'DASHSCOPE_API_ENDPOINT', 'QWEN_API_ENDPOINT'],
    default: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  huggingface: {
    keys: ['HUGGINGFACE_TOKEN', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_API_KEY'],
    endpoints: ['HUGGINGFACE_API_ENDPOINT', 'HF_API_ENDPOINT'],
    default: 'https://api-inference.huggingface.co',
  },
  glm: {
    keys: ['GLM_API_KEY'],
    endpoints: ['GLM_API_ENDPOINT'],
    default: 'https://open.bigmodel.cn/api/paas/v4',
  },
  doubao: {
    keys: ['DOUBAO_API_KEY'],
    endpoints: ['DOUBAO_API_ENDPOINT'],
    default: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  wenxin: {
    keys: ['WENXIN_API_KEY'],
    endpoints: ['WENXIN_API_ENDPOINT'],
    default: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop',
  },
  openai: {
    keys: ['OPENAI_API_KEY'],
    endpoints: ['OPENAI_API_ENDPOINT'],
    default: 'https://api.openai.com/v1',
  },
  anthropic: {
    keys: ['ANTHROPIC_API_KEY'],
    endpoints: ['ANTHROPIC_API_ENDPOINT'],
    default: 'https://api.anthropic.com/v1',
  },
  relay: {
    keys: ['RELAY_API_KEY'],
    endpoints: ['RELAY_API_ENDPOINT'],
    default: '',
  },
};

// ── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Initialize the pool. Loads JSON config and merges env variables.
 * Safe to call multiple times (idempotent).
 */
function init() {
  if (_initialized) return;
  _initialized = true;

  // Load persisted config
  let saved = {};
  try {
    if (fs.existsSync(POOL_FILE)) {
      saved = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Register keys from JSON
  for (const [rawProvider, keys] of Object.entries(saved)) {
    const provider = normalizeProviderName(rawProvider);
    if (!provider) continue;
    if (!Array.isArray(keys)) continue;
    for (const cfg of keys) {
      if (!cfg.key) continue;
      const existing = _pool.get(provider) || [];
      if (existing.some(e => e.key === cfg.key)) continue;
      _registerKey(provider, cfg);
    }
  }

  // Merge env vars as fallback (only if not already present)
  for (const [provider, envCfg] of Object.entries(ENV_KEY_MAP)) {
    const envKey = readFirstEnv(envCfg.keys || []);
    if (!envKey) continue;

    // Check if this key already exists in pool
    const existing = _pool.get(provider) || [];
    if (existing.some(e => e.key === envKey)) continue;

    _registerKey(provider, {
      key: envKey,
      endpoint: readFirstEnv(envCfg.endpoints || []) || envCfg.default,
      priority: 0, // env vars are lowest priority (fallback)
      label: 'env',
    });
  }
}

/**
 * Persist current pool config to disk (keys + priority + label + endpoint only).
 * Runtime state (cooldown, stats) is NOT persisted.
 */
function save() {
  const data = {};
  for (const [provider, entries] of _pool) {
    data[provider] = entries
      .filter(e => e.label !== 'env') // Don't persist env-sourced keys
      .map(e => ({
        key: e.key,
        endpoint: e.endpoint,
        priority: e.priority,
        label: e.label,
      }));
    if (data[provider].length === 0) delete data[provider];
  }

  try {
    if (!fs.existsSync(KHY_DIR)) fs.mkdirSync(KHY_DIR, { recursive: true });
    fs.writeFileSync(POOL_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// ── Key Management ───────────────────────────────────────────────────────

/**
 * Add a key to the pool.
 * @param {string} provider
 * @param {{ key: string, endpoint?: string, priority?: number, label?: string }} config
 * @returns {string} keyId
 */
function addKey(provider, config) {
  if (!config.key) throw new Error('API key is required');
  provider = normalizeProviderName(provider);
  if (!provider) throw new Error('provider is required');
  init();

  // Check for duplicate
  const existing = _pool.get(provider) || [];
  if (existing.some(e => e.key === config.key)) {
    throw new Error('This key already exists in the pool');
  }

  const entry = _registerKey(provider, config);
  save();
  return entry.id;
}

/**
 * Remove a key from the pool.
 * @param {string} provider
 * @param {string} keyId
 */
function removeKey(provider, keyId) {
  provider = normalizeProviderName(provider);
  if (!provider) return;
  init();
  const entries = _pool.get(provider);
  if (!entries) return;

  const idx = entries.findIndex(e => e.id === keyId);
  if (idx === -1) return;

  entries.splice(idx, 1);
  _stateMap.delete(keyId);
  if (entries.length === 0) _pool.delete(provider);
  save();
}

/**
 * Disable a key (excluded from selection).
 */
function disableKey(provider, keyId) {
  provider = normalizeProviderName(provider);
  const entry = _stateMap.get(keyId);
  if (entry && (!provider || entry.provider === provider)) entry.status = 'disabled';
}

/**
 * Re-enable a disabled key.
 */
function enableKey(provider, keyId) {
  provider = normalizeProviderName(provider);
  const entry = _stateMap.get(keyId);
  if (entry && (!provider || entry.provider === provider)) {
    entry.status = 'active';
    entry.backoffLevel = 0;
    entry.cooldownUntil = 0;
    entry.lastError = null;
  }
}

// ── Core Selection ───────────────────────────────────────────────────────

/**
 * Pick the next available key for a provider using round-robin.
 * Returns null if no keys available (all disabled or in cooldown).
 *
 * @param {string} provider - Provider name (e.g. 'deepseek', 'relay')
 * @returns {{ key: string, endpoint: string, keyId: string, label: string } | null}
 */
function pick(provider) {
  provider = normalizeProviderName(provider);
  if (!provider) return null;
  init();
  const entries = _pool.get(provider);
  if (!entries || entries.length === 0) return null;

  const now = Date.now();

  // Expire cooldowns
  for (const e of entries) {
    if (e.status === 'cooldown' && e.cooldownUntil <= now) {
      e.status = 'active';
    }
  }

  // Filter available (active only + has concurrency slots)
  const slots = require('./concurrencySlots');
  const available = entries.filter(e => e.status === 'active' && slots.hasAvailableSlot(e.id));
  if (available.length === 0) return null;

  // Sort by priority descending
  available.sort((a, b) => b.priority - a.priority);

  // Group by top priority level
  const topPriority = available[0].priority;
  const topGroup = available.filter(e => e.priority === topPriority);

  // Round-robin within top group
  const cursor = (_cursors[provider] || 0) % topGroup.length;
  _cursors[provider] = cursor + 1;

  const selected = topGroup[cursor];
  selected.lastUsedAt = now;
  selected.totalRequests++;

  return {
    key: selected.key,
    endpoint: selected.endpoint,
    keyId: selected.id,
    label: selected.label,
  };
}

/**
 * Mark a key as successfully used. Reduces backoff level gradually.
 * @param {string} keyId
 */
function markSuccess(keyId) {
  const entry = _stateMap.get(keyId);
  if (!entry) return;

  if (entry.backoffLevel > 0) entry.backoffLevel--;
  entry.status = 'active';
  entry.lastError = null;
}

/**
 * Parse Retry-After header value to milliseconds.
 * Supports numeric (seconds) and HTTP-date formats.
 * @param {string} value - Retry-After header value
 * @returns {number} cooldown in ms, clamped to [BASE_COOLDOWN_MS, MAX_RETRY_AFTER_MS]
 */
const parseRetryAfter = (value) => require('../../../backend/src/utils/parseRetryAfterCooldown')(value, BASE_COOLDOWN_MS, MAX_RETRY_AFTER_MS);

/**
 * Mark a key as failed. Applies cooldown for rate limit / auth errors.
 * If Retry-After header is present on 429, uses server-specified cooldown.
 * @param {string} keyId
 * @param {number} statusCode - HTTP status code (429, 403, 401, etc.)
 * @param {string} [errorMsg] - Error message
 * @param {object|null} [responseHeaders] - Response headers (for Retry-After parsing)
 */
function markFailure(keyId, statusCode, errorMsg = '', responseHeaders = null) {
  const entry = _stateMap.get(keyId);
  if (!entry) return;

  entry.totalFailures++;
  entry.lastError = errorMsg || `HTTP ${statusCode}`;

  // Only apply cooldown for rate limit / auth / quota errors
  const shouldCooldown =
    [429, 403, 401].includes(statusCode) ||
    /rate.?limit|quota|exceeded|too.?many|overloaded/i.test(errorMsg);

  if (shouldCooldown) {
    entry.backoffLevel = Math.min(entry.backoffLevel + 1, MAX_BACKOFF_LEVEL);

    // Use Retry-After header if available on 429
    const retryAfter = responseHeaders?.['retry-after'] || responseHeaders?.['Retry-After'];
    let backoffMs;
    if (statusCode === 429 && retryAfter) {
      backoffMs = parseRetryAfter(retryAfter);
    } else {
      backoffMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * Math.pow(2, entry.backoffLevel - 1));
    }

    entry.cooldownUntil = Date.now() + backoffMs;
    entry.status = 'cooldown';
  }
}

// ── Introspection ────────────────────────────────────────────────────────

/**
 * Get pool status for a specific provider.
 * @param {string} provider
 * @returns {Array<{ keyId, keyPreview, endpoint, label, priority, status, cooldownRemaining, totalRequests, totalFailures, lastError }>}
 */
function getPoolStatus(provider) {
  provider = normalizeProviderName(provider);
  if (!provider) return [];
  init();
  const entries = _pool.get(provider);
  if (!entries) return [];

  const now = Date.now();
  return entries.map(e => {
    // Expire cooldown if needed
    if (e.status === 'cooldown' && e.cooldownUntil <= now) {
      e.status = 'active';
    }

    return {
      keyId: e.id,
      keyPreview: maskKey(e.key),
      endpoint: e.endpoint || '',
      label: e.label,
      priority: e.priority,
      status: e.status,
      cooldownRemaining: e.status === 'cooldown' ? Math.ceil((e.cooldownUntil - now) / 1000) : 0,
      totalRequests: e.totalRequests,
      totalFailures: e.totalFailures,
      lastError: e.lastError,
    };
  });
}

/**
 * Get all providers and their status.
 * @returns {Object<string, Array>}
 */
function getAllStatus() {
  init();
  const result = {};
  for (const provider of _pool.keys()) {
    result[provider] = getPoolStatus(provider);
  }
  return result;
}

/**
 * Get list of all configured providers.
 * @returns {string[]}
 */
function getProviders() {
  init();
  return [..._pool.keys()];
}

/**
 * Check if a provider has any available keys.
 * @param {string} provider
 * @returns {boolean}
 */
function hasAvailableKeys(provider) {
  provider = normalizeProviderName(provider);
  if (!provider) return false;
  init();
  const entries = _pool.get(provider);
  if (!entries || entries.length === 0) return false;
  const now = Date.now();
  return entries.some(e =>
    e.status === 'active' || (e.status === 'cooldown' && e.cooldownUntil <= now)
  );
}

/**
 * Update mutable key metadata.
 * @param {string} provider
 * @param {string} keyId
 * @param {{ endpoint?: string, priority?: number, label?: string }} updates
 * @returns {object}
 */
function updateKey(provider, keyId, updates = {}) {
  provider = normalizeProviderName(provider);
  if (!provider) throw new Error('provider is required');
  init();
  const entries = _pool.get(provider);
  if (!entries) throw new Error(`Provider not found: ${provider}`);
  const entry = entries.find(item => item.id === keyId);
  if (!entry) throw new Error(`Key not found: ${keyId}`);

  if (updates.endpoint !== undefined) entry.endpoint = String(updates.endpoint || '').trim();
  if (updates.label !== undefined) entry.label = String(updates.label || '').trim();
  if (updates.priority !== undefined) {
    const p = Number(updates.priority);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      throw new Error('priority must be a number between 0 and 100');
    }
    entry.priority = p;
  }

  save();
  return {
    keyId: entry.id,
    provider: entry.provider,
    keyPreview: maskKey(entry.key),
    endpoint: entry.endpoint || '',
    label: entry.label,
    priority: entry.priority,
    status: entry.status,
    totalRequests: entry.totalRequests,
    totalFailures: entry.totalFailures,
    lastError: entry.lastError,
  };
}

// ── Internal ─────────────────────────────────────────────────────────────

function _registerKey(provider, config) {
  const id = crypto.createHash('md5').update(`${provider}:${config.key}`).digest('hex').slice(0, 12);

  const entry = {
    id,
    provider,
    key: config.key,
    endpoint: config.endpoint || '',
    priority: config.priority ?? 0,
    label: config.label || '',
    status: 'active',
    cooldownUntil: 0,
    backoffLevel: 0,
    totalRequests: 0,
    totalFailures: 0,
    lastUsedAt: 0,
    lastError: null,
  };

  if (!_pool.has(provider)) _pool.set(provider, []);
  _pool.get(provider).push(entry);
  _stateMap.set(id, entry);

  // Register concurrency slot for this key
  const slots = require('./concurrencySlots');
  slots.register(id, provider);

  return entry;
}

function maskKey(key) {
  if (!key || key.length < 10) return '***';
  return key.slice(0, 6) + '...' + key.slice(-4);
}

module.exports = {
  init,
  save,
  addKey,
  removeKey,
  disableKey,
  enableKey,
  pick,
  markSuccess,
  markFailure,
  getPoolStatus,
  getAllStatus,
  getProviders,
  hasAvailableKeys,
  updateKey,
};
