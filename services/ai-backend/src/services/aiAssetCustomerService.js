/**
 * AI Asset & Customer Management Service
 *
 * Scope:
 * - Persist customer metadata and customer-issued tokens
 * - Enforce `khy-` token prefix normalization
 * - Sync customer tokens to proxy auth file for gateway consumption
 * - Provide aggregated asset overview (adapters/models/keys/accounts/customers)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 数据家单一真源:复用主 backend 的 getAppHome()/getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppHome, getAppDataDir } = require('../utils/dataHome');
const KHY_DIR = getAppHome();
const CUSTOMERS_FILE = process.env.AI_GATEWAY_CUSTOMERS_FILE || getAppDataDir('ai_gateway_customers.json');
const PROXY_AUTH_FILE = process.env.PROXY_AUTH_FILE || getAppDataDir('proxy_server_auth.json');

const LEGACY_CUSTOMER_ID = 'cus_proxy_legacy';
const LEGACY_CUSTOMER_NAME = 'Proxy Imported Tokens';

let _state = null;
let _loaded = false;
let _tokenIndex = null; // Map<normalizedToken, { customerId, tokenId }>

function nowIso() {
  return new Date().toISOString();
}

// 收敛到 utils/ensureDirSync 单一真源(跨根委托,调用点不变)
const ensureDir = require('../../../backend/src/utils/ensureDirSync');

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw && typeof raw === 'object') return raw;
    return fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeText(input, maxLen = 120) {
  return String(input || '').trim().slice(0, maxLen);
}

function normalizeStringList(input, {
  maxItems = 50,
  maxItemLen = 120,
  lowerCase = false,
} = {}) {
  const list = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(',') : []);
  const out = [];
  const seen = new Set();
  for (const row of list) {
    let value = sanitizeText(row, maxItemLen);
    if (!value) continue;
    if (lowerCase) value = value.toLowerCase();
    if (seen.has(value)) continue;
    out.push(value);
    seen.add(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeQuota(input) {
  const src = input && typeof input === 'object' ? input : {};
  const toNonNeg = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  };
  return {
    monthlyRequests: toNonNeg(src.monthlyRequests),
    monthlyTokens: toNonNeg(src.monthlyTokens),
    monthlyBudgetCny: toNonNeg(src.monthlyBudgetCny),
  };
}

function normalizeLimits(input) {
  const src = input && typeof input === 'object' ? input : {};
  const toNonNeg = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  };
  return {
    rpm: toNonNeg(src.rpm),
    tpm: toNonNeg(src.tpm),
  };
}

function normalizeGroupId(raw) {
  const cleaned = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned || 'default';
}

const normalizeAuthToken = require('../../../backend/src/utils/normalizeAuthToken');

function generateAuthToken() {
  return `khy-${crypto.randomBytes(24).toString('hex')}`;
}

// 收敛到 utils/maskToken 单一真源(逐字节委托,调用点不变)
const maskToken = require('../../../backend/src/utils/maskToken');

function normalizeId(raw, prefix) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  if (!cleaned) return '';
  if (prefix && !cleaned.startsWith(`${prefix}_`)) return `${prefix}_${cleaned}`;
  return cleaned;
}

function generateId(prefix, used = new Set()) {
  for (let i = 0; i < 10; i += 1) {
    const id = `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
    if (!used.has(id)) return id;
  }
  return `${prefix}_${Date.now().toString(36)}`;
}

function normalizeTokenRow(raw, usedIds = new Set()) {
  const token = normalizeAuthToken(raw?.token, { allowEmpty: true });
  if (!token) return null;

  let id = normalizeId(raw?.id, 'tk');
  if (!id || usedIds.has(id)) id = generateId('tk', usedIds);
  usedIds.add(id);

  const createdAt = raw?.createdAt || nowIso();
  const updatedAt = raw?.updatedAt || createdAt;
  return {
    id,
    label: sanitizeText(raw?.label, 120),
    token,
    enabled: raw?.enabled !== false,
    createdAt,
    updatedAt,
    lastUsedAt: raw?.lastUsedAt || null,
  };
}

function normalizeCustomerRow(raw, usedIds = new Set()) {
  let id = normalizeId(raw?.id, 'cus');
  if (!id || usedIds.has(id)) id = generateId('cus', usedIds);
  usedIds.add(id);

  const name = sanitizeText(raw?.name || raw?.label || id, 120) || id;
  const createdAt = raw?.createdAt || nowIso();
  const updatedAt = raw?.updatedAt || createdAt;

  const tokenUsedIds = new Set();
  const tokens = [];
  const inputTokens = Array.isArray(raw?.tokens) ? raw.tokens : [];
  for (const row of inputTokens) {
    const normalized = normalizeTokenRow(row, tokenUsedIds);
    if (normalized) tokens.push(normalized);
  }

  return {
    id,
    name,
    note: sanitizeText(raw?.note, 300),
    enabled: raw?.enabled !== false,
    group: normalizeGroupId(raw?.group),
    limits: normalizeLimits(raw?.limits),
    allowedProviders: normalizeStringList(raw?.allowedProviders, { maxItems: 20, maxItemLen: 40, lowerCase: true }),
    allowedModels: normalizeStringList(raw?.allowedModels, { maxItems: 100, maxItemLen: 160, lowerCase: true }),
    quota: normalizeQuota(raw?.quota),
    tags: normalizeStringList(raw?.tags, { maxItems: 20, maxItemLen: 40 }),
    tokens,
    createdAt,
    updatedAt,
  };
}

function normalizeProxyManagedTokens(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const used = new Set();
  const out = [];
  for (const row of rows) {
    const token = normalizeTokenRow(row, used);
    if (!token) continue;
    out.push({
      ...token,
      customerId: normalizeId(row.customerId, 'cus'),
      customerName: sanitizeText(row.customerName, 120),
    });
  }
  return out;
}

function loadProxyAuthConfig() {
  const raw = safeReadJson(PROXY_AUTH_FILE, {});
  return {
    ...raw,
    authToken: normalizeAuthToken(raw.authToken, { allowEmpty: true }),
    managedTokens: normalizeProxyManagedTokens(raw.managedTokens),
    updatedAt: raw.updatedAt || null,
  };
}

function getOrCreateLegacyCustomer(state) {
  let legacy = state.customers.find(c => c.id === LEGACY_CUSTOMER_ID);
  if (!legacy) {
    legacy = normalizeCustomerRow({
      id: LEGACY_CUSTOMER_ID,
      name: LEGACY_CUSTOMER_NAME,
      note: 'Imported from proxy_server_auth.json',
      enabled: true,
      allowedProviders: [],
      allowedModels: [],
      quota: {},
      tokens: [],
    }, new Set(state.customers.map(c => c.id)));
    legacy.id = LEGACY_CUSTOMER_ID;
    legacy.name = LEGACY_CUSTOMER_NAME;
    legacy.createdAt = legacy.createdAt || nowIso();
    legacy.updatedAt = nowIso();
    state.customers.push(legacy);
  }
  return legacy;
}

function importProxyTokensIntoState(state, proxyCfg) {
  const managed = normalizeProxyManagedTokens(proxyCfg?.managedTokens);
  if (managed.length === 0) return false;

  const tokenIndex = new Map();
  for (const customer of state.customers) {
    for (const token of customer.tokens) {
      tokenIndex.set(token.id, { customer, token });
    }
  }

  let changed = false;
  for (const row of managed) {
    const existing = tokenIndex.get(row.id);
    if (existing) {
      if (existing.token.token !== row.token || existing.token.enabled !== row.enabled) {
        existing.token.token = row.token;
        existing.token.enabled = row.enabled;
        existing.token.updatedAt = nowIso();
        existing.customer.updatedAt = nowIso();
        changed = true;
      }
      continue;
    }

    const targetId = row.customerId || '';
    let customer = targetId ? state.customers.find(c => c.id === targetId) : null;
    if (!customer) customer = getOrCreateLegacyCustomer(state);

    const used = new Set(customer.tokens.map(t => t.id));
    const normalized = normalizeTokenRow(row, used);
    if (!normalized) continue;
    if (!normalized.label) {
      normalized.label = row.customerName || customer.name;
    }
    customer.tokens.push(normalized);
    customer.updatedAt = nowIso();
    changed = true;
  }

  return changed;
}

function syncCustomersToProxyAuth(state) {
  const proxyRaw = safeReadJson(PROXY_AUTH_FILE, {});
  const managedTokens = [];

  for (const customer of state.customers) {
    for (const token of customer.tokens) {
      managedTokens.push({
        id: token.id,
        label: token.label || customer.name,
        token: token.token,
        enabled: customer.enabled !== false && token.enabled !== false,
        customerId: customer.id,
        customerName: customer.name,
        createdAt: token.createdAt || nowIso(),
        updatedAt: token.updatedAt || nowIso(),
      });
    }
  }

  const merged = {
    ...proxyRaw,
    managedTokens,
    updatedAt: nowIso(),
  };
  safeWriteJson(PROXY_AUTH_FILE, merged);
}

function persistState({ syncProxy = true } = {}) {
  if (!_state) return;
  _state.updatedAt = nowIso();
  safeWriteJson(CUSTOMERS_FILE, _state);
  _tokenIndex = null; // invalidate; rebuilt lazily on next resolve
  if (syncProxy) syncCustomersToProxyAuth(_state);
}

function ensureLoaded() {
  if (_loaded && _state) return;

  const raw = safeReadJson(CUSTOMERS_FILE, { version: 1, customers: [] });
  const rows = Array.isArray(raw.customers) ? raw.customers : [];
  const usedIds = new Set();
  const customers = rows.map(row => normalizeCustomerRow(row, usedIds));

  _state = {
    version: 1,
    customers,
    updatedAt: raw.updatedAt || nowIso(),
  };

  const proxyCfg = loadProxyAuthConfig();
  const imported = importProxyTokensIntoState(_state, proxyCfg);
  if (imported) persistState({ syncProxy: false });

  _loaded = true;
}

function modelPatternMatch(rule, modelId) {
  const normalizedRule = String(rule || '').trim().toLowerCase();
  const normalizedModel = String(modelId || '').trim().toLowerCase();
  if (!normalizedRule) return false;
  if (normalizedRule === '*') return true;
  if (!normalizedRule.includes('*')) return normalizedRule === normalizedModel;

  const escaped = normalizedRule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(normalizedModel);
}

function hasModelAccess(customer, modelId) {
  const normalizedModel = String(modelId || '').trim().toLowerCase();
  if (!normalizedModel) return true;

  const slash = normalizedModel.indexOf('/');
  const provider = slash > 0 ? normalizedModel.slice(0, slash) : '';

  if (Array.isArray(customer.allowedProviders) && customer.allowedProviders.length > 0) {
    if (!provider || !customer.allowedProviders.includes(provider)) return false;
  }

  if (Array.isArray(customer.allowedModels) && customer.allowedModels.length > 0) {
    return customer.allowedModels.some(rule => modelPatternMatch(rule, normalizedModel));
  }

  return true;
}

/** Build (or rebuild) the token → { customerId, tokenId } lookup index. */
function buildTokenIndex() {
  const index = new Map();
  for (const customer of _state.customers) {
    for (const token of customer.tokens) {
      if (!token.token) continue;
      index.set(token.token, { customerId: customer.id, tokenId: token.id });
    }
  }
  return index;
}

/**
 * Resolve a customer + token from a raw bearer value.
 * Returns null when the token is unknown. Disabled customers/tokens resolve
 * but carry `enabled:false` so callers can decide how to respond.
 * @returns {null | { customer, token, enabled, group, limits }}
 */
function resolveCustomerByToken(rawBearer) {
  ensureLoaded();
  const normalized = normalizeAuthToken(rawBearer, { allowEmpty: true });
  if (!normalized) return null;
  if (!_tokenIndex) _tokenIndex = buildTokenIndex();
  const hit = _tokenIndex.get(normalized);
  if (!hit) return null;
  const customer = _state.customers.find(c => c.id === hit.customerId);
  if (!customer) { _tokenIndex = null; return null; }
  const token = customer.tokens.find(t => t.id === hit.tokenId);
  if (!token) { _tokenIndex = null; return null; }
  return {
    customer,
    token,
    enabled: customer.enabled !== false && token.enabled !== false,
    group: customer.group || 'default',
    limits: customer.limits || { rpm: 0, tpm: 0 },
  };
}

/** Whether any managed (customer-issued) token exists. */
function hasManagedTokens() {
  ensureLoaded();
  if (!_tokenIndex) _tokenIndex = buildTokenIndex();
  return _tokenIndex.size > 0;
}

/** Mark a token as just used (best-effort; debounced persistence not needed here). */
function touchTokenLastUsed(customerId, tokenId) {
  try {
    ensureLoaded();
    const customer = _state.customers.find(c => c.id === customerId);
    if (!customer) return;
    const token = customer.tokens.find(t => t.id === tokenId);
    if (!token) return;
    token.lastUsedAt = nowIso();
  } catch { /* ignore */ }
}

function toTokenView(token, { includeSecrets = false } = {}) {
  const base = {
    id: token.id,
    label: token.label || '',
    enabled: token.enabled !== false,
    tokenMasked: maskToken(token.token),
    createdAt: token.createdAt || null,
    updatedAt: token.updatedAt || null,
    lastUsedAt: token.lastUsedAt || null,
  };
  if (includeSecrets) base.token = token.token;
  return base;
}

function toCustomerView(customer, { includeSecrets = false, model = '' } = {}) {
  const modelAccess = model ? hasModelAccess(customer, model) : true;
  const tokenViews = customer.tokens.map(t => toTokenView(t, { includeSecrets }));
  return {
    id: customer.id,
    name: customer.name,
    note: customer.note || '',
    enabled: customer.enabled !== false,
    group: customer.group || 'default',
    limits: customer.limits || { rpm: 0, tpm: 0 },
    allowedProviders: customer.allowedProviders || [],
    allowedModels: customer.allowedModels || [],
    quota: customer.quota || normalizeQuota({}),
    tags: customer.tags || [],
    modelAccess,
    tokenCount: tokenViews.length,
    enabledTokenCount: tokenViews.filter(t => t.enabled).length,
    tokens: tokenViews,
    createdAt: customer.createdAt || null,
    updatedAt: customer.updatedAt || null,
  };
}

function listCustomers({ includeSecrets = false, model = '' } = {}) {
  ensureLoaded();
  return _state.customers.map(c => toCustomerView(c, { includeSecrets, model }));
}

function getCustomerById(customerId) {
  ensureLoaded();
  const id = normalizeId(customerId, 'cus');
  const customer = _state.customers.find(c => c.id === id);
  if (!customer) throw new Error(`Customer not found: ${customerId}`);
  return customer;
}

function ensureTokenNotDuplicated(nextToken, excludeTokenId = '') {
  const excludeId = normalizeId(excludeTokenId, 'tk');
  for (const customer of _state.customers) {
    for (const token of customer.tokens) {
      if (excludeId && token.id === excludeId) continue;
      if (token.token === nextToken) {
        throw new Error('Token already exists under another customer');
      }
    }
  }
}

function createCustomer(payload = {}) {
  ensureLoaded();

  const name = sanitizeText(payload.name, 120);
  if (!name) throw new Error('Customer name is required');

  const usedIds = new Set(_state.customers.map(c => c.id));
  const customer = normalizeCustomerRow({
    id: generateId('cus', usedIds),
    name,
    note: payload.note,
    enabled: payload.enabled !== false,
    group: payload.group,
    limits: payload.limits,
    allowedProviders: payload.allowedProviders,
    allowedModels: payload.allowedModels,
    quota: payload.quota,
    tags: payload.tags,
    tokens: [],
  }, usedIds);

  _state.customers.push(customer);
  persistState();
  return toCustomerView(customer, { includeSecrets: true });
}

function updateCustomer(customerId, payload = {}) {
  ensureLoaded();
  const customer = getCustomerById(customerId);

  if (payload.name !== undefined) {
    const name = sanitizeText(payload.name, 120);
    if (!name) throw new Error('Customer name cannot be empty');
    customer.name = name;
  }

  if (payload.note !== undefined) customer.note = sanitizeText(payload.note, 300);
  if (payload.enabled !== undefined) customer.enabled = payload.enabled !== false;
  if (payload.group !== undefined) customer.group = normalizeGroupId(payload.group);
  if (payload.limits !== undefined) customer.limits = normalizeLimits(payload.limits);
  if (payload.allowedProviders !== undefined) {
    customer.allowedProviders = normalizeStringList(payload.allowedProviders, { maxItems: 20, maxItemLen: 40, lowerCase: true });
  }
  if (payload.allowedModels !== undefined) {
    customer.allowedModels = normalizeStringList(payload.allowedModels, { maxItems: 100, maxItemLen: 160, lowerCase: true });
  }
  if (payload.quota !== undefined) customer.quota = normalizeQuota(payload.quota);
  if (payload.tags !== undefined) {
    customer.tags = normalizeStringList(payload.tags, { maxItems: 20, maxItemLen: 40 });
  }

  customer.updatedAt = nowIso();
  persistState();
  return toCustomerView(customer, { includeSecrets: true });
}

function setCustomerEnabled(customerId, enabled) {
  ensureLoaded();
  const customer = getCustomerById(customerId);
  customer.enabled = enabled !== false;
  customer.updatedAt = nowIso();
  persistState();
  return toCustomerView(customer, { includeSecrets: false });
}

function issueToken(customerId, payload = {}) {
  ensureLoaded();
  const customer = getCustomerById(customerId);

  const countRaw = parseInt(payload.count, 10);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(20, countRaw)) : 1;
  const customToken = normalizeAuthToken(payload.token, { allowEmpty: true });
  if (customToken && count > 1) {
    throw new Error('Custom token only supports count=1');
  }

  const usedTokenIds = new Set();
  for (const row of _state.customers) {
    for (const token of row.tokens) usedTokenIds.add(token.id);
  }

  const created = [];
  const baseLabel = sanitizeText(payload.label, 120) || customer.name || customer.id;
  for (let i = 0; i < count; i += 1) {
    const tokenValue = customToken || generateAuthToken();
    ensureTokenNotDuplicated(tokenValue);
    const token = {
      id: generateId('tk', usedTokenIds),
      label: count > 1 ? `${baseLabel} #${i + 1}` : baseLabel,
      token: tokenValue,
      enabled: payload.enabled !== false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastUsedAt: null,
    };
    customer.tokens.push(token);
    created.push(token);
  }
  customer.updatedAt = nowIso();
  persistState();
  const views = created.map(token => toTokenView(token, { includeSecrets: true }));
  if (views.length === 1) return views[0];
  return {
    customerId: customer.id,
    count: views.length,
    tokens: views,
  };
}

function rotateToken(customerId, tokenId, nextToken = '') {
  ensureLoaded();
  const customer = getCustomerById(customerId);
  const normalizedTokenId = normalizeId(tokenId, 'tk');
  const token = customer.tokens.find(t => t.id === normalizedTokenId);
  if (!token) throw new Error(`Token not found: ${tokenId}`);

  const tokenValue = normalizeAuthToken(nextToken, { allowEmpty: true }) || generateAuthToken();
  ensureTokenNotDuplicated(tokenValue, token.id);

  token.token = tokenValue;
  token.updatedAt = nowIso();
  customer.updatedAt = nowIso();
  persistState();
  return toTokenView(token, { includeSecrets: true });
}

function setTokenEnabled(customerId, tokenId, enabled) {
  ensureLoaded();
  const customer = getCustomerById(customerId);
  const normalizedTokenId = normalizeId(tokenId, 'tk');
  const token = customer.tokens.find(t => t.id === normalizedTokenId);
  if (!token) throw new Error(`Token not found: ${tokenId}`);

  token.enabled = enabled !== false;
  token.updatedAt = nowIso();
  customer.updatedAt = nowIso();
  persistState();
  return toTokenView(token, { includeSecrets: false });
}

function deleteToken(customerId, tokenId) {
  ensureLoaded();
  const customer = getCustomerById(customerId);
  const normalizedTokenId = normalizeId(tokenId, 'tk');
  const idx = customer.tokens.findIndex(t => t.id === normalizedTokenId);
  if (idx < 0) throw new Error(`Token not found: ${tokenId}`);

  const removed = customer.tokens[idx];
  customer.tokens.splice(idx, 1);
  customer.updatedAt = nowIso();
  persistState();
  return toTokenView(removed, { includeSecrets: false });
}

function summarizeApiKeyPool() {
  const pool = require('./apiKeyPool');
  pool.init();
  const allStatus = pool.getAllStatus();

  const byProvider = {};
  let totalKeys = 0;
  let activeKeys = 0;
  let cooldownKeys = 0;
  let disabledKeys = 0;

  for (const [provider, rows] of Object.entries(allStatus || {})) {
    const list = Array.isArray(rows) ? rows : [];
    const providerSummary = { total: list.length, active: 0, cooldown: 0, disabled: 0 };
    for (const row of list) {
      const status = String(row.status || 'active');
      if (status === 'cooldown') providerSummary.cooldown += 1;
      else if (status === 'disabled') providerSummary.disabled += 1;
      else providerSummary.active += 1;
    }
    byProvider[provider] = providerSummary;
    totalKeys += providerSummary.total;
    activeKeys += providerSummary.active;
    cooldownKeys += providerSummary.cooldown;
    disabledKeys += providerSummary.disabled;
  }

  return {
    providers: Object.keys(byProvider).length,
    totalKeys,
    activeKeys,
    cooldownKeys,
    disabledKeys,
    byProvider,
  };
}

async function summarizeAccountPool() {
  const pool = require('./accountPool');
  await pool.init();
  const status = pool.getStatus();
  return {
    totalAccounts: status.totalAccounts || 0,
    byProvider: status.byProvider || {},
    schedulingMode: status.schedulingMode || 'PerformanceFirst',
    circuitBreaker: status.circuitBreaker || {},
  };
}

async function summarizeGatewayModels() {
  const gateway = require('./gateway/aiGateway');
  if (!gateway._initialized) await gateway.init();

  const adapterEntries = Array.isArray(gateway._adapters) ? gateway._adapters : [];
  const adapters = [];
  const byAdapter = {};
  const list = [];

  for (const entry of adapterEntries) {
    const key = entry.key;
    let status;
    try {
      status = entry.adapter.getStatus ? entry.adapter.getStatus() : {};
    } catch {
      status = {};
    }

    const adapterInfo = {
      key,
      name: status.name || key,
      type: status.type || 'unknown',
      enabled: entry.enabled !== false,
      available: !!status.available,
      detail: status.detail || '',
      modelCount: 0,
      modelError: '',
    };

    if (entry.enabled !== false && entry.adapter && typeof entry.adapter.listModels === 'function') {
      try {
        const models = await gateway.listModels(key);
        const normalized = Array.isArray(models) ? models : [];
        adapterInfo.modelCount = normalized.length;
        byAdapter[key] = {
          count: normalized.length,
          models: normalized.slice(0, 50).map(m => ({
            id: String(m.id || ''),
            name: m.name || m.id || '',
            isDefault: !!m.isDefault,
          })),
        };
        for (const m of normalized) {
          const modelId = String(m.id || '').trim();
          if (!modelId) continue;
          list.push({
            id: `${key}/${modelId}`,
            baseId: modelId,
            adapter: key,
            name: m.name || modelId,
            isDefault: !!m.isDefault,
          });
        }
      } catch (err) {
        adapterInfo.modelError = err.message || 'listModels failed';
        byAdapter[key] = { count: 0, models: [], error: adapterInfo.modelError };
      }
    } else {
      byAdapter[key] = { count: 0, models: [] };
    }

    adapters.push(adapterInfo);
  }

  return {
    adapters,
    byAdapter,
    list,
    totalModels: list.length,
    enabledAdapters: adapters.filter(a => a.enabled).length,
    availableAdapters: adapters.filter(a => a.available).length,
  };
}

function summarizeProxyAuth(customers) {
  const cfg = loadProxyAuthConfig();
  const envToken = normalizeAuthToken(process.env.PROXY_AUTH_TOKEN, { allowEmpty: true });
  const authToken = envToken || cfg.authToken || '';
  const source = envToken ? 'env' : (cfg.authToken ? 'persisted' : 'none');

  const managedTokens = normalizeProxyManagedTokens(cfg.managedTokens);
  const enabledManagedTokens = managedTokens.filter(t => t.enabled !== false).length;

  const customerTokenIds = new Set();
  for (const c of customers) {
    for (const t of c.tokens) customerTokenIds.add(t.id);
  }
  const externalManagedTokens = managedTokens.filter(t => !customerTokenIds.has(t.id)).length;

  return {
    authTokenMasked: maskToken(authToken),
    authTokenSource: source,
    hasAuthToken: !!authToken,
    managedTokenCount: managedTokens.length,
    managedTokenEnabledCount: enabledManagedTokens,
    externalManagedTokenCount: externalManagedTokens,
    updatedAt: cfg.updatedAt || null,
  };
}

async function getAssetOverview() {
  ensureLoaded();
  const customers = _state.customers;

  const customersSummary = {
    total: customers.length,
    enabled: customers.filter(c => c.enabled !== false).length,
    tokens: customers.reduce((sum, c) => sum + c.tokens.length, 0),
    enabledTokens: customers.reduce((sum, c) => (
      sum + c.tokens.filter(t => c.enabled !== false && t.enabled !== false).length
    ), 0),
  };

  const [gatewaySummary, accountPoolSummary] = await Promise.all([
    summarizeGatewayModels(),
    summarizeAccountPool(),
  ]);
  const apiKeyPoolSummary = summarizeApiKeyPool();
  const proxyAuthSummary = summarizeProxyAuth(customers);

  return {
    generatedAt: nowIso(),
    assets: {
      gateway: gatewaySummary,
      apiKeyPool: apiKeyPoolSummary,
      accountPool: accountPoolSummary,
      proxyAuth: proxyAuthSummary,
      customers: customersSummary,
    },
  };
}

module.exports = {
  normalizeAuthToken,
  generateAuthToken,
  hasModelAccess,
  resolveCustomerByToken,
  hasManagedTokens,
  touchTokenLastUsed,
  listCustomers,
  createCustomer,
  updateCustomer,
  setCustomerEnabled,
  issueToken,
  rotateToken,
  setTokenEnabled,
  deleteToken,
  getAssetOverview,
};
