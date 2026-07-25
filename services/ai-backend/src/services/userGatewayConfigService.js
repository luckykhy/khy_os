/**
 * Per-user gateway config service (multi-tenant data plane).
 *
 * CRUD over UserGatewayConfig (relay/upstream) and UserProvider
 * (custom providers + key pool), all scoped by userId. Returns snapshots
 * shaped like the admin getModelConfigSnapshot() plus a `source` flag so
 * the user UI can show "current effective" values transparently.
 *
 * This service NEVER touches process.env or the global .env — global
 * mutation stays an admin-only concern. It is the single source the
 * data-plane resolver reads per-user upstream from.
 *
 * @pattern Strategy
 */
'use strict';

const { User, UserGatewayConfig, UserProvider, UserProviderModel } = require('@khy/shared/models');

// Self-heal: these per-user tables were added after the runtime DB schema was
// first materialized, so a DB created before the models exist (fresh install or
// an upgraded environment) is missing `user_providers` / `user_gateway_configs`
// / `user_provider_models` and every CRUD call fails with "no such table" —
// surfacing as an empty "我的模型目录". A memoized, non-destructive sync (CREATE
// TABLE IF NOT EXISTS; never drops/alters existing tables or data) runs once per
// process on first access so the tables materialize on demand without a separate
// migration step.
//
// The parent `users` table MUST be synced first: UserProvider / UserGatewayConfig
// / UserProviderModel all `belongsTo(User)` WITH foreign-key constraints, so on a
// fresh-or-misrouted DB (the documented KHYQUANT_ROOT-mismatch case) READS of the
// child tables succeed once `.sync()` creates them, but the first WRITE
// (`UserProvider.create` when adding / replacing a key) fails under SQLite FK
// enforcement with `no such table: main.users`. That surfaced exactly as
// "系统已经配置 sk 管理看不见，没法替换" — the list/overview look empty and every
// add/replace 500s. Materializing the parent here closes that gap deterministically.
let _schemaReady = null;
function ensureSchema() {
  if (!_schemaReady) {
    // Sync the parent (`users`) before the FK-bearing children so the references
    // resolve. Then create the per-user tables concurrently. All `.sync()` calls
    // are CREATE TABLE IF NOT EXISTS — never drops/alters existing tables or data.
    _schemaReady = User.sync()
      .then(() => Promise.all([
        UserGatewayConfig.sync(),
        UserProvider.sync(),
        UserProviderModel.sync(),
      ]))
      .then(() => _backfillImageColumns())
      .catch((err) => {
        // Let a genuinely broken DB surface on the actual query below; don't cache
        // the failure, so a transient error can be retried on the next call.
        _schemaReady = null;
        throw err;
      });
  }
  return _schemaReady;
}

// `.sync()` only does CREATE TABLE IF NOT EXISTS — it never adds columns to an
// existing table. The image-preference columns were added after user_gateway_configs
// first materialized, so backfill them additively and fail-soft (the column may
// already exist, or the dialect/driver may differ); the snapshot/save helpers
// tolerate their absence either way.
async function _backfillImageColumns() {
  try {
    const qi = UserGatewayConfig.sequelize.getQueryInterface();
    const table = await qi.describeTable('user_gateway_configs').catch(() => ({}));
    const { DataTypes } = require('sequelize');
    if (!table.image_backend) {
      await qi.addColumn('user_gateway_configs', 'image_backend', { type: DataTypes.STRING(32), defaultValue: '' }).catch(() => {});
    }
    if (!table.image_model) {
      await qi.addColumn('user_gateway_configs', 'image_model', { type: DataTypes.STRING(200), defaultValue: '' }).catch(() => {});
    }
  } catch { /* non-fatal: image prefs degrade to global/auto */ }
}

const API_FORMATS = ['openai', 'anthropic', 'openai_responses', 'gemini'];
const KEY_FIELDS = ['authorization_bearer', 'x-api-key', 'x-goog-api-key'];
const COMPATIBILITIES = ['openai', 'anthropic', 'unknown'];

function normalizeApiFormat(raw = '') {
  const v = String(raw || '').trim().toLowerCase();
  return API_FORMATS.includes(v) ? v : '';
}

function normalizeApiKeyField(raw = '') {
  const v = String(raw || '').trim().toLowerCase();
  return KEY_FIELDS.includes(v) ? v : '';
}

function normalizeCompatibility(raw = '') {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'openai';
  return COMPATIBILITIES.includes(v) ? v : 'unknown';
}

function deriveApiFormatFromCompat(compatibility) {
  return compatibility === 'anthropic' ? 'anthropic' : 'openai';
}

function defaultKeyFieldFor(apiFormat) {
  if (apiFormat === 'anthropic') return 'x-api-key';
  if (apiFormat === 'gemini') return 'x-goog-api-key';
  return 'authorization_bearer';
}

function normalizeHttpUrl(raw = '') {
  const url = String(raw || '').trim();
  if (!url) return { ok: false, error: 'baseUrl is required' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'baseUrl must be a valid http(s) URL' };
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    return { ok: false, error: 'baseUrl must be a valid http(s) URL' };
  }
  return { ok: true, url: url.replace(/\/+$/, '') };
}

function maskSecret(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return s.slice(0, 2) + '****';
  return `${s.slice(0, 4)}...${s.slice(-2)}`;
}

function normalizeEndpoints(input, primaryUrl) {
  let list = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'string') {
    list = input.split(/[\n,;]+/);
  }
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const u = String(raw || '').trim().replace(/\/+$/, '');
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) {
      const err = new Error(`endpoint is not a valid http(s) URL: ${u}`);
      err.statusCode = 400;
      throw err;
    }
    if (u === primaryUrl) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Build the per-user relay snapshot (admin-shape + `source`).
 * `source` = 'user' when a usable config row exists, else 'none'.
 */
function buildRelaySnapshot(row) {
  if (!row || !row.baseUrl) {
    return {
      baseUrl: '',
      modelId: '',
      compatibility: 'openai',
      apiFormat: 'openai',
      apiKeyField: 'authorization_bearer',
      endpoints: [],
      hasApiKey: false,
      apiKeyMasked: '',
      source: 'none',
    };
  }
  const apiKey = row.apiKey || '';
  return {
    baseUrl: row.baseUrl,
    modelId: row.model || '',
    compatibility: row.compatibility || 'openai',
    apiFormat: row.apiFormat || 'openai',
    apiKeyField: row.apiKeyField || 'authorization_bearer',
    endpoints: row.endpoints || [],
    hasApiKey: !!apiKey,
    apiKeyMasked: maskSecret(apiKey),
    source: 'user',
  };
}

async function getRelayConfig(userId) {
  await ensureSchema();
  const row = await UserGatewayConfig.findOne({ where: { userId } });
  return buildRelaySnapshot(row);
}

/**
 * Upsert the per-user relay config. Mirrors admin PUT /model-config
 * validation. Returns the fresh snapshot.
 */
async function saveRelayConfig(userId, body = {}) {
  await ensureSchema();
  const baseUrlRes = normalizeHttpUrl(body.baseUrl);
  if (!baseUrlRes.ok) {
    const err = new Error(baseUrlRes.error);
    err.statusCode = 400;
    throw err;
  }
  const modelId = String(body.modelId || '').trim();
  if (!modelId) {
    const err = new Error('modelId is required');
    err.statusCode = 400;
    throw err;
  }

  const compatibility = normalizeCompatibility(body.compatibility);

  let apiFormat = normalizeApiFormat(body.apiFormat);
  if (body.apiFormat && !apiFormat) {
    const err = new Error('apiFormat must be openai|anthropic|openai_responses|gemini');
    err.statusCode = 400;
    throw err;
  }
  if (!apiFormat) apiFormat = deriveApiFormatFromCompat(compatibility);

  let apiKeyField = normalizeApiKeyField(body.apiKeyField);
  if (body.apiKeyField && !apiKeyField) {
    const err = new Error('apiKeyField must be authorization_bearer|x-api-key|x-goog-api-key');
    err.statusCode = 400;
    throw err;
  }
  if (!apiKeyField) apiKeyField = defaultKeyFieldFor(apiFormat);

  const endpoints = normalizeEndpoints(body.endpoints, baseUrlRes.url);

  const [row] = await UserGatewayConfig.findOrCreate({
    where: { userId },
    defaults: { userId },
  });

  row.baseUrl = baseUrlRes.url;
  row.model = modelId;
  row.compatibility = compatibility;
  row.apiFormat = apiFormat;
  row.apiKeyField = apiKeyField;
  row.endpoints = endpoints;
  row.isActive = true;

  if (body.clearApiKey === true) {
    row.apiKey = null;
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    row.apiKey = body.apiKey.trim();
  } // else: leave existing key untouched

  await row.save();
  return buildRelaySnapshot(row);
}

/**
 * Resolved (decrypted) relay config for the data plane, or null when the
 * user has no usable config. Used by userGatewayResolver only.
 */
async function getResolvedRelay(userId) {
  await ensureSchema();
  const row = await UserGatewayConfig.findOne({ where: { userId } });
  if (!row || !row.isActive || !row.baseUrl) return null;
  return {
    apiFormat: row.apiFormat || 'openai',
    baseUrl: row.baseUrl,
    model: row.model || '',
    apiKey: row.apiKey || '',
    apiKeyField: row.apiKeyField || 'authorization_bearer',
    endpoints: row.endpoints || [],
  };
}

// ── Per-user image-generation model preference ──
// Mirrors the global env-backed image-config, but scoped per user. The engine
// (services/backend image_generate tool) reads this row by userId when the tool
// loop carries identity, and falls back to the global env/auto when it does not.

const IMAGE_BACKENDS = ['openai', 'agnes', 'domestic', 'sd_webui'];

function buildImagePrefSnapshot(row) {
  const backend = row && row.imageBackend ? String(row.imageBackend).trim().toLowerCase() : '';
  const model = row && row.imageModel ? String(row.imageModel).trim() : '';
  return { backend: backend || 'auto', model, source: backend ? 'user' : 'none' };
}

async function getImagePref(userId) {
  await ensureSchema();
  const row = await UserGatewayConfig.findOne({ where: { userId } });
  return buildImagePrefSnapshot(row);
}

/**
 * Upsert the per-user preferred image backend/model. `backend` empty or 'auto'
 * clears the pin (engine falls back to global/auto). Returns the fresh snapshot.
 */
async function saveImagePref(userId, body = {}) {
  await ensureSchema();
  const rawBackend = String(body.backend != null ? body.backend : '').trim().toLowerCase();
  const isAuto = !rawBackend || rawBackend === 'auto';
  if (!isAuto && !IMAGE_BACKENDS.includes(rawBackend)) {
    const err = new Error(`backend must be one of ${IMAGE_BACKENDS.join(', ')} or auto`);
    err.statusCode = 400;
    throw err;
  }
  const rawModel = String(body.model != null ? body.model : '').trim();

  const [row] = await UserGatewayConfig.findOrCreate({
    where: { userId },
    defaults: { userId },
  });
  row.imageBackend = isAuto ? '' : rawBackend;
  row.imageModel = isAuto ? '' : rawModel;
  await row.save();
  return buildImagePrefSnapshot(row);
}

// ── Custom providers + key pool (per-user) ──

function mapProviderRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.displayName || '',
    apiFormat: row.apiFormat || 'openai',
    baseUrl: row.baseUrl || '',
    protocol: row.protocol || '',
    endpoint: row.endpoint || '',
    priority: row.priority || 0,
    label: row.label || '',
    keyMasked: maskSecret(row.key || ''),
    isActive: row.isActive,
  };
}

async function listProviders(userId) {
  await ensureSchema();
  const rows = await UserProvider.findAll({
    where: { userId },
    order: [['provider', 'ASC'], ['priority', 'DESC'], ['id', 'ASC']],
  });
  return rows.map(mapProviderRow);
}

async function addProviderEntry(userId, payload = {}) {
  await ensureSchema();
  const provider = String(payload.provider || '').trim().toLowerCase();
  if (!provider || !/^[a-z0-9._-]{2,40}$/.test(provider)) {
    const err = new Error('provider must match [a-z0-9._-]{2,40}');
    err.statusCode = 400;
    throw err;
  }
  const key = String(payload.key || '').trim();
  if (!key) {
    const err = new Error('key is required');
    err.statusCode = 400;
    throw err;
  }

  // Dedupe by decrypted key within (userId, provider) — encryption uses a
  // random IV, so a DB unique index on the ciphertext cannot dedupe.
  const existing = await UserProvider.findAll({ where: { userId, provider } });
  if (existing.some((r) => r.key === key)) {
    const err = new Error('This key already exists for this provider');
    err.statusCode = 409;
    throw err;
  }

  let endpoint = String(payload.endpoint || '').trim();
  let baseUrl = String(payload.baseUrl || '').trim();
  if (baseUrl) {
    const res = normalizeHttpUrl(baseUrl);
    if (!res.ok) { const e = new Error(res.error); e.statusCode = 400; throw e; }
    baseUrl = res.url;
  }

  const row = await UserProvider.create({
    userId,
    provider,
    displayName: String(payload.displayName || '').trim(),
    apiFormat: normalizeApiFormat(payload.apiFormat) || 'openai',
    baseUrl,
    protocol: String(payload.protocol || '').trim(),
    key,
    endpoint,
    priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 0,
    label: String(payload.label || '').trim(),
    isActive: true,
  });
  return mapProviderRow(row);
}

// Replace the API key of a single provider entry in place, keeping
// provider/displayName/baseUrl/endpoint/priority/label untouched. Replacing a
// key with one that already exists for the same provider is a 409; replacing
// with the identical key is a no-op that returns the row unchanged.
async function replaceProviderKey(userId, id, newKey) {
  await ensureSchema();
  const key = String(newKey || '').trim();
  if (!key) {
    const err = new Error('key is required');
    err.statusCode = 400;
    throw err;
  }
  const row = await UserProvider.findOne({ where: { userId, id } });
  if (!row) {
    const err = new Error('Provider entry not found');
    err.statusCode = 404;
    throw err;
  }
  if (row.key === key) return mapProviderRow(row);

  const siblings = await UserProvider.findAll({ where: { userId, provider: row.provider } });
  if (siblings.some((r) => r.id !== row.id && r.key === key)) {
    const err = new Error('This key already exists for this provider');
    err.statusCode = 409;
    throw err;
  }

  row.key = key;
  await row.save();
  return mapProviderRow(row);
}

/**
 * Migrate every model row a user owns under `fromProvider` to `toProvider`,
 * de-duplicating against any row the target provider already has (the
 * (userId, provider, model) unique index forbids a blind UPDATE). A clashing
 * source row is dropped (the target already serves that model); otherwise the
 * row is re-pointed. No-op when the names are equal.
 */
async function migrateProviderModels(userId, fromProvider, toProvider) {
  const from = String(fromProvider || '').trim().toLowerCase();
  const to = String(toProvider || '').trim().toLowerCase();
  if (!from || !to || from === to) return;
  const rows = await UserProviderModel.findAll({ where: { userId, provider: from } });
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const clash = await UserProviderModel.findOne({ where: { userId, provider: to, model: row.model } });
    if (clash) {
      // eslint-disable-next-line no-await-in-loop
      await row.destroy();
    } else {
      row.provider = to;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
    }
  }
}

/**
 * Edit one provider entry in place: any of displayName / baseUrl / apiFormat /
 * endpoint / protocol / label / priority, an optional key rotation (only when a
 * non-empty `key` is supplied), and an optional provider RENAME. Renaming
 * re-points the entry AND migrates the user's models for that provider to the
 * new name (state continuity — a rename never silently orphans the catalog).
 *
 * Guards: 404 unknown id; 400 invalid provider/baseUrl/apiFormat; 409 when the
 * resulting (provider, key) collides with another of the user's entries. A bare
 * `{ key }` patch behaves exactly like the legacy replaceProviderKey (the route
 * delegates here), so the key-only contract is preserved.
 */
async function updateProviderEntry(userId, id, patch = {}) {
  await ensureSchema();
  const row = await UserProvider.findOne({ where: { userId, id } });
  if (!row) {
    const err = new Error('Provider entry not found');
    err.statusCode = 404;
    throw err;
  }

  // Resolve the target provider (rename) up front so dup-checks consider it.
  let targetProvider = row.provider;
  if (patch.provider != null && String(patch.provider).trim() !== '') {
    const next = String(patch.provider).trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(next)) {
      const err = new Error('provider must match [a-z0-9._-]{2,40}');
      err.statusCode = 400;
      throw err;
    }
    targetProvider = next;
  }

  // Resolve the target key (rotation) — empty/omitted means "keep current".
  let targetKey = row.key;
  if (patch.key != null && String(patch.key).trim() !== '') {
    targetKey = String(patch.key).trim();
  }

  // Collision: another entry of this user that would share (provider, key).
  if (targetProvider !== row.provider || targetKey !== row.key) {
    const siblings = await UserProvider.findAll({ where: { userId, provider: targetProvider } });
    if (siblings.some((r) => r.id !== row.id && r.key === targetKey)) {
      const err = new Error('This key already exists for this provider');
      err.statusCode = 409;
      throw err;
    }
  }

  // Metadata (each field optional; undefined leaves it untouched).
  if (patch.displayName !== undefined) row.displayName = String(patch.displayName || '').trim();
  if (patch.label !== undefined) row.label = String(patch.label || '').trim();
  if (patch.protocol !== undefined) row.protocol = String(patch.protocol || '').trim();
  if (patch.endpoint !== undefined) row.endpoint = String(patch.endpoint || '').trim();
  if (patch.priority !== undefined && Number.isFinite(Number(patch.priority))) {
    row.priority = Number(patch.priority);
  }
  if (patch.apiFormat !== undefined && String(patch.apiFormat).trim() !== '') {
    const fmt = normalizeApiFormat(patch.apiFormat);
    if (!fmt) {
      const err = new Error('apiFormat must be openai|anthropic|openai_responses|gemini');
      err.statusCode = 400;
      throw err;
    }
    row.apiFormat = fmt;
  }
  if (patch.baseUrl !== undefined) {
    const raw = String(patch.baseUrl || '').trim();
    if (raw) {
      const res = normalizeHttpUrl(raw);
      if (!res.ok) { const e = new Error(res.error); e.statusCode = 400; throw e; }
      row.baseUrl = res.url;
    } else {
      row.baseUrl = '';
    }
  }

  // Apply key + provider rename last, then migrate models on a rename.
  const previousProvider = row.provider;
  row.key = targetKey;
  row.provider = targetProvider;
  await row.save();
  if (targetProvider !== previousProvider) {
    await migrateProviderModels(userId, previousProvider, targetProvider);
  }
  return mapProviderRow(row);
}

async function removeProviderEntry(userId, id) {
  await ensureSchema();
  const removed = await UserProvider.destroy({ where: { userId, id } });
  return { removed: removed > 0, id: Number(id) };
}

async function removeProvider(userId, provider) {
  await ensureSchema();
  const p = String(provider || '').trim().toLowerCase();
  const removed = await UserProvider.destroy({ where: { userId, provider: p } });
  return { removed, provider: p };
}

/** Decrypted active provider entries for the data plane resolver. */
async function getResolvedProviders(userId) {
  await ensureSchema();
  const rows = await UserProvider.findAll({
    where: { userId, isActive: true },
    order: [['priority', 'DESC'], ['id', 'ASC']],
  });
  return rows.map((r) => ({
    provider: r.provider,
    apiFormat: r.apiFormat || 'openai',
    baseUrl: r.baseUrl || '',
    endpoint: r.endpoint || '',
    key: r.key || '',
    priority: r.priority || 0,
  }));
}

// ── Per-user detected/added models (user_provider_models) ──

function mapModelRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    capability: row.capability || 'text',
    source: row.source || 'detected',
    isActive: row.isActive,
  };
}

/** List a user's persisted models, optionally scoped to one provider. */
async function listModels(userId, opts = {}) {
  await ensureSchema();
  const where = { userId };
  if (opts.provider) where.provider = String(opts.provider).trim().toLowerCase();
  const rows = await UserProviderModel.findAll({
    where,
    order: [['provider', 'ASC'], ['model', 'ASC']],
  });
  return rows.map(mapModelRow);
}

/**
 * Union-merge a batch of (provider, model) pairs into the user's store.
 * Idempotent: existing (userId, provider, model) rows are left in place (only
 * capability/source refreshed); new ones are created. Never deletes — manual
 * additions survive a re-probe. Returns { added, total } for state transparency.
 *
 * @param {Array<{model:string, capability?:string}>|string[]} items
 */
async function upsertModels(userId, provider, items = [], opts = {}) {
  await ensureSchema();
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return { added: 0, total: 0 };
  const source = String(opts.source || 'detected').trim() || 'detected';

  let added = 0;
  for (const raw of items) {
    const model = String((raw && raw.model != null) ? raw.model : raw).trim();
    if (!model) continue;
    const capability = String((raw && raw.capability) || 'text').trim() || 'text';
    // eslint-disable-next-line no-await-in-loop
    const [row, created] = await UserProviderModel.findOrCreate({
      where: { userId, provider: p, model },
      defaults: { userId, provider: p, model, capability, source, isActive: true },
    });
    if (created) {
      added += 1;
    } else if (row.capability !== capability || row.source !== source || !row.isActive) {
      row.capability = capability;
      row.source = source;
      row.isActive = true;
      // eslint-disable-next-line no-await-in-loop
      await row.save();
    }
  }
  const total = await UserProviderModel.count({ where: { userId, provider: p } });
  return { added, total };
}

const VALID_CAPABILITIES = ['text', 'audio', 'image', 'video'];

// Provider id a model may belong to: any user provider name or the relay upstream.
function normalizeModelProvider(raw = '') {
  const p = String(raw || '').trim().toLowerCase();
  if (!p || !/^[a-z0-9._-]{2,40}$/.test(p)) {
    const err = new Error('provider must match [a-z0-9._-]{2,40} (or "relay")');
    err.statusCode = 400;
    throw err;
  }
  return p;
}

function normalizeCapability(raw, modelId) {
  const c = String(raw || '').trim().toLowerCase();
  if (c) {
    if (!VALID_CAPABILITIES.includes(c)) {
      const err = new Error('capability must be text|audio|image|video');
      err.statusCode = 400;
      throw err;
    }
    return c;
  }
  // No explicit capability → classify from the model id (shared backend classifier,
  // imported lazily to keep this module's load order independent of the backend).
  try {
    // eslint-disable-next-line global-require
    const modelCapability = require('../../../backend/src/services/gateway/modelCapability');
    return modelCapability.classifyCapability(modelId) || 'text';
  } catch {
    return 'text';
  }
}

/**
 * Manually add ONE model to the user's catalog (source:'manual'). Distinct from
 * upsertModels (batch, detection path): a single explicit add returns 409 when
 * the (user, provider, model) row already exists, so the UI can report a clear
 * "already in your list" instead of silently no-op'ing.
 */
async function addModel(userId, payload = {}) {
  await ensureSchema();
  const provider = normalizeModelProvider(payload.provider);
  const model = String(payload.model || '').trim();
  if (!model) {
    const err = new Error('model is required');
    err.statusCode = 400;
    throw err;
  }
  if (model.length > 200) {
    const err = new Error('model id is too long (max 200)');
    err.statusCode = 400;
    throw err;
  }
  const capability = normalizeCapability(payload.capability, model);

  const [row, created] = await UserProviderModel.findOrCreate({
    where: { userId, provider, model },
    defaults: { userId, provider, model, capability, source: 'manual', isActive: true },
  });
  if (!created) {
    const err = new Error('This model already exists for this provider');
    err.statusCode = 409;
    throw err;
  }
  return mapModelRow(row);
}

/**
 * Update a model row scoped to the owner. Editable fields: capability, isActive,
 * and a model rename. Renaming validates the new id and guards the
 * (user, provider, model) unique index (409 on collision). 404 when the row is
 * not the caller's. Provenance flips to 'manual' on a hand edit (it is no longer
 * purely what the probe returned).
 */
async function updateModel(userId, id, patch = {}) {
  await ensureSchema();
  const row = await UserProviderModel.findOne({ where: { userId, id } });
  if (!row) {
    const err = new Error('model not found');
    err.statusCode = 404;
    throw err;
  }

  if (patch.model != null) {
    const model = String(patch.model).trim();
    if (!model) { const e = new Error('model cannot be empty'); e.statusCode = 400; throw e; }
    if (model.length > 200) { const e = new Error('model id is too long (max 200)'); e.statusCode = 400; throw e; }
    if (model !== row.model) {
      const clash = await UserProviderModel.findOne({ where: { userId, provider: row.provider, model } });
      if (clash) { const e = new Error('This model already exists for this provider'); e.statusCode = 409; throw e; }
      row.model = model;
    }
  }
  if (patch.capability != null) {
    row.capability = normalizeCapability(patch.capability, row.model);
  }
  if (patch.isActive != null) {
    row.isActive = !!patch.isActive;
  }
  row.source = 'manual';
  await row.save();
  return mapModelRow(row);
}

async function removeModel(userId, id) {
  await ensureSchema();
  const removed = await UserProviderModel.destroy({ where: { userId, id } });
  return { removed: removed > 0, id: Number(id) };
}

module.exports = {
  getRelayConfig,
  saveRelayConfig,
  getResolvedRelay,
  getImagePref,
  saveImagePref,
  listProviders,
  addProviderEntry,
  replaceProviderKey,
  updateProviderEntry,
  removeProviderEntry,
  removeProvider,
  getResolvedProviders,
  listModels,
  upsertModels,
  addModel,
  updateModel,
  removeModel,
  // exported for tests / reuse
  ensureSchema,
  maskSecret,
  normalizeApiFormat,
  normalizeApiKeyField,
};
