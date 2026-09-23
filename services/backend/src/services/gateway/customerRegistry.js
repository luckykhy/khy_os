const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');

const KHY_DIR = getDataHome();
const LEGACY_KHY_DIR = getLegacyDataHome();
const CUSTOMER_FILE = path.join(KHY_DIR, 'ai_gateway_customers.json');
const LEGACY_CUSTOMER_FILE = path.join(LEGACY_KHY_DIR, 'ai_gateway_customers.json');
const PROXY_AUTH_FILE = path.join(KHY_DIR, 'proxy_server_auth.json');
const LEGACY_PROXY_AUTH_FILE = path.join(LEGACY_KHY_DIR, 'proxy_server_auth.json');
const AUTO_SHARED_CUSTOMER_ID = 'auto_shared';
const AUTO_SHARED_CUSTOMER_NOTE_TAG = '[managed:auto-shared]';

const DEFAULT_QUOTA = Object.freeze({
  monthlyRequests: 0,
  monthlyTokens: 0,
  monthlyBudgetCny: 0,
});

// 收敛到 utils/mkdirpSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../../utils/mkdirpSync');

const proxyServer = require('./proxyServer');

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function readJsonWithFallback(filePaths = [], fallback = {}) {
  for (const filePath of filePaths) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }
      const raw = fs.readFileSync(filePath, 'utf-8');
      return safeJsonParse(raw, fallback);
    } catch {
      // try next file
    }
  }
  return fallback;
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function normalizeStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return [...new Set(input.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeQuota(input) {
  const source = input && typeof input === 'object' ? input : {};
  const monthlyRequests = Number(source.monthlyRequests) || 0;
  const monthlyTokens = Number(source.monthlyTokens) || 0;
  const monthlyBudgetCny = Number(source.monthlyBudgetCny) || 0;
  return {
    monthlyRequests: Math.max(0, monthlyRequests),
    monthlyTokens: Math.max(0, monthlyTokens),
    monthlyBudgetCny: Math.max(0, monthlyBudgetCny),
  };
}

function sanitizeCustomerId(raw, fallback = '') {
  const id = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return id || fallback;
}

// Owner binding: customer ↔ auth user account (users table primary key).
// null = unbound. One customer belongs to at most one account, and one account
// owns at most one customer — enforced in resolveOwnerBinding() below.
function normalizeOwnerUserId(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return Math.floor(n);
}

function generateCustomerId(existing = new Set()) {
  for (let i = 0; i < 8; i += 1) {
    const id = `cus_${crypto.randomBytes(4).toString('hex')}`;
    if (!existing.has(id)) {
      return id;
    }
  }
  return `cus_${Date.now().toString(36)}`;
}

function normalizeCustomer(raw, existingIds = new Set()) {
  const now = new Date().toISOString();
  const input = raw && typeof raw === 'object' ? raw : {};
  let id = sanitizeCustomerId(input.id);
  if (!id || existingIds.has(id)) {
    id = generateCustomerId(existingIds);
  }
  existingIds.add(id);
  return {
    id,
    name: String(input.name || id).trim() || id,
    enabled: input.enabled !== false,
    allowedProviders: normalizeStringArray(input.allowedProviders).map((x) => x.toLowerCase()),
    allowedModels: normalizeStringArray(input.allowedModels).map((x) => x.toLowerCase()),
    quota: normalizeQuota(input.quota || DEFAULT_QUOTA),
    note: String(input.note || '').trim(),
    tokenIds: normalizeStringArray(input.tokenIds),
    ownerUserId: normalizeOwnerUserId(input.ownerUserId),
    createdAt: String(input.createdAt || now),
    updatedAt: String(input.updatedAt || input.createdAt || now),
  };
}

// A binding must be unique in both directions: setting ownerUserId on this
// customer strips it from whichever customer held that account before, so a
// later binding silently steals the earlier one (and its payment history would
// point at a customer that no longer belongs to the payer).
function resolveOwnerBinding(store, customerId, ownerUserId) {
  const next = normalizeOwnerUserId(ownerUserId);
  for (const other of store.customers) {
    if (other.id === customerId) {
      continue;
    }
    if (next !== null && Number(other.ownerUserId || 0) === next) {
      throw new Error(
        `user ${next} is already bound to customer ${other.id}; unbind it first`
      );
    }
  }
  return next;
}

function getCustomerByOwner(store, userId) {
  const owner = normalizeOwnerUserId(userId);
  if (owner === null) {
    return null;
  }
  return store.customers.find((item) => Number(item.ownerUserId || 0) === owner) || null;
}

// Read the CURRENT on-disk version counter (0 when the file is absent). Used by
// saveStore() for compare-and-swap across the multiple processes that share
// this file (daemon + CLI + management server).
function readRawVersion() {
  for (const filePath of [CUSTOMER_FILE, LEGACY_CUSTOMER_FILE]) {
    try {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const v = Number(raw && raw.version);
      return Number.isFinite(v) ? v : 0;
    } catch {
      /* fall through to next / 0 */
    }
  }
  return 0;
}

function loadStore() {
  ensureDir(KHY_DIR);
  const raw = readJsonWithFallback([CUSTOMER_FILE, LEGACY_CUSTOMER_FILE], {
    version: 1,
    customers: [],
  });
  const rows = Array.isArray(raw.customers) ? raw.customers : [];
  const existingIds = new Set();
  const customers = rows.map((row) => normalizeCustomer(row, existingIds));
  return {
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    customers,
  };
}

/**
 * Save the store. When `baseVersion` is provided this is a compare-and-swap:
 * if the on-disk version has advanced past `baseVersion` (another process wrote
 * in the meantime) the write is REFUSED and `{ ok:false, conflict:true }` is
 * returned instead of silently clobbering the newer data (a lost update).
 * Omit `baseVersion` for an unconditional write (version still advances).
 */
function saveStore(store, baseVersion) {
  const rows = Array.isArray(store?.customers) ? store.customers : [];
  const existingIds = new Set();
  const normalized = rows.map((row) => normalizeCustomer(row, existingIds));

  const onDiskVersion = readRawVersion();
  if (baseVersion !== undefined && onDiskVersion > baseVersion) {
    // Stale base — a newer writer won. Refuse to overwrite its data.
    return { ok: false, conflict: true, version: onDiskVersion, customers: normalized };
  }
  const base = baseVersion !== undefined ? baseVersion : onDiskVersion;
  const nextVersion = base + 1;
  writeJsonAtomic(CUSTOMER_FILE, { version: nextVersion, customers: normalized });
  return { ok: true, version: nextVersion, customers: normalized };
}

/**
 * Remove orphaned `<file>.tmp.*` litter left behind when a process dies between
 * the atomic tmp-write and the rename (or the rename fails). Only this
 * registry's own files are swept, and only files still carrying the transient
 * `.tmp.` marker — a renamed-in-place store never matches.
 * @returns {string[]} the paths removed
 */
function sweepOrphanTemps(dir = KHY_DIR) {
  const removed = [];
  const prefixes = ['ai_gateway_customers.json', 'proxy_server_auth.json'];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const isOrphan =
      /\.tmp\.\d+$/.test(name) && prefixes.some((p) => name.startsWith(p + '.tmp.'));
    if (!isOrphan) continue;
    try {
      const full = path.join(dir, name);
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

function loadManagedTokenSecrets() {
  const raw = readJsonWithFallback([PROXY_AUTH_FILE, LEGACY_PROXY_AUTH_FILE], {});
  const rows = Array.isArray(raw.managedTokens) ? raw.managedTokens : [];
  const out = new Map();
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    const token = String(row?.token || '').trim();
    if (!id || !token) {
      continue;
    }
    out.set(id, token);
  }
  return out;
}

function toTokenView(base, tokenSecrets = new Map(), includeSecrets = false) {
  const id = String(base?.id || '').trim();
  const view = {
    id,
    label: String(base?.label || '').trim(),
    enabled: base?.enabled !== false,
    tokenMasked: String(base?.tokenMasked || ''),
    createdAt: base?.createdAt || null,
    updatedAt: base?.updatedAt || null,
  };
  if (includeSecrets) {
    view.token = tokenSecrets.get(id) || '';
  }
  return view;
}

function parseProviderFromModelId(modelId) {
  const m = String(modelId || '')
    .trim()
    .toLowerCase()
    .match(/^([a-z0-9_-]+)[/:](.+)$/);
  return m ? m[1] : '';
}

function matchModelRule(rule, modelId) {
  const normalizedRule = String(rule || '')
    .trim()
    .toLowerCase();
  const normalizedModel = String(modelId || '')
    .trim()
    .toLowerCase();
  if (!normalizedRule || !normalizedModel) {
    return false;
  }
  if (normalizedRule === '*') {
    return true;
  }
  if (!normalizedRule.includes('*')) {
    return normalizedRule === normalizedModel;
  }
  const escaped = normalizedRule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(normalizedModel);
}

function customerHasModelAccess(customer, modelId) {
  const normalizedModel = String(modelId || '')
    .trim()
    .toLowerCase();
  if (!normalizedModel) {
    return true;
  }
  const provider = parseProviderFromModelId(normalizedModel);
  if (Array.isArray(customer.allowedProviders) && customer.allowedProviders.length > 0) {
    if (!provider || !customer.allowedProviders.includes(provider)) {
      return false;
    }
  }
  if (!Array.isArray(customer.allowedModels) || customer.allowedModels.length === 0) {
    return true;
  }
  return customer.allowedModels.some((rule) => matchModelRule(rule, normalizedModel));
}

function buildCustomerViews(customers, { includeSecrets = false, model = '' } = {}) {
  const managed = proxyServer.listManagedTokens();
  const managedMap = new Map(managed.map((item) => [item.id, item]));
  const tokenSecrets = includeSecrets ? loadManagedTokenSecrets() : new Map();

  const rows = [];
  let changed = false;
  for (const customer of customers) {
    const tokens = [];
    const nextTokenIds = [];
    for (const tokenId of customer.tokenIds || []) {
      const base = managedMap.get(tokenId);
      if (!base) {
        changed = true;
        continue;
      }
      nextTokenIds.push(tokenId);
      tokens.push(toTokenView(base, tokenSecrets, includeSecrets));
    }

    if (nextTokenIds.length !== (customer.tokenIds || []).length) {
      customer.tokenIds = nextTokenIds;
      customer.updatedAt = new Date().toISOString();
    }

    const view = {
      id: customer.id,
      name: customer.name,
      enabled: customer.enabled !== false,
      allowedProviders: [...(customer.allowedProviders || [])],
      allowedModels: [...(customer.allowedModels || [])],
      quota: normalizeQuota(customer.quota || DEFAULT_QUOTA),
      note: customer.note || '',
      ownerUserId: normalizeOwnerUserId(customer.ownerUserId),
      tokenCount: tokens.length,
      enabledTokenCount: tokens.filter((t) => t.enabled).length,
      tokens,
      createdAt: customer.createdAt || null,
      updatedAt: customer.updatedAt || null,
    };
    if (!model || customerHasModelAccess(view, model)) {
      rows.push(view);
    }
  }

  if (changed) {
    saveStore({ version: 1, customers });
  }
  return rows;
}

function getCustomerById(store, customerId) {
  const id = sanitizeCustomerId(customerId);
  return store.customers.find((item) => item.id === id) || null;
}

function updateCustomerFields(customer, data = {}, store = null) {
  if (data.name !== undefined) {
    const name = String(data.name || '').trim();
    if (!name) {
      throw new Error('name is required');
    }
    customer.name = name;
  }
  // ownerUserId: null / 0 / '' clears the binding; a positive id binds. The
  // 1:1 check needs the whole store, so `store` must be supplied by callers
  // that already loaded it (updateCustomer / createCustomer do).
  if (data.ownerUserId !== undefined) {
    const next = store
      ? resolveOwnerBinding(store, customer.id, data.ownerUserId)
      : normalizeOwnerUserId(data.ownerUserId);
    customer.ownerUserId = next;
  }
  if (data.enabled !== undefined) {
    customer.enabled = data.enabled !== false;
  }
  if (data.allowedProviders !== undefined) {
    customer.allowedProviders = normalizeStringArray(data.allowedProviders).map((x) =>
      x.toLowerCase()
    );
  }
  if (data.allowedModels !== undefined) {
    customer.allowedModels = normalizeStringArray(data.allowedModels).map((x) => x.toLowerCase());
  }
  if (data.quota !== undefined) {
    customer.quota = normalizeQuota(data.quota || DEFAULT_QUOTA);
  }
  if (data.note !== undefined) {
    customer.note = String(data.note || '').trim();
  }
  customer.updatedAt = new Date().toISOString();
  return customer;
}

function getCustomer(customerId, options = {}) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    return null;
  }
  return (
    buildCustomerViews([customer], {
      includeSecrets: options.includeSecrets === true,
    })[0] || null
  );
}

function adjustCustomerQuota(customerId, delta = {}, options = {}) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }

  const current = normalizeQuota(customer.quota || DEFAULT_QUOTA);
  const patch = normalizeQuota(delta || DEFAULT_QUOTA);
  customer.quota = normalizeQuota({
    monthlyRequests: current.monthlyRequests + patch.monthlyRequests,
    monthlyTokens: current.monthlyTokens + patch.monthlyTokens,
    monthlyBudgetCny: current.monthlyBudgetCny + patch.monthlyBudgetCny,
  });
  customer.updatedAt = new Date().toISOString();
  saveStore(store);

  return (
    buildCustomerViews([customer], {
      includeSecrets: options.includeSecrets === true,
    })[0] || null
  );
}

function listCustomers(options = {}) {
  const store = loadStore();
  const includeSecrets = options.includeSecrets === true;
  const model = String(options.model || '').trim();
  return buildCustomerViews(store.customers, { includeSecrets, model });
}

function createCustomer(data = {}) {
  const name = String(data.name || '').trim();
  if (!name) {
    throw new Error('name is required');
  }
  const store = loadStore();
  const existingIds = new Set(store.customers.map((item) => item.id));
  const created = normalizeCustomer(
    {
      id: data.id || generateCustomerId(existingIds),
      name,
      enabled: data.enabled !== false,
      allowedProviders: data.allowedProviders || [],
      allowedModels: data.allowedModels || [],
      quota: data.quota || DEFAULT_QUOTA,
      note: data.note || '',
      tokenIds: [],
      ownerUserId: data.ownerUserId,
    },
    existingIds
  );
  if (created.ownerUserId !== null) {
    resolveOwnerBinding(store, created.id, created.ownerUserId);
  }
  store.customers.push(created);
  saveStore(store);
  return buildCustomerViews([created], { includeSecrets: true })[0];
}

function updateCustomer(customerId, data = {}) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }
  updateCustomerFields(customer, data, store);
  saveStore(store);
  return buildCustomerViews([customer], { includeSecrets: true })[0];
}

function setCustomerEnabled(customerId, enabled) {
  return updateCustomer(customerId, { enabled: enabled !== false });
}

// The account-side lookup of the binding: "which customer does this user own?"
// Returns the same view shape as getCustomer (never includes token secrets).
function getCustomerByOwnerUserId(userId) {
  const owner = normalizeOwnerUserId(userId);
  if (owner === null) {
    return null;
  }
  const store = loadStore();
  const customer = getCustomerByOwner(store, owner);
  if (!customer) {
    return null;
  }
  return buildCustomerViews([customer], { includeSecrets: false })[0] || null;
}

function ensureCustomerOwnsToken(customer, tokenId) {
  const id = String(tokenId || '').trim();
  if (!id) {
    throw new Error('token id is required');
  }
  if (!Array.isArray(customer.tokenIds)) {
    customer.tokenIds = [];
  }
  if (!customer.tokenIds.includes(id)) {
    throw new Error(`token ${id} is not bound to customer ${customer.id}`);
  }
}

function bindTokenToCustomer(store, customer, tokenId) {
  const id = String(tokenId || '').trim();
  if (!id) {
    return;
  }
  if (!Array.isArray(customer.tokenIds)) {
    customer.tokenIds = [];
  }
  if (!customer.tokenIds.includes(id)) {
    customer.tokenIds.push(id);
  }
  for (const other of store.customers) {
    if (other.id === customer.id) {
      continue;
    }
    if (!Array.isArray(other.tokenIds)) {
      continue;
    }
    const before = other.tokenIds.length;
    other.tokenIds = other.tokenIds.filter((tid) => tid !== id);
    if (other.tokenIds.length !== before) {
      other.updatedAt = new Date().toISOString();
    }
  }
  customer.updatedAt = new Date().toISOString();
}

function issueToken(customerId, data = {}) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }

  const countRaw = parseInt(data.count, 10);
  const count = Number.isFinite(countRaw) ? Math.max(1, Math.min(20, countRaw)) : 1;
  const customToken = String(data.token || '').trim();
  if (customToken && count > 1) {
    throw new Error('custom token only supports count=1');
  }

  const baseLabel = String(data.label || customer.name || customer.id)
    .trim()
    .slice(0, 120);
  const createdRows = [];
  for (let i = 0; i < count; i += 1) {
    const label = count > 1 ? `${baseLabel} #${i + 1}` : baseLabel;
    const created = proxyServer.createManagedToken({
      label,
      token: customToken,
      enabled: data.enabled !== false,
    });
    bindTokenToCustomer(store, customer, created.id);
    createdRows.push(created);
  }
  saveStore(store);

  const tokenViews = createdRows.map((row) => {
    const tokenView = toTokenView(row, new Map([[row.id, row.token]]), true);
    tokenView.token = row.token;
    return tokenView;
  });
  if (tokenViews.length === 1) {
    return tokenViews[0];
  }
  return {
    customerId: customer.id,
    count: tokenViews.length,
    tokens: tokenViews,
  };
}

function rotateToken(customerId, tokenId, token = '') {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }
  ensureCustomerOwnsToken(customer, tokenId);
  const rotated = proxyServer.rotateManagedToken(tokenId, token);
  customer.updatedAt = new Date().toISOString();
  saveStore(store);
  const tokenView = toTokenView(rotated, new Map([[rotated.id, rotated.token]]), true);
  tokenView.token = rotated.token;
  return tokenView;
}

function setTokenEnabled(customerId, tokenId, enabled) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }
  ensureCustomerOwnsToken(customer, tokenId);
  const updated = proxyServer.setManagedTokenEnabled(tokenId, enabled !== false);
  customer.updatedAt = new Date().toISOString();
  saveStore(store);
  return toTokenView(updated, new Map(), false);
}

function deleteToken(customerId, tokenId) {
  const store = loadStore();
  const customer = getCustomerById(store, customerId);
  if (!customer) {
    throw new Error(`customer not found: ${customerId}`);
  }
  ensureCustomerOwnsToken(customer, tokenId);
  const removed = proxyServer.deleteManagedToken(tokenId);
  customer.tokenIds = (customer.tokenIds || []).filter((tid) => tid !== tokenId);
  customer.updatedAt = new Date().toISOString();
  saveStore(store);
  return toTokenView(removed, new Map(), false);
}

function getCustomerSummary(customers = []) {
  const total = customers.length;
  let tokens = 0;
  for (const customer of customers) {
    tokens += Array.isArray(customer.tokens) ? customer.tokens.length : 0;
  }
  return { total, tokens };
}

function normalizeProviderList(input = []) {
  return normalizeStringArray(input).map((x) => x.toLowerCase());
}

function normalizeModelList(input = []) {
  return normalizeStringArray(input).map((x) => x.toLowerCase());
}

function deriveProvidersFromModels(modelIds = []) {
  const providers = new Set();
  for (const id of modelIds) {
    const provider = parseProviderFromModelId(id);
    if (provider) {
      providers.add(provider);
    }
  }
  return [...providers];
}

function ensureAutoSharedCustomer(options = {}) {
  if (String(process.env.AI_GATEWAY_AUTO_CUSTOMER || 'true').toLowerCase() === 'false') {
    return null;
  }

  const modelIds = normalizeModelList(options.modelIds || []);
  const providersInput = normalizeProviderList(options.providers || []);
  const providersDerived = deriveProvidersFromModels(modelIds);
  const allowedProviders = normalizeProviderList([...providersInput, ...providersDerived]);

  const store = loadStore();
  let customer = getCustomerById(store, AUTO_SHARED_CUSTOMER_ID);
  let changed = false;

  if (!customer) {
    customer = normalizeCustomer(
      {
        id: AUTO_SHARED_CUSTOMER_ID,
        name: '自动共享 API',
        enabled: true,
        allowedProviders,
        allowedModels: modelIds,
        quota: DEFAULT_QUOTA,
        note: AUTO_SHARED_CUSTOMER_NOTE_TAG,
        tokenIds: [],
      },
      new Set(store.customers.map((item) => item.id))
    );
    store.customers.push(customer);
    changed = true;
  } else {
    const nextProviders =
      allowedProviders.length > 0 ? allowedProviders : customer.allowedProviders || [];
    const nextModels = modelIds.length > 0 ? modelIds : customer.allowedModels || [];

    if (JSON.stringify(nextProviders) !== JSON.stringify(customer.allowedProviders || [])) {
      customer.allowedProviders = nextProviders;
      changed = true;
    }
    if (JSON.stringify(nextModels) !== JSON.stringify(customer.allowedModels || [])) {
      customer.allowedModels = nextModels;
      changed = true;
    }
    if (customer.name !== '自动共享 API') {
      customer.name = '自动共享 API';
      changed = true;
    }
    if (!String(customer.note || '').includes(AUTO_SHARED_CUSTOMER_NOTE_TAG)) {
      customer.note = [String(customer.note || '').trim(), AUTO_SHARED_CUSTOMER_NOTE_TAG]
        .filter(Boolean)
        .join(' ');
      changed = true;
    }
    if (customer.enabled === false) {
      customer.enabled = true;
      changed = true;
    }
  }

  if (!Array.isArray(customer.tokenIds)) {
    customer.tokenIds = [];
  }
  if (customer.tokenIds.length === 0) {
    const created = proxyServer.createManagedToken({
      label: 'auto-shared',
      enabled: true,
    });
    bindTokenToCustomer(store, customer, created.id);
    changed = true;
  }

  if (changed) {
    customer.updatedAt = new Date().toISOString();
    saveStore(store);
  }

  const rows = buildCustomerViews([customer], { includeSecrets: false });
  return rows[0] || null;
}

module.exports = {
  listCustomers,
  getCustomer,
  getCustomerByOwnerUserId,
  createCustomer,
  updateCustomer,
  adjustCustomerQuota,
  setCustomerEnabled,
  issueToken,
  rotateToken,
  setTokenEnabled,
  deleteToken,
  getCustomerSummary,
  ensureAutoSharedCustomer,
  // Store-level primitives (exposed for cross-process CAS tests + ops tooling)
  loadStore,
  saveStore,
  readRawVersion,
  sweepOrphanTemps,
};
