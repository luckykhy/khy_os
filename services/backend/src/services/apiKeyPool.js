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
const { parseApiKeyEntries, parseApiKeyList } = require('./apiKeyFormat');
const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const KHY_DIR = getDataHome();
const POOL_FILE = path.join(KHY_DIR, 'api_keys.json');
const LEGACY_POOL_FILE = path.join(getLegacyDataHome(), 'api_keys.json');

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

// Provider → env key mapping (for auto-merge)
const ENV_KEY_MAP = {
  sensenova: { key: 'SENSENOVA_API_KEY', endpoint: 'SENSENOVA_API_ENDPOINT', default: 'https://token.sensenova.cn/v1' },
  deepseek: { key: 'DEEPSEEK_API_KEY', endpoint: 'DEEPSEEK_API_ENDPOINT', default: 'https://api.deepseek.com/v1' },
  qwen: { key: 'QWEN_API_KEY', endpoint: 'QWEN_API_ENDPOINT', default: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  glm: { key: 'GLM_API_KEY', endpoint: 'GLM_API_ENDPOINT', default: 'https://open.bigmodel.cn/api/paas/v4' },
  doubao: { key: 'DOUBAO_API_KEY', endpoint: 'DOUBAO_API_ENDPOINT', default: 'https://ark.cn-beijing.volces.com/api/v3' },
  wenxin: { key: 'WENXIN_API_KEY', endpoint: 'WENXIN_API_ENDPOINT', default: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop' },
  openai: { key: 'OPENAI_API_KEY', endpoint: 'OPENAI_API_ENDPOINT', default: 'https://api.openai.com/v1' },
  anthropic: { key: 'ANTHROPIC_API_KEY', endpoint: 'ANTHROPIC_API_ENDPOINT', default: 'https://api.anthropic.com/v1' },
  // Trae 使用加密原生协议（adaptive-api.trae.ai），非 OpenAI 兼容；不设 api.trae.ai 默认端点（避免 404）。
  trae: { key: 'TRAE_API_KEY', endpoint: 'TRAE_API_ENDPOINT', default: '' },
  relay: { key: 'RELAY_API_KEY', endpoint: 'RELAY_API_ENDPOINT', default: '' },
  codex: { key: 'CODEX_API_KEY', endpoint: 'CODEX_API_ENDPOINT', default: '' },
  sensenova: { key: 'SENSENOVA_API_KEY', endpoint: 'SENSENOVA_API_ENDPOINT', default: 'https://token.sensenova.cn/v1' },
};

// 内置 provider 默认 key（pip 安装后无需 khy init 即可使用）
const BUILTIN_PROVIDER_KEYS = {
  sensenova: {
    key: 'sk-VGIvz88JG36VuWGRnvjJrtT8tMv8mgUc',
    endpoint: 'https://token.sensenova.cn/v1',
    priority: 10,
    label: 'built-in',
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

  // One-time legacy migration: ~/.khyquant/api_keys.json → getDataHome().
  // Read-old-write-new; never delete the legacy file.
  try {
    if (POOL_FILE !== LEGACY_POOL_FILE
      && !fs.existsSync(POOL_FILE)
      && fs.existsSync(LEGACY_POOL_FILE)) {
      const legacy = fs.readFileSync(LEGACY_POOL_FILE, 'utf-8');
      if (!fs.existsSync(KHY_DIR)) fs.mkdirSync(KHY_DIR, { recursive: true });
      fs.writeFileSync(POOL_FILE, legacy, 'utf-8');
    }
  } catch { /* migration is best-effort; fall through to normal load */ }

  // Load persisted config
  let saved = {};
  try {
    if (fs.existsSync(POOL_FILE)) {
      saved = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Register keys from JSON
  for (const [provider, rawConfig] of Object.entries(saved)) {
    const parsedEntries = parseApiKeyEntries(rawConfig, {
      endpoint: '',
      priority: 0,
      label: '',
    });
    for (const cfg of parsedEntries) {
      if (!cfg.key) continue;
      _registerKey(provider, cfg);
    }
  }

  // Merge env vars as fallback (only if not already present)
  for (const [provider, envCfg] of Object.entries(ENV_KEY_MAP)) {
    const keysFromEnv = _collectProviderEnvKeys(provider, envCfg.key);
    if (keysFromEnv.length === 0) continue;

    // Check if this key already exists in pool
    const existing = _pool.get(provider) || [];
    for (const envKey of keysFromEnv) {
      if (existing.some(e => e.key === envKey)) continue;
      _registerKey(provider, {
        key: envKey,
        endpoint: process.env[envCfg.endpoint] || envCfg.default,
        priority: 0, // env vars are lowest priority (fallback)
        label: 'env',
      });
    }
  }

  // Merge built-in provider keys as fallback (only if not already present)
  for (const [provider, cfg] of Object.entries(BUILTIN_PROVIDER_KEYS)) {
    const existing = _pool.get(provider) || [];
    if (existing.some(e => e.key === cfg.key)) continue;
    _registerKey(provider, { ...cfg });
  }

  // GLM 占位 key(pip 安装后开箱可用;门控 KHY_BUILTIN_GLM_KEY 默认开)。fail-soft:异常/门关
  // → 不并入,逐字节回退。priority 0 → 用户经 NL/Web 添加的真 key(priority 10)恒盖过它。
  try {
    const { builtinGlmKeyEntries } = require('./builtinGlmKey');
    for (const [provider, cfg] of Object.entries(builtinGlmKeyEntries(process.env))) {
      const existing = _pool.get(provider) || [];
      if (existing.some(e => e.key === cfg.key)) continue;
      _registerKey(provider, { ...cfg });
    }
  } catch { /* fail-soft: 不并入占位 key */ }
}

/**
 * Hot-reload the pool from its live sources WITHOUT a process restart.
 *
 * Re-derives the desired key set from the SAME three sources `init()` uses —
 * POOL_FILE JSON + env vars + builtin fallbacks — and reconciles it against the
 * in-memory pool by the deterministic id (md5(`${provider}:${key}`)):
 *   - a key that newly appears is registered (runtime state starts fresh);
 *   - a key that still exists keeps ALL its runtime state (status, cooldown,
 *     backoff, stats) and only refreshes mutable metadata (endpoint/priority/label);
 *   - a key that has vanished is removed and its concurrency slot freed.
 *
 * This is intentionally NOT `init()`: init() is one-shot guarded and only ever
 * ADDS. reload() is the live path that also REMOVES and REFRESHES, so a key
 * edited/deleted in .env or api_keys.json (by a direct file edit, the CLI in a
 * separate process, or the in-process Web writer) takes effect immediately.
 *
 * Critically it NEVER calls save() — env-sourced keys are not persisted anyway,
 * and persisting here would create a save→watch→reload feedback loop. Callers
 * that mutate via addKey/removeKey already persist; reload only mirrors what is
 * already on disk / in the environment into memory.
 *
 * @returns {{added:number, removed:number, updated:number, total:number}}
 */
function reload() {
  if (!_initialized) { init(); return { added: _stateMap.size, removed: 0, updated: 0, total: _stateMap.size }; }
  const slots = require('./concurrencySlots');

  // id -> { id, provider, config } — the set we WANT after reload.
  const desired = new Map();
  const want = (provider, config) => {
    if (!config || !config.key) return;
    const id = crypto.createHash('md5').update(`${provider}:${config.key}`).digest('hex').slice(0, 12);
    if (!desired.has(id)) desired.set(id, { id, provider, config });
  };

  // 1a. Persisted JSON config (re-read from disk; never mutate process.env).
  let saved = {};
  try {
    if (fs.existsSync(POOL_FILE)) saved = JSON.parse(fs.readFileSync(POOL_FILE, 'utf-8'));
  } catch { /* ignore corrupt file — keep current pool for those providers */ }
  for (const [provider, rawConfig] of Object.entries(saved)) {
    const parsedEntries = parseApiKeyEntries(rawConfig, { endpoint: '', priority: 0, label: '' });
    for (const cfg of parsedEntries) want(provider, cfg);
  }

  // 1b. Environment variables (the watcher has already overlaid any .env edits
  //     into process.env before calling reload).
  for (const [provider, envCfg] of Object.entries(ENV_KEY_MAP)) {
    for (const envKey of _collectProviderEnvKeys(provider, envCfg.key)) {
      want(provider, {
        key: envKey,
        endpoint: process.env[envCfg.endpoint] || envCfg.default,
        priority: 0,
        label: 'env',
      });
    }
  }

  // 1c. Builtin fallbacks (always available, same as init).
  for (const [provider, cfg] of Object.entries(BUILTIN_PROVIDER_KEYS)) {
    want(provider, { ...cfg });
  }

  // 1d. GLM 占位 key(门控 KHY_BUILTIN_GLM_KEY 默认开;fail-soft)。门关 → desired 集不含它
  //     → 若之前并入过则被 reload 移除,逐字节回退。
  try {
    const { builtinGlmKeyEntries } = require('./builtinGlmKey');
    for (const [provider, cfg] of Object.entries(builtinGlmKeyEntries(process.env))) {
      want(provider, { ...cfg });
    }
  } catch { /* fail-soft: 不并入占位 key */ }

  let added = 0;
  let updated = 0;
  let removed = 0;

  // 2. Add new / refresh existing — preserve runtime state on the survivors.
  for (const { id, provider, config } of desired.values()) {
    const existing = _stateMap.get(id);
    if (!existing) {
      _registerKey(provider, config);
      added += 1;
    } else {
      // Same key (id is md5 of provider:key) → keep status/cooldown/stats,
      // only update mutable metadata that may have changed on disk/env.
      const nextEndpoint = config.endpoint || '';
      const nextPriority = config.priority ?? 0;
      const nextLabel = config.label || '';
      if (existing.endpoint !== nextEndpoint || existing.priority !== nextPriority || existing.label !== nextLabel) {
        existing.endpoint = nextEndpoint;
        existing.priority = nextPriority;
        existing.label = nextLabel;
        updated += 1;
      }
    }
  }

  // 3. Remove vanished keys — and free their concurrency slot (init/removeKey
  //    never freed slots on the env path; reload makes that whole again).
  for (const [id, entry] of [..._stateMap]) {
    if (desired.has(id)) continue;
    const entries = _pool.get(entry.provider);
    if (entries) {
      const idx = entries.findIndex(e => e.id === id);
      if (idx !== -1) entries.splice(idx, 1);
      if (entries.length === 0) _pool.delete(entry.provider);
    }
    _stateMap.delete(id);
    try { slots.unregister(id); } catch { /* slot may already be gone */ }
    removed += 1;
  }

  return { added, removed, updated, total: _stateMap.size };
}

/** Absolute path to the persisted pool JSON (so the watcher can watch it). */
function getPoolFilePath() {
  return POOL_FILE;
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
      .filter(e => !e.placeholder && !_isPlaceholderKey(e.key)) // Don't persist placeholder/non-functional keys
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
  const entry = _stateMap.get(keyId);
  if (entry) entry.status = 'disabled';
}

/**
 * Re-enable a disabled key.
 */
function enableKey(provider, keyId) {
  const entry = _stateMap.get(keyId);
  if (entry) {
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
  init();
  const available = _collectAvailableEntries(provider);
  if (available.length === 0) return null;

  // Sort by priority descending
  available.sort((a, b) => b.priority - a.priority);

  // Group by top priority level
  const topPriority = available[0].priority;
  const topGroup = available.filter(e => e.priority === topPriority);

  // Round-robin within top group
  const cursor = (_cursors[provider] || 0) % topGroup.length;
  _cursors[provider] = (cursor + 1) % topGroup.length;

  const selected = topGroup[cursor];
  return _touchAndFormatSelection(selected);
}

/**
 * Pick a specific key by keyId if currently available.
 * Returns null when the key is unavailable.
 *
 * @param {string} provider
 * @param {string} keyId
 * @returns {{ key: string, endpoint: string, keyId: string, label: string } | null}
 */
function pickById(provider, keyId) {
  init();
  const targetId = String(keyId || '').trim();
  if (!targetId) return null;
  const available = _collectAvailableEntries(provider);
  const selected = available.find(e => e.id === targetId);
  if (!selected) return null;
  return _touchAndFormatSelection(selected);
}

/**
 * Get available keys for selection strategy planning.
 * Includes runtime stats and raw key for internal gateway use.
 *
 * @param {string} provider
 * @returns {Array<{ keyId, key, endpoint, label, priority, status, backoffLevel, totalRequests, totalFailures, lastUsedAt, lastError }>}
 */
function listAvailableKeys(provider) {
  init();
  const available = _collectAvailableEntries(provider);
  return available.map((e) => ({
    keyId: e.id,
    key: e.key,
    endpoint: e.endpoint,
    label: e.label,
    priority: e.priority,
    status: e.status,
    backoffLevel: e.backoffLevel,
    totalRequests: e.totalRequests,
    totalFailures: e.totalFailures,
    lastUsedAt: e.lastUsedAt,
    lastError: e.lastError,
  }));
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
const parseRetryAfter = (value) => require('../utils/parseRetryAfterCooldown')(value, BASE_COOLDOWN_MS, MAX_RETRY_AFTER_MS);

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
 * @returns {Array<{ keyId, keyPreview, label, priority, status, cooldownRemaining, totalRequests, totalFailures, lastError }>}
 */
function getPoolStatus(provider) {
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
  init();
  return _collectAvailableEntries(provider).length > 0;
}

// ── Internal ─────────────────────────────────────────────────────────────

// Known non-functional placeholder key values (single-sourced from their owning
// leaf). Used to recognize a placeholder even when it was loaded from persisted
// JSON without the explicit `placeholder` flag. Fail-soft: any error → empty set.
let _placeholderKeysCache = null;
function _placeholderKeys() {
  if (_placeholderKeysCache) return _placeholderKeysCache;
  const set = new Set();
  try {
    const { GLM_PLACEHOLDER_KEY } = require('./builtinGlmKey');
    if (GLM_PLACEHOLDER_KEY) set.add(GLM_PLACEHOLDER_KEY);
  } catch { /* fail-soft: no placeholder recognition */ }
  _placeholderKeysCache = set;
  return set;
}

function _isPlaceholderKey(key) {
  try { return _placeholderKeys().has(key); } catch { return false; }
}

function _collectAvailableEntries(provider) {
  const entries = _pool.get(provider);
  if (!entries || entries.length === 0) return [];

  const now = Date.now();
  for (const e of entries) {
    if (e.status === 'cooldown' && e.cooldownUntil <= now) {
      e.status = 'active';
    }
  }

  const slots = require('./concurrencySlots');
  // Placeholder entries (e.g. the built-in GLM placeholder key that cannot actually
  // call the provider) are NEVER usable: excluding them here means hasAvailableKeys()
  // reports the provider as unconfigured AND pick() never sends the fake key upstream.
  // They remain visible via getPoolStatus() so the provider still shows as "configured".
  return entries.filter(e => !e.placeholder && e.status === 'active' && slots.hasAvailableSlot(e.id));
}

function _touchAndFormatSelection(entry) {
  if (!entry) return null;
  entry.lastUsedAt = Date.now();
  entry.totalRequests++;
  return {
    key: entry.key,
    endpoint: entry.endpoint,
    keyId: entry.id,
    label: entry.label,
  };
}

function _registerKey(provider, config) {
  const id = crypto.createHash('md5').update(`${provider}:${config.key}`).digest('hex').slice(0, 12);

  const entry = {
    id,
    provider,
    key: config.key,
    endpoint: config.endpoint || '',
    priority: config.priority ?? 0,
    label: config.label || '',
    // 占位/不可用凭据标记(如内置 GLM 占位 key):true → 从可用性/选择路径排除,但仍在
    // getPoolStatus introspection 中列出。默认 false(普通真实 key)。既支持显式标记
    // (builtinGlmKeyEntries 并入时),也按 key 值兜底识别——因为占位 key 曾被 save() 持久化到
    // api_keys.json,重载时以普通 JSON 条目回来、不带 placeholder 标记;值兜底确保这条历史遗留
    // 也被正确排除,不会再被当作可发请求的真实凭据。
    placeholder: config.placeholder === true || _isPlaceholderKey(config.key),
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

function _collectProviderEnvKeys(provider, primaryEnvKeyName) {
  const prefix = String(provider || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_');

  const candidates = [];
  if (primaryEnvKeyName) candidates.push(process.env[primaryEnvKeyName]);
  if (prefix) {
    candidates.push(process.env[`${prefix}_API_KEYS`]);
    for (let i = 1; i <= 10; i++) {
      candidates.push(process.env[`${prefix}_API_KEY_${i}`]);
    }
  }

  const flattened = candidates.flatMap(value => parseApiKeyList(value));
  const deduped = [];
  const seen = new Set();
  for (const token of flattened) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    deduped.push(token);
  }
  return deduped;
}

module.exports = {
  init,
  reload,
  getPoolFilePath,
  save,
  addKey,
  removeKey,
  disableKey,
  enableKey,
  pick,
  pickById,
  listAvailableKeys,
  markSuccess,
  markFailure,
  getPoolStatus,
  getAllStatus,
  getProviders,
  hasAvailableKeys,
  BUILTIN_PROVIDER_KEYS,
};
