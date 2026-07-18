/**
 * Account Pool Service — Antigravity-style multi-account management
 * with tier-based routing, circuit breaker, health scoring, and auto-failover.
 *
 * Scheduling modes:
 *   - PerformanceFirst: Pure round-robin across highest-tier accounts
 *   - Balance: Sticky per session, fast-fallback on failure
 *   - CacheFirst: Aggressive stickiness, only switch after max_wait
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 数据家单一真源:复用主 backend 的 getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppDataDir } = require('./../utils/dataHome');

// Tier priority weights (ULTRA > PRO > FREE)
const TIER_WEIGHT = { ULTRA: 300, PRO: 200, FREE: 100 };

// Default backoff steps in seconds (circuit breaker)
const DEFAULT_BACKOFF_STEPS = [60, 300, 1800, 7200];

// In-memory pool + scheduling state
let _accounts = [];       // Array of account objects from DB
let _initialized = false;
let _roundRobinIdx = {};  // { provider: index }
let _stickyMap = {};      // { sessionId: { accountId, timestamp } }
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL for sticky entries
const STICKY_MAX_ENTRIES = 10000;      // Hard cap to prevent OOM
let _lastStickyCleanup = Date.now();

// Config (persisted to DB or file)
let _config = {
  schedulingMode: 'PerformanceFirst', // PerformanceFirst | Balance | CacheFirst
  maxWaitSeconds: 30,                 // For CacheFirst mode
  circuitBreaker: {
    enabled: true,
    backoffSteps: DEFAULT_BACKOFF_STEPS,
  },
  quotaThreshold: 10, // Protect when remaining < 10%
};

const CONFIG_PATH = getAppDataDir('account_pool_config.json');

/**
 * Evict expired entries from _stickyMap to prevent memory leak.
 */
function _cleanupStickyMap() {
  const now = Date.now();
  if (now - _lastStickyCleanup < 60_000) return; // At most once per minute
  _lastStickyCleanup = now;
  const keys = Object.keys(_stickyMap);
  for (const key of keys) {
    if (now - _stickyMap[key].timestamp > STICKY_TTL_MS) {
      delete _stickyMap[key];
    }
  }
  // Hard cap: if still too many entries, remove oldest
  const remaining = Object.keys(_stickyMap);
  if (remaining.length > STICKY_MAX_ENTRIES) {
    remaining
      .sort((a, b) => _stickyMap[a].timestamp - _stickyMap[b].timestamp)
      .slice(0, remaining.length - STICKY_MAX_ENTRIES)
      .forEach(k => delete _stickyMap[k]);
  }
}

function _loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      _config = { ..._config, ...data };
    }
  } catch { /* use defaults */ }
}

function _saveConfig() {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
  } catch { /* ignore */ }
}

/**
 * Initialize the account pool from database.
 */
async function init() {
  if (_initialized) return;
  _loadConfig();

  try {
    const { AIAccount } = require('@khy/shared/models');
    const rows = await AIAccount.findAll({ order: [['priority', 'DESC'], ['createdAt', 'ASC']] });
    _accounts = rows.map(r => r.toJSON());
  } catch (err) {
    console.warn('[AccountPool] DB load failed, starting empty:', err.message);
    _accounts = [];
  }

  // Import legacy api_keys.json if pool is empty
  if (_accounts.length === 0) {
    _importLegacyKeys();
  }

  _initialized = true;
}

/**
 * Import keys from legacy apiKeyPool JSON file as FREE-tier accounts.
 */
function _importLegacyKeys() {
  try {
    const legacyPath = getAppDataDir('api_keys.json');
    if (!fs.existsSync(legacyPath)) return;
    const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    for (const [provider, keys] of Object.entries(data)) {
      if (!Array.isArray(keys)) continue;
      for (const k of keys) {
        _accounts.push({
          id: null, // will be assigned on DB save
          provider,
          label: k.label || '',
          email: '',
          apiKey: k.key,
          endpoint: k.endpoint || '',
          tier: 'FREE',
          priority: k.priority || 0,
          status: 'active',
          healthScore: 1.0,
          quotaRemaining: 100.0,
          totalRequests: k.requestCount || 0,
          totalFailures: k.totalFailures || 0,
          consecutiveFails: 0,
          lastUsedAt: k.lastUsed ? new Date(k.lastUsed) : null,
          backoffLevel: 0,
          config: {},
          disabled: k.disabled || false,
        });
      }
    }
  } catch { /* ignore */ }
}

/**
 * Compute health score for an account. Always in [0, 1.0].
 */
function _computeHealth(account) {
  const failRate = account.totalRequests > 0
    ? Math.min(account.totalFailures / account.totalRequests, 1.0)
    : 0;
  const cooldownPenalty = (account.status === 'cooldown') ? 1.0 : 0;
  const quotaPenalty = Math.max(0, 1.0 - (Math.min(account.quotaRemaining, 100) / 100));
  return Math.max(0, Math.min(1.0, 1.0 - (failRate * 0.5) - (cooldownPenalty * 0.3) - (quotaPenalty * 0.2)));
}

/**
 * Try to reactivate accounts whose cooldown/circuit has expired.
 * Called explicitly before pick(), separate from the check function.
 */
function _tryReactivateExpired() {
  const now = new Date();
  for (const account of _accounts) {
    if (account.status === 'cooldown' && account.cooldownUntil && new Date(account.cooldownUntil) <= now) {
      account.status = 'active';
    }
    if (account.status === 'circuit_open' && account.circuitOpenUntil && new Date(account.circuitOpenUntil) <= now) {
      account.status = 'active';
    }
  }
}

/**
 * Check if an account is currently usable (pure check, no side effects).
 */
function _isUsable(account) {
  if (account.disabled) return false;
  if (account.status === 'disabled') return false;
  if (account.status === 'cooldown') return false;
  if (account.status === 'circuit_open') return false;
  return true;
}

/**
 * Pick the best available account for a provider.
 * @param {string} provider - Provider name
 * @param {object} [options] - { sessionId, model }
 * @returns {{ key, endpoint, accountId, label, tier } | null}
 */
function pick(provider, options = {}) {
  if (!_initialized) return null;

  const { sessionId, model } = options;

  // Reactivate expired cooldown/circuit accounts before filtering
  _tryReactivateExpired();
  // Periodic sticky map cleanup
  _cleanupStickyMap();

  const candidates = _accounts.filter(a =>
    a.provider === provider && _isUsable(a) &&
    !(model && a.config?.protectedModels?.includes(model))
  );

  if (candidates.length === 0) return null;

  // Sort: tier desc → composite score desc
  candidates.sort((a, b) => {
    const tierDiff = (TIER_WEIGHT[b.tier] || 0) - (TIER_WEIGHT[a.tier] || 0);
    if (tierDiff !== 0) return tierDiff;
    const scoreA = _computeHealth(a) * (a.quotaRemaining / 100) + (a.priority * 0.01);
    const scoreB = _computeHealth(b) * (b.quotaRemaining / 100) + (b.priority * 0.01);
    return scoreB - scoreA;
  });

  let selected = null;

  // Scheduling mode logic
  if (_config.schedulingMode === 'CacheFirst' && sessionId) {
    const sticky = _stickyMap[sessionId];
    if (sticky) {
      const stickyAccount = candidates.find(a => a.id != null && a.id === sticky.accountId);
      if (stickyAccount) {
        const elapsed = (Date.now() - sticky.timestamp) / 1000;
        if (elapsed < _config.maxWaitSeconds) {
          selected = stickyAccount;
        }
      }
    }
  } else if (_config.schedulingMode === 'Balance' && sessionId) {
    const sticky = _stickyMap[sessionId];
    if (sticky) {
      const stickyAccount = candidates.find(a => a.id != null && a.id === sticky.accountId);
      if (stickyAccount) selected = stickyAccount;
    }
  }

  // PerformanceFirst or no sticky match: round-robin by account ID for stability
  if (!selected) {
    // Use stable round-robin based on account IDs, not array index
    const idx = (_roundRobinIdx[provider] || 0) % candidates.length;
    selected = candidates[idx];
    _roundRobinIdx[provider] = (idx + 1) % candidates.length; // wrap to prevent unbounded growth
  }

  // Update sticky (only for accounts with valid IDs)
  if (sessionId && selected && selected.id != null) {
    _stickyMap[sessionId] = { accountId: selected.id, timestamp: Date.now() };
  }

  // Mark as used
  selected.lastUsedAt = new Date();

  return {
    key: selected.apiKey,
    endpoint: selected.endpoint,
    accountId: selected.id,
    label: selected.label,
    tier: selected.tier,
  };
}

/**
 * Mark an account as successfully used.
 */
function markSuccess(accountId) {
  const account = _accounts.find(a => a.id === accountId);
  if (!account) return;

  account.totalRequests++;
  account.consecutiveFails = 0;
  account.backoffLevel = 0;
  account.status = 'active';
  account.healthScore = _computeHealth(account);

  _persistAccount(account);
}

/**
 * Mark an account failure with auto-cooldown and circuit breaker.
 * @param {number} accountId
 * @param {number} statusCode - HTTP status (429, 401, 500, etc.)
 * @param {string} [errorMsg]
 * @param {object} [headers] - Response headers (for Retry-After)
 */
function markFailure(accountId, statusCode, errorMsg, headers) {
  const account = _accounts.find(a => a.id === accountId);
  if (!account) return;

  account.totalRequests++;
  account.totalFailures++;
  account.consecutiveFails++;
  account.lastErrorAt = new Date();
  account.lastError = errorMsg || `HTTP ${statusCode}`;

  // 401: disable immediately
  if (statusCode === 401) {
    account.status = 'disabled';
    account.disabled = true;
    _persistAccount(account);
    return;
  }

  // 429: cooldown based on Retry-After
  if (statusCode === 429) {
    let cooldownSec = 60;
    if (headers?.['retry-after']) {
      const retryAfter = parseInt(headers['retry-after'], 10);
      if (!isNaN(retryAfter)) cooldownSec = retryAfter;
    }
    account.status = 'cooldown';
    account.cooldownUntil = new Date(Date.now() + cooldownSec * 1000);
    _persistAccount(account);
    return;
  }

  // Circuit breaker for repeated failures
  if (_config.circuitBreaker.enabled) {
    const steps = _config.circuitBreaker.backoffSteps || DEFAULT_BACKOFF_STEPS;
    if (account.consecutiveFails >= 3) {
      const level = Math.min(account.backoffLevel, steps.length - 1);
      const waitSec = steps[level];
      account.status = 'circuit_open';
      account.circuitOpenUntil = new Date(Date.now() + waitSec * 1000);
      account.backoffLevel = level + 1;
    }
  }

  account.healthScore = _computeHealth(account);
  _persistAccount(account);
}

/**
 * Persist account changes to database (async, fire-and-forget).
 */
function _persistAccount(account) {
  if (!account.id) return; // not yet in DB (legacy import)
  try {
    const { AIAccount } = require('@khy/shared/models');
    AIAccount.update(account, { where: { id: account.id } }).catch(err => {
      console.warn(`[AccountPool] Failed to persist account ${account.id}:`, err.message);
    });
  } catch (err) {
    console.warn('[AccountPool] DB module unavailable:', err.message);
  }
}

// ── CRUD Operations ──

async function addAccount(data) {
  const { AIAccount } = require('@khy/shared/models');
  const record = await AIAccount.create({
    provider: data.provider,
    label: data.label || '',
    email: data.email || '',
    apiKey: data.apiKey,
    endpoint: data.endpoint || '',
    tier: data.tier || 'FREE',
    priority: data.priority || 0,
    disabled: false,
    status: 'active',
    healthScore: 1.0,
    quotaRemaining: 100.0,
  });
  const json = record.toJSON();
  _accounts.push(json);
  // Return masked copy — never leak full apiKey in responses
  return { ...json, apiKey: json.apiKey ? json.apiKey.slice(0, 8) + '...' : '' };
}

async function updateAccount(id, updates) {
  const { AIAccount } = require('@khy/shared/models');
  const allowed = ['label', 'email', 'apiKey', 'endpoint', 'tier', 'priority', 'disabled'];
  const filtered = {};
  for (const k of allowed) {
    if (updates[k] !== undefined) filtered[k] = updates[k];
  }
  await AIAccount.update(filtered, { where: { id } });
  // Update in-memory
  const idx = _accounts.findIndex(a => a.id === id);
  if (idx >= 0) Object.assign(_accounts[idx], filtered);
  return { id, ...filtered };
}

async function removeAccount(id) {
  const { AIAccount } = require('@khy/shared/models');
  await AIAccount.destroy({ where: { id } });
  _accounts = _accounts.filter(a => a.id !== id);
  return true;
}

/**
 * Batch-delete accounts by id. Non-numeric ids are ignored.
 * @param {Array<number|string>} ids
 * @returns {Promise<{ removed: number, ids: number[] }>}
 */
async function removeAccounts(ids) {
  const valid = [...new Set(
    (Array.isArray(ids) ? ids : [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
  )];
  if (valid.length === 0) return { removed: 0, ids: [] };

  const { AIAccount } = require('@khy/shared/models');
  await AIAccount.destroy({ where: { id: valid } });
  const removeSet = new Set(valid);
  _accounts = _accounts.filter(a => !removeSet.has(Number(a.id)));
  return { removed: valid.length, ids: valid };
}

/**
 * Delete every account, or every account of one provider when provider is set.
 * @param {string} [provider] provider filter; empty = all providers.
 * @returns {Promise<{ removed: number }>}
 */
async function removeAllAccounts(provider = '') {
  const { AIAccount } = require('@khy/shared/models');
  const prov = String(provider || '').trim().toLowerCase();
  const where = prov ? { provider: prov } : {};
  const before = _accounts.length;
  const removed = await AIAccount.destroy({ where });
  _accounts = prov
    ? _accounts.filter(a => String(a.provider || '').toLowerCase() !== prov)
    : [];
  return { removed: Number.isFinite(removed) ? removed : (before - _accounts.length) };
}

async function enableAccount(id) {
  const account = _accounts.find(a => a.id === id);
  if (account) {
    account.disabled = false;
    account.status = 'active';
  }
  const { AIAccount } = require('@khy/shared/models');
  await AIAccount.update({ disabled: false, status: 'active' }, { where: { id } });
}

async function disableAccount(id) {
  const account = _accounts.find(a => a.id === id);
  if (account) {
    account.status = 'disabled';
    account.disabled = true;
  }
  const { AIAccount } = require('@khy/shared/models');
  await AIAccount.update({ disabled: true, status: 'disabled' }, { where: { id } });
}

function getAllAccounts() {
  return _accounts.map(a => ({
    ...a,
    apiKey: a.apiKey ? a.apiKey.slice(0, 8) + '...' : '', // mask key
    healthScore: _computeHealth(a),
  }));
}

function getStatus() {
  const byProvider = {};
  for (const a of _accounts) {
    if (!byProvider[a.provider]) byProvider[a.provider] = { total: 0, active: 0, cooldown: 0, circuitOpen: 0, disabled: 0 };
    byProvider[a.provider].total++;
    if (a.status === 'active' && !a.disabled) byProvider[a.provider].active++;
    else if (a.status === 'cooldown') byProvider[a.provider].cooldown++;
    else if (a.status === 'circuit_open') byProvider[a.provider].circuitOpen++;
    else byProvider[a.provider].disabled++;
  }
  return {
    totalAccounts: _accounts.length,
    byProvider,
    schedulingMode: _config.schedulingMode,
    circuitBreaker: _config.circuitBreaker,
  };
}

function getSchedulingConfig() {
  return { schedulingMode: _config.schedulingMode, maxWaitSeconds: _config.maxWaitSeconds };
}

const VALID_SCHEDULING_MODES = ['PerformanceFirst', 'Balance', 'CacheFirst'];

function setSchedulingConfig(newConfig) {
  if (newConfig.schedulingMode) {
    if (!VALID_SCHEDULING_MODES.includes(newConfig.schedulingMode)) {
      throw new Error(`Invalid scheduling mode: ${newConfig.schedulingMode}. Valid: ${VALID_SCHEDULING_MODES.join(', ')}`);
    }
    _config.schedulingMode = newConfig.schedulingMode;
  }
  if (newConfig.maxWaitSeconds !== undefined) {
    const val = Number(newConfig.maxWaitSeconds);
    if (!Number.isFinite(val) || val < 5 || val > 300) {
      throw new Error('maxWaitSeconds must be a number between 5 and 300');
    }
    _config.maxWaitSeconds = val;
  }
  _saveConfig();
}

function getCircuitBreakerConfig() {
  return _config.circuitBreaker;
}

function setCircuitBreakerConfig(newConfig) {
  if (newConfig.enabled !== undefined) {
    _config.circuitBreaker.enabled = !!newConfig.enabled;
  }
  if (newConfig.backoffSteps !== undefined) {
    if (!Array.isArray(newConfig.backoffSteps) || newConfig.backoffSteps.length === 0) {
      throw new Error('backoffSteps must be a non-empty array of positive integers');
    }
    const steps = newConfig.backoffSteps.map(Number);
    if (steps.some(s => !Number.isFinite(s) || s < 1 || s > 86400)) {
      throw new Error('Each backoff step must be a number between 1 and 86400 seconds');
    }
    _config.circuitBreaker.backoffSteps = steps;
  }
  _saveConfig();
}

module.exports = {
  init,
  pick,
  markSuccess,
  markFailure,
  addAccount,
  updateAccount,
  removeAccount,
  removeAccounts,
  removeAllAccounts,
  enableAccount,
  disableAccount,
  getAllAccounts,
  getStatus,
  getSchedulingConfig,
  setSchedulingConfig,
  getCircuitBreakerConfig,
  setCircuitBreakerConfig,
};
