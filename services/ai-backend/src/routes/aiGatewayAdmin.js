/**
 * AI Gateway Admin REST API + SSE endpoints.
 *
 * Mounted at /api/ai-gateway in the main Express app.
 *
 * Endpoints:
 *   GET  /status              — Full gateway status
 *   GET  /config              — Gateway config (env-backed)
 *   PUT  /config              — Update gateway config
 *   GET  /pool                — API key pool status per provider
 *   POST /pool/:provider/keys — Add a key
 *   DELETE /pool/:provider/keys/:keyId — Remove a key
 *   GET  /monitor/traces      — Query traces
 *   GET  /monitor/stats       — Aggregated stats
 *   GET  /monitor/stream      — SSE real-time trace stream
 *   GET  /oauth/providers     — OAuth provider capabilities + status
 *   GET  /oauth/status        — OAuth token status
 *   GET  /oauth/credentials/:provider — OAuth status for provider
 *   PUT  /oauth/credentials/:provider — Save OAuth credentials
 *   DELETE /oauth/credentials/:provider — Clear OAuth credentials
 *   POST /oauth/:provider/refresh — Force refresh
 *   GET  /plugins             — List gateway plugins
 *   POST /plugins/:name/toggle — Enable/disable plugin
 *   GET  /tls/status          — TLS sidecar status
 *   POST /tls/start           — Start sidecar
 *   POST /tls/stop            — Stop sidecar
 *   GET  /protocols           — Supported protocols
 *   GET  /slots               — Concurrency slot status
 *   GET  /model-slots         — Claude Code model slot mappings
 *   PUT  /model-slots         — Update model slot mappings
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();
const assetCustomerService = require('../services/aiAssetCustomerService');
// Model-name SSOT: the Ollama default model flows from backend constants/models.js.
const { PRIMARY: MODELS } = require('../constants/models');

const ENV_PATH = path.resolve(__dirname, '../../.env');

const GATEWAY_CONFIG_FIELDS = Object.freeze({
  preferredAdapter: { envKey: 'GATEWAY_PREFERRED_ADAPTER', type: 'string', allowUnset: true, defaultValue: null },
  preferredModel: { envKey: 'GATEWAY_PREFERRED_MODEL', type: 'string', allowUnset: true, defaultValue: null },
  cliEnabled: { envKey: 'GATEWAY_CLI_ENABLED', type: 'boolean', defaultValue: true },
  relayPort: { envKey: 'GATEWAY_RELAY_PORT', type: 'string', defaultValue: '9099' },
  ollamaHost: { envKey: 'OLLAMA_HOST', type: 'string', defaultValue: process.env.OLLAMA_HOST || '' },
  ollamaModel: { envKey: 'OLLAMA_MODEL', type: 'string', defaultValue: MODELS.ollama },
  modelRouteMap: { envKey: 'GATEWAY_MODEL_ROUTE_MAP', type: 'json', defaultValue: {} },
  modelRouteStrict: { envKey: 'GATEWAY_MODEL_ROUTE_STRICT', type: 'boolean', defaultValue: false },
  keySelectionStrategy: { envKey: 'GATEWAY_KEY_SELECTION_STRATEGY', type: 'string', defaultValue: 'round-robin' },
  keySelectionStrategyMap: { envKey: 'GATEWAY_KEY_SELECTION_STRATEGY_MAP', type: 'json', defaultValue: {} },
  apiPoolProvider: { envKey: 'GATEWAY_API_POOL_PROVIDER', type: 'string', allowUnset: true, defaultValue: '' },
  apiPoolProviderAliasMap: { envKey: 'GATEWAY_API_POOL_PROVIDER_ALIAS_MAP', type: 'json', defaultValue: {} },
  apiPoolServiceMap: { envKey: 'GATEWAY_API_POOL_SERVICE_MAP', type: 'json', defaultValue: {} },
  apiPoolDefaultModelMap: { envKey: 'GATEWAY_API_POOL_DEFAULT_MODEL_MAP', type: 'json', defaultValue: {} },
});

const parseBoolean = (value, fallback = false) => require('../../../backend/src/utils/parseBoolean')(value, fallback, { extended: false });

function parseJsonObject(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function formatJsonCompact(value) {
  return JSON.stringify(value || {});
}

function readEnvContent() {
  try {
    return fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function setEnvLine(envContent, envKey, value) {
  const line = `${envKey}=${value}`;
  const regex = new RegExp(`^${envKey}=.*$`, 'm');
  if (regex.test(envContent)) return envContent.replace(regex, line);
  const base = envContent.trimEnd();
  return base ? `${base}\n${line}\n` : `${line}\n`;
}

function removeEnvLine(envContent, envKey) {
  const regex = new RegExp(`^${envKey}=.*(?:\\r?\\n)?`, 'm');
  return envContent.replace(regex, '');
}

function normalizeJsonInput(fieldName, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error(`${fieldName} must be a JSON object`);
    } catch (err) {
      throw new Error(`${fieldName} must be a valid JSON object`);
    }
  }
  throw new Error(`${fieldName} must be a JSON object`);
}

function normalizeStringInput(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function buildGatewayConfigSnapshot() {
  const out = {};
  for (const [field, meta] of Object.entries(GATEWAY_CONFIG_FIELDS)) {
    const raw = process.env[meta.envKey];
    if (meta.type === 'boolean') {
      out[field] = parseBoolean(raw, !!meta.defaultValue);
      continue;
    }
    if (meta.type === 'json') {
      out[field] = parseJsonObject(raw, meta.defaultValue || {});
      continue;
    }
    if (raw === undefined || raw === null || raw === '') {
      out[field] = meta.defaultValue;
      continue;
    }
    out[field] = String(raw);
  }
  return out;
}

function resolveFieldUpdate(fieldName, incomingValue) {
  const meta = GATEWAY_CONFIG_FIELDS[fieldName];
  if (!meta || incomingValue === undefined) return null;

  if (meta.type === 'boolean') {
    const normalized = parseBoolean(incomingValue, !!meta.defaultValue);
    return {
      envKey: meta.envKey,
      normalizedValue: normalized,
      envValue: normalized ? 'true' : 'false',
      unset: false,
    };
  }

  if (meta.type === 'json') {
    const normalized = normalizeJsonInput(fieldName, incomingValue);
    return {
      envKey: meta.envKey,
      normalizedValue: normalized,
      envValue: formatJsonCompact(normalized),
      unset: false,
    };
  }

  const normalized = normalizeStringInput(incomingValue);
  const shouldUnset = !!meta.allowUnset && !normalized;
  return {
    envKey: meta.envKey,
    normalizedValue: shouldUnset ? meta.defaultValue : normalized,
    envValue: normalized,
    unset: shouldUnset,
  };
}

// 收敛到 utils/normalizeCompatibility 单一真源(逐字节委托,调用点不变)
const normalizeCompatibility = require('../../../backend/src/utils/normalizeCompatibility');

// Explicit upstream wire protocol (cc-switch-inspired api_format). Empty input
// returns '' so callers can fall back to deriving from `compatibility`.
const RELAY_API_FORMATS = new Set(['openai', 'anthropic', 'openai_responses', 'gemini']);
function normalizeApiFormat(raw = '') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'openai_chat' || value === 'openai-chat') return 'openai';
  if (value === 'gemini_native') return 'gemini';
  if (value === 'responses' || value === 'codex') return 'openai_responses';
  return RELAY_API_FORMATS.has(value) ? value : '';
}

// Auth header field (cc-switch-inspired api_key_field).
const RELAY_KEY_FIELDS = new Set(['authorization_bearer', 'x-api-key', 'x-goog-api-key']);
function normalizeApiKeyField(raw = '') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'bearer' || value === 'authorization') return 'authorization_bearer';
  if (value === 'anthropic_auth_token' || value === 'anthropic_api_key' || value === 'x_api_key') return 'x-api-key';
  if (value === 'x_goog_api_key' || value === 'google') return 'x-goog-api-key';
  return RELAY_KEY_FIELDS.has(value) ? value : '';
}

// Derive the default apiFormat/keyField from legacy compatibility so existing
// configs keep behaving identically when the new fields are not supplied.
function deriveApiFormatFromCompat(compatibility) {
  return compatibility === 'anthropic' ? 'anthropic' : 'openai';
}
function defaultKeyFieldFor(apiFormat) {
  if (apiFormat === 'anthropic') return 'x-api-key';
  if (apiFormat === 'gemini') return 'x-goog-api-key';
  return 'authorization_bearer';
}

function normalizeOpenAiLikeBaseUrl(raw = '') {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'empty' };
  let parsed = null;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'invalid-url' };
  }
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: 'invalid-protocol' };
  }
  let pathname = String(parsed.pathname || '').replace(/\/+$/g, '');
  let appendedV1 = false;
  if (!pathname) {
    pathname = '/v1';
    appendedV1 = true;
  } else if (!/\/v1$/i.test(pathname)) {
    pathname = `${pathname}/v1`;
    appendedV1 = true;
  }
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';
  return {
    ok: true,
    url: parsed.toString().replace(/\/$/, ''),
    appendedV1,
  };
}

function normalizeApiKeyToken(raw = '') {
  let token = String(raw || '').trim();
  if (!token) return '';
  token = token.replace(/^Bearer\s+/i, '').trim();
  const kvMatch = token.match(/^(?:api[-_\s]*key|key|token)\s*[:=]\s*(.+)$/i);
  if (kvMatch) token = String(kvMatch[1] || '').trim();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith('\'') && token.endsWith('\''))) {
    token = token.slice(1, -1).trim();
  }
  return token;
}

function parseApiKeyEntries(input) {
  const out = [];
  const pushToken = (rawToken) => {
    const token = normalizeApiKeyToken(rawToken);
    if (!token) return;
    if (!out.some(entry => entry.key === token)) {
      out.push({ key: token });
    }
  };

  const parseAny = (value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) parseAny(item);
      return;
    }
    if (typeof value === 'object') {
      if (value.apiKey !== undefined) pushToken(value.apiKey);
      if (value.key !== undefined) pushToken(value.key);
      if (value.token !== undefined) pushToken(value.token);
      if (value.keys !== undefined) parseAny(value.keys);
      if (value.tokens !== undefined) parseAny(value.tokens);
      return;
    }
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text) return;
    if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
      try {
        parseAny(JSON.parse(text));
        return;
      } catch {
        // fall through
      }
    }
    const chunks = text.split(/[\n,;]+/g);
    for (const chunk of chunks) pushToken(chunk);
  };

  parseAny(input);
  return out;
}

function extractPrimaryApiKey(input) {
  const entries = parseApiKeyEntries(input);
  return entries.length > 0 ? entries[0].key : '';
}

// 收敛到 utils/maskSecret 单一真源(逐字节委托,调用点不变)
const maskSecret = require('../../../backend/src/utils/maskSecret');

function getModelConfigSnapshot() {
  const baseUrl = String(process.env.RELAY_API_ENDPOINT || '').trim();
  const modelId = String(process.env.RELAY_API_MODEL || '').trim();
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  const compatibility = normalizeCompatibility(process.env.RELAY_API_COMPATIBILITY || 'openai') || 'openai';
  const apiKey = extractPrimaryApiKey(process.env.RELAY_API_KEY || '');
  const apiFormat = normalizeApiFormat(process.env.RELAY_API_FORMAT || '')
    || deriveApiFormatFromCompat(compatibility);
  const apiKeyField = normalizeApiKeyField(process.env.RELAY_API_KEY_FIELD || '')
    || defaultKeyFieldFor(apiFormat);
  const endpoints = String(process.env.RELAY_API_ENDPOINTS || '')
    .split(/[\n,;]+/g).map((s) => s.trim()).filter(Boolean);
  return {
    baseUrl,
    modelId,
    compatibility,
    apiFormat,
    apiKeyField,
    endpoints,
    preferredAdapter,
    preferredModel,
    hasApiKey: !!apiKey,
    apiKeyMasked: apiKey ? maskSecret(apiKey) : '',
  };
}

// All routes require admin authentication
router.use(authenticateToken, requireAdmin);

// ── Status ──

router.get('/status', async (req, res) => {
  try {
    const gateway = require('../services/gateway/aiGateway');
    if (!gateway._initialized) await gateway.init();
    const statuses = gateway.getStatus();
    const active = gateway.getActiveAdapter();
    res.json({ adapters: statuses, active: active ? { name: active.name, type: active.type } : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config ──

router.get('/config', (req, res) => {
  try {
    res.json(buildGatewayConfigSnapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', (req, res) => {
  try {
    const body = req.body || {};
    const updates = [];

    for (const fieldName of Object.keys(GATEWAY_CONFIG_FIELDS)) {
      const update = resolveFieldUpdate(fieldName, body[fieldName]);
      if (update) updates.push({ fieldName, ...update });
    }

    if (updates.length === 0) {
      return res.json({ success: true, updated: [], config: buildGatewayConfigSnapshot() });
    }

    let envContent = readEnvContent();
    const updated = [];

    for (const item of updates) {
      if (item.unset) {
        envContent = removeEnvLine(envContent, item.envKey);
        delete process.env[item.envKey];
      } else {
        envContent = setEnvLine(envContent, item.envKey, item.envValue);
        process.env[item.envKey] = item.envValue;
      }
      updated.push(item.fieldName);
    }

    const tmpPath = `${ENV_PATH}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, envContent, 'utf-8');
    fs.renameSync(tmpPath, ENV_PATH);

    res.json({ success: true, updated, config: buildGatewayConfigSnapshot() });
  } catch (err) {
    const status = err.message.includes('JSON object') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Pool ──

router.get('/pool', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    res.json(pool.getAllStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pool/:provider/keys', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    const provider = normalizeProviderName(req.params.provider);
    if (!isValidProviderName(provider)) {
      return res.status(400).json({
        error: `Invalid provider. Use lowercase letters/numbers/_/.- (2-40 chars), or one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    const keyInput = req.body?.keys ?? req.body?.apiKey ?? req.body?.key;
    const entries = parseApiKeyEntries(keyInput);
    if (!entries.length) return res.status(400).json({ error: 'key is required' });

    const endpoint = String(req.body?.endpoint || '').trim();
    const label = String(req.body?.label || '').trim();
    const priorityNumber = Number(req.body?.priority);
    const priority = Number.isFinite(priorityNumber) ? priorityNumber : 10;
    const added = [];
    const skipped = [];

    for (const [idx, entry] of entries.entries()) {
      const itemLabel = entries.length > 1
        ? (label ? `${label}#${idx + 1}` : `imported#${idx + 1}`)
        : label;
      try {
        const keyId = pool.addKey(provider, {
          key: entry.key,
          endpoint,
          priority,
          label: itemLabel,
        });
        added.push({ keyId, keyMasked: maskSecret(entry.key) });
      } catch (err) {
        skipped.push({ keyMasked: maskSecret(entry.key), reason: err.message || 'skip' });
      }
    }

    if (!added.length) {
      return res.status(409).json({ error: 'No keys imported', skipped });
    }

    res.json({
      success: true,
      provider,
      addedCount: added.length,
      skippedCount: skipped.length,
      added,
      skipped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pool/:provider/keys/:keyId', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    const provider = normalizeProviderName(req.params.provider);
    const keyId = String(req.params.keyId || '').trim();
    if (!isValidProviderName(provider)) return res.status(400).json({ error: 'Invalid provider' });
    if (!keyId) return res.status(400).json({ error: 'keyId is required' });
    pool.removeKey(provider, keyId);
    res.json({ success: true, provider, keyId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pool/:provider/keys/:keyId', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    const provider = normalizeProviderName(req.params.provider);
    const keyId = String(req.params.keyId || '').trim();
    if (!isValidProviderName(provider)) return res.status(400).json({ error: 'Invalid provider' });
    if (!keyId) return res.status(400).json({ error: 'keyId is required' });

    const endpoint = req.body?.endpoint;
    const label = req.body?.label;
    const priority = req.body?.priority;
    const updates = {};
    if (endpoint !== undefined) updates.endpoint = endpoint;
    if (label !== undefined) updates.label = label;
    if (priority !== undefined) updates.priority = priority;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No mutable fields provided (endpoint|label|priority)' });
    }

    const updated = pool.updateKey(provider, keyId, updates);
    res.json({ success: true, data: updated });
  } catch (err) {
    const status = /priority must/i.test(err.message) || /not found/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Relay Model Config ──

router.get('/model-config', (req, res) => {
  try {
    res.json({ success: true, data: getModelConfigSnapshot() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/model-config', (req, res) => {
  try {
    const baseUrlRaw = String(req.body?.baseUrl || '').trim();
    const modelId = String(req.body?.modelId || '').trim();
    const compatibilityRaw = String(req.body?.compatibility || 'openai');
    const apiKeyInput = req.body?.apiKey;
    const clearApiKey = req.body?.clearApiKey === true;

    if (!baseUrlRaw) return res.status(400).json({ error: 'baseUrl is required' });
    if (!modelId) return res.status(400).json({ error: 'modelId is required' });

    const compatibility = normalizeCompatibility(compatibilityRaw);
    if (!compatibility) {
      return res.status(400).json({ error: 'compatibility must be openai|anthropic|unknown' });
    }

    // apiFormat: explicit value wins; otherwise derive from compatibility for
    // backward compatibility. Empty body field → derived default.
    let apiFormat = deriveApiFormatFromCompat(compatibility);
    if (req.body?.apiFormat !== undefined && req.body?.apiFormat !== '') {
      apiFormat = normalizeApiFormat(req.body.apiFormat);
      if (!apiFormat) {
        return res.status(400).json({ error: 'apiFormat must be openai|anthropic|openai_responses|gemini' });
      }
    }

    let apiKeyField = defaultKeyFieldFor(apiFormat);
    if (req.body?.apiKeyField !== undefined && req.body?.apiKeyField !== '') {
      apiKeyField = normalizeApiKeyField(req.body.apiKeyField);
      if (!apiKeyField) {
        return res.status(400).json({ error: 'apiKeyField must be authorization_bearer|x-api-key|x-goog-api-key' });
      }
    }

    // Base URL: only OpenAI-style formats get the /v1 auto-suffix; anthropic and
    // gemini upstreams keep their origin (the adapter appends /messages etc.).
    let normalizedUrl;
    if (apiFormat === 'openai' || apiFormat === 'openai_responses') {
      normalizedUrl = normalizeOpenAiLikeBaseUrl(baseUrlRaw);
      if (!normalizedUrl.ok) {
        return res.status(400).json({ error: 'baseUrl must be a valid http(s) URL' });
      }
    } else {
      let parsed;
      try { parsed = new URL(baseUrlRaw); } catch { parsed = null; }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        return res.status(400).json({ error: 'baseUrl must be a valid http(s) URL' });
      }
      normalizedUrl = { ok: true, url: baseUrlRaw.replace(/\/+$/, ''), appendedV1: false };
    }

    // Optional candidate endpoints for failover (array or delimited string).
    const endpointsInput = req.body?.endpoints;
    let endpointList = [];
    if (Array.isArray(endpointsInput)) {
      endpointList = endpointsInput.map((s) => String(s || '').trim());
    } else if (typeof endpointsInput === 'string') {
      endpointList = endpointsInput.split(/[\n,;]+/g).map((s) => s.trim());
    }
    endpointList = endpointList
      .filter(Boolean)
      .map((u) => u.replace(/\/+$/, ''))
      .filter((u) => u !== normalizedUrl.url);
    for (const u of endpointList) {
      try {
        const p = new URL(u);
        if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('bad');
      } catch {
        return res.status(400).json({ error: `endpoint is not a valid http(s) URL: ${u}` });
      }
    }
    endpointList = [...new Set(endpointList)];

    const envMap = {
      GATEWAY_PREFERRED_ADAPTER: 'relay_api',
      GATEWAY_PREFERRED_STRICT: 'true',
      GATEWAY_PREFERRED_MODEL: modelId,
      RELAY_API_ENDPOINT: normalizedUrl.url,
      RELAY_API_MODEL: modelId,
      RELAY_API_COMPATIBILITY: compatibility,
      RELAY_API_FORMAT: apiFormat,
      RELAY_API_KEY_FIELD: apiKeyField,
    };
    const unsetKeys = [];
    if (endpointList.length > 0) envMap.RELAY_API_ENDPOINTS = endpointList.join(',');
    else unsetKeys.push('RELAY_API_ENDPOINTS');

    const parsedEntries = parseApiKeyEntries(apiKeyInput);
    const primary = String(extractPrimaryApiKey(apiKeyInput) || (parsedEntries[0] && parsedEntries[0].key) || '').trim();

    if (clearApiKey) {
      unsetKeys.push('RELAY_API_KEY', 'RELAY_API_KEYS');
    } else if (primary) {
      envMap.RELAY_API_KEY = primary;
      if (parsedEntries.length > 1) envMap.RELAY_API_KEYS = parsedEntries.map((entry) => entry.key).join(',');
      else unsetKeys.push('RELAY_API_KEYS');
    }

    let envContent = readEnvContent();
    for (const [key, value] of Object.entries(envMap)) {
      envContent = setEnvLine(envContent, key, value);
      process.env[key] = String(value);
    }
    for (const key of unsetKeys) {
      envContent = removeEnvLine(envContent, key);
      delete process.env[key];
    }

    const tmpPath = `${ENV_PATH}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, envContent, 'utf-8');
    fs.renameSync(tmpPath, ENV_PATH);

    res.json({
      success: true,
      data: {
        updated: true,
        appendedV1: normalizedUrl.appendedV1,
        envPath: ENV_PATH,
        config: getModelConfigSnapshot(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Monitor ──

router.get('/monitor/traces', (req, res) => {
  try {
    const monitor = require('../services/aiMonitor');
    const { limit, offset, provider, success, since } = req.query;
    const filter = {};
    if (limit) filter.limit = parseInt(limit, 10);
    if (offset) filter.offset = parseInt(offset, 10);
    if (provider) filter.provider = provider;
    if (success !== undefined) filter.success = success === 'true';
    if (since) filter.since = since;
    res.json(monitor.getTraces(filter));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitor/stats', (req, res) => {
  try {
    const monitor = require('../services/aiMonitor');
    res.json(monitor.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitor/stream', (req, res) => {
  const monitor = require('../services/aiMonitor');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send keepalive comment every 25s to prevent proxy/browser timeouts
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { /* client gone */ }
  }, 25000);

  const events = monitor.createEventStream();
  const onTrace = (trace) => {
    try {
      res.write(`data: ${JSON.stringify(trace)}\n\n`);
    } catch {
      // Client disconnected or serialization failed — clean up
      cleanup();
    }
  };

  const cleanup = () => {
    clearInterval(keepalive);
    events.removeListener('trace:start', onTrace);
    events.removeListener('trace:end', onTrace);
    events.removeListener('trace:cascade', onTrace);
  };

  events.on('trace:start', onTrace);
  events.on('trace:end', onTrace);
  events.on('trace:cascade', onTrace);

  req.on('close', cleanup);
});

// ── OAuth ──

function normalizeOAuthProvider(raw) {
  return String(raw || '').trim().toLowerCase();
}

function isValidOAuthProvider(provider) {
  return !!provider && /^[a-z0-9._-]{2,40}$/.test(provider);
}

router.get('/oauth/providers', (req, res) => {
  try {
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    const knownProviders = oauth.getKnownProviders ? oauth.getKnownProviders() : {};
    const statusMap = oauth.getAllStatus();
    const keys = Array.from(new Set([
      ...Object.keys(knownProviders),
      ...Object.keys(statusMap),
    ])).sort();

    const providers = keys.map((key) => {
      const known = knownProviders[key] || {};
      const status = statusMap[key] || {};
      return {
        key,
        name: known.name || status.provider || key,
        supportsRefresh: known.supportsRefresh !== undefined ? !!known.supportsRefresh : !!status.supportsRefresh,
        hasTokenEndpoint: !!known.tokenEndpoint,
        hasRevokeEndpoint: !!known.revokeEndpoint,
        registered: !!status.registered,
        valid: !!status.valid,
        expiresIn: Number(status.expiresIn || 0),
        hasRefreshToken: !!status.hasRefreshToken,
        hasClientId: !!status.hasClientId,
        hasClientSecret: !!status.hasClientSecret,
        hasAccessToken: !!status.hasAccessToken,
        clientIdMasked: status.clientIdMasked || '',
        error: status.error || null,
      };
    });

    res.json({ success: true, data: { knownProviders, status: statusMap, providers } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/status', (req, res) => {
  try {
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    res.json(oauth.getAllStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/oauth/credentials/:provider', (req, res) => {
  try {
    const provider = normalizeOAuthProvider(req.params.provider);
    if (!isValidOAuthProvider(provider)) return res.status(400).json({ error: 'Invalid provider' });
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    res.json({ success: true, data: oauth.getTokenStatus(provider) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/oauth/credentials/:provider', (req, res) => {
  try {
    const provider = normalizeOAuthProvider(req.params.provider);
    if (!isValidOAuthProvider(provider)) return res.status(400).json({ error: 'Invalid provider' });

    const body = req.body || {};
    const updates = {};
    const fields = ['clientId', 'clientSecret', 'refreshToken', 'accessToken', 'expiresAt'];
    for (const field of fields) {
      if (body[field] !== undefined) updates[field] = body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No OAuth credential fields provided' });
    }

    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    oauth.registerProvider(provider, updates);
    res.json({ success: true, data: oauth.getTokenStatus(provider) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/oauth/credentials/:provider', async (req, res) => {
  try {
    const provider = normalizeOAuthProvider(req.params.provider);
    if (!isValidOAuthProvider(provider)) return res.status(400).json({ error: 'Invalid provider' });
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    await oauth.revokeToken(provider);
    res.json({ success: true, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/:provider/refresh', async (req, res) => {
  try {
    const provider = normalizeOAuthProvider(req.params.provider);
    if (!isValidOAuthProvider(provider)) return res.status(400).json({ error: 'Invalid provider' });
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    const token = await oauth.refreshToken(provider);
    res.json({ success: !!token, token: token ? '***' : null, status: oauth.getTokenStatus(provider) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Plugins ──

router.get('/plugins', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    res.json(chain.list());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plugins/:name/toggle', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const { enabled } = req.body;
    const success = chain.toggle(req.params.name, enabled !== false);
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plugins/template', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    res.json({ code: chain.getTemplate() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plugins/validate', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    res.json(chain.validateSyntax(code));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plugins/reload', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const count = chain.reload();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plugins/:name/code', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const code = chain.getPluginCode(req.params.name);
    res.json({ code });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

router.post('/plugins', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const { name, code } = req.body;
    if (!name || !code) return res.status(400).json({ error: 'name and code are required' });
    const result = chain.savePlugin(name, code);
    res.status(201).json(result);
  } catch (err) {
    res.status(err.message.includes('Syntax') ? 422 : 500).json({ error: err.message });
  }
});

router.put('/plugins/:name', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    const result = chain.savePlugin(req.params.name, code);
    res.json(result);
  } catch (err) {
    res.status(err.message.includes('Syntax') ? 422 : 500).json({ error: err.message });
  }
});

router.delete('/plugins/:name', (req, res) => {
  try {
    const chain = require('../services/gateway/pluginChain');
    chain.deletePlugin(req.params.name);
    res.json({ success: true });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// ── TLS Sidecar ──

router.get('/tls/status', (req, res) => {
  try {
    const sidecar = require('../services/gateway/tlsSidecar');
    res.json(sidecar.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tls/start', async (req, res) => {
  try {
    const sidecar = require('../services/gateway/tlsSidecar');
    const result = await sidecar.start(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tls/stop', async (req, res) => {
  try {
    const sidecar = require('../services/gateway/tlsSidecar');
    await sidecar.stop();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Protocols ──

router.get('/protocols', (req, res) => {
  try {
    const converter = require('../services/gateway/protocolConverter');
    res.json({ protocols: converter.getSupportedProtocols() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Claude Code Model Slots ──

const MODEL_SLOT_DEFS = Object.freeze({
  default:  'ANTHROPIC_MODEL',
  opus:     'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet:   'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku:    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
});

function shouldWriteClaudeSettings() {
  const raw = String(
    process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS
      || process.env.KHY_MANAGE_CLAUDE_SETTINGS
      || '',
  ).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

const CLAUDE_SETTINGS_PATH = path.join(require('os').homedir(), '.claude', 'settings.json');

function readClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeClaudeSettingsAtomic(obj) {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = CLAUDE_SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, CLAUDE_SETTINGS_PATH);
}

function buildModelSlotsSnapshot() {
  const settings = readClaudeSettings();
  const env = settings.env || {};
  const slots = {};
  for (const [slot, envKey] of Object.entries(MODEL_SLOT_DEFS)) {
    slots[slot] = {
      envKey,
      model: process.env[envKey] || env[envKey] || '',
    };
  }
  return {
    slots,
    baseUrl: process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:9100',
  };
}

router.get('/model-slots', (req, res) => {
  try {
    res.json({ success: true, data: buildModelSlotsSnapshot() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/model-slots', (req, res) => {
  try {
    const body = req.body || {};
    const validSlots = Object.keys(MODEL_SLOT_DEFS);
    const updates = {};
    for (const slot of validSlots) {
      if (body[slot] !== undefined) {
        updates[slot] = String(body[slot]).trim();
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: '至少需要提供一个槽位更新' });
    }

    const canWriteClaudeSettings = shouldWriteClaudeSettings();

    // 1) 更新 ~/.claude/settings.json (explicit opt-in only)
    const settings = readClaudeSettings();
    if (!settings.env || typeof settings.env !== 'object') settings.env = {};
    for (const [slot, model] of Object.entries(updates)) {
      const envKey = MODEL_SLOT_DEFS[slot];
      if (canWriteClaudeSettings) settings.env[envKey] = model;
    }
    if (canWriteClaudeSettings) writeClaudeSettingsAtomic(settings);

    // 2) 更新 .env + process.env
    let envContent = readEnvContent();
    for (const [slot, model] of Object.entries(updates)) {
      const envKey = MODEL_SLOT_DEFS[slot];
      envContent = setEnvLine(envContent, envKey, model);
      process.env[envKey] = model;
    }
    const tmpEnv = ENV_PATH + '.tmp';
    fs.writeFileSync(tmpEnv, envContent, 'utf-8');
    fs.renameSync(tmpEnv, ENV_PATH);

    res.json({
      success: true,
      data: buildModelSlotsSnapshot(),
      meta: {
        claudeSettingsWriteEnabled: canWriteClaudeSettings,
        wroteClaudeSettings: canWriteClaudeSettings,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Concurrency Slots ──

router.get('/slots', (req, res) => {
  try {
    const slots = require('../services/concurrencySlots');
    res.json(slots.getAllStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account Pool (Antigravity-style) ──

const VALID_PROVIDERS = [
  'deepseek', 'openai', 'anthropic', 'qwen', 'alibaba', 'dashscope', 'huggingface',
  'glm', 'doubao', 'wenxin', 'relay',
  'trae', 'warp', 'cursor', 'kiro', 'windsurf', 'claude', 'codex', 'api', 'ollama',
];
const VALID_TIERS = ['FREE', 'PRO', 'ULTRA'];

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

function normalizeProviderName(raw) {
  const provider = String(raw || '').trim().toLowerCase();
  if (!provider) return '';
  return PROVIDER_ALIAS_MAP[provider] || provider;
}

function isValidProviderName(provider) {
  return !!provider && (VALID_PROVIDERS.includes(provider) || /^[a-z0-9._-]{2,40}$/.test(provider));
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  const normalized = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

router.get('/accounts', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    res.json(pool.getAllAccounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const { apiKey, endpoint, tier, label, email, priority } = req.body;
    const provider = normalizeProviderName(req.body?.provider);
    if (!provider || !apiKey) return res.status(400).json({ error: 'provider and apiKey are required' });
    if (!isValidProviderName(provider)) {
      return res.status(400).json({
        error: `Invalid provider. Use lowercase letters/numbers/_/.- (2-40 chars), or one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }
    if (tier && !VALID_TIERS.includes(tier)) {
      return res.status(400).json({ error: `Invalid tier. Valid: ${VALID_TIERS.join(', ')}` });
    }
    if (endpoint && typeof endpoint === 'string' && endpoint.length > 0) {
      try { new URL(endpoint); } catch { return res.status(400).json({ error: 'Invalid endpoint URL' }); }
    }
    if (priority !== undefined) {
      const p = Number(priority);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'priority must be a number between 0 and 100' });
      }
    }
    const account = await pool.addAccount({ provider, apiKey, endpoint, tier, label, email, priority });
    res.status(201).json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid account ID' });
    // Validate fields if present
    if (req.body.tier && !VALID_TIERS.includes(req.body.tier)) {
      return res.status(400).json({ error: `Invalid tier. Valid: ${VALID_TIERS.join(', ')}` });
    }
    if (req.body.priority !== undefined) {
      const p = Number(req.body.priority);
      if (!Number.isFinite(p) || p < 0 || p > 100) {
        return res.status(400).json({ error: 'priority must be a number between 0 and 100' });
      }
    }
    const result = await pool.updateAccount(id, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid account ID' });
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.removeAccount(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Batch delete: { ids: [..] } removes the listed accounts; { all: true, provider? }
// clears every account (optionally scoped to one provider). Used by the account
// pool bulk-management toolbar.
router.post('/accounts/batch-delete', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const body = req.body || {};
    if (body.all === true) {
      const provider = String(body.provider || '').trim();
      const result = await pool.removeAllAccounts(provider || undefined);
      return res.json({ success: true, ...result });
    }
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array (or pass all:true)' });
    }
    const result = await pool.removeAccounts(ids);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/enable', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid account ID' });
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.enableAccount(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/disable', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid account ID' });
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.disableAccount(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/accounts/scheduling', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    res.json(pool.getSchedulingConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/accounts/scheduling', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    pool.setSchedulingConfig(req.body);
    res.json({ success: true, ...pool.getSchedulingConfig() });
  } catch (err) {
    const status = err.message.includes('Invalid') || err.message.includes('must be') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/accounts/circuit-breaker', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    res.json(pool.getCircuitBreakerConfig());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/accounts/circuit-breaker', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    pool.setCircuitBreakerConfig(req.body);
    res.json({ success: true, ...pool.getCircuitBreakerConfig() });
  } catch (err) {
    const status = err.message.includes('must be') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── AI Assets & Customers ──

router.get('/assets/overview', async (req, res) => {
  try {
    const data = await assetCustomerService.getAssetOverview();
    // Inject proxy runtime info
    const proxyServer = require('../services/gateway/proxyServer');
    const host = process.env.PROXY_HOST || '127.0.0.1';
    const httpPort = proxyServer.getPort();
    const httpsPort = proxyServer.getHttpsPort();
    const httpsRunning = proxyServer.isHttpsRunning();
    data.assets = data.assets || {};
    data.assets.proxy = {
      ...(data.assets.proxy || {}),
      runtime: {
        http: { enabled: proxyServer.isRunning(), url: `http://${host}:${httpPort}` },
        https: { enabled: httpsRunning, url: httpsRunning ? `https://${host}:${httpsPort}` : '' },
      },
    };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customers', (req, res) => {
  try {
    const includeSecrets = parseBool(req.query.includeSecrets, false);
    const model = String(req.query.model || '').trim();
    const rows = assetCustomerService.listCustomers({ includeSecrets, model });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/customers', (req, res) => {
  try {
    const created = assetCustomerService.createCustomer(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    const status = err.message.includes('required') || err.message.includes('empty') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.put('/customers/:id', (req, res) => {
  try {
    const updated = assetCustomerService.updateCustomer(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('not found') || err.message.includes('required') || err.message.includes('empty') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/enable', (req, res) => {
  try {
    const updated = assetCustomerService.setCustomerEnabled(req.params.id, true);
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/disable', (req, res) => {
  try {
    const updated = assetCustomerService.setCustomerEnabled(req.params.id, false);
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/tokens', (req, res) => {
  try {
    const token = assetCustomerService.issueToken(req.params.id, req.body || {});
    res.status(201).json(token);
  } catch (err) {
    const status = err.message.includes('not found')
      || err.message.includes('already exists')
      || err.message.includes('only supports count=1')
      ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/tokens/:tokenId/rotate', (req, res) => {
  try {
    const rotated = assetCustomerService.rotateToken(req.params.id, req.params.tokenId, req.body?.token || '');
    res.json(rotated);
  } catch (err) {
    const status = err.message.includes('not found') || err.message.includes('already exists') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/tokens/:tokenId/enable', (req, res) => {
  try {
    const updated = assetCustomerService.setTokenEnabled(req.params.id, req.params.tokenId, true);
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/customers/:id/tokens/:tokenId/disable', (req, res) => {
  try {
    const updated = assetCustomerService.setTokenEnabled(req.params.id, req.params.tokenId, false);
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.delete('/customers/:id/tokens/:tokenId', (req, res) => {
  try {
    const removed = assetCustomerService.deleteToken(req.params.id, req.params.tokenId);
    res.json({ success: true, removed });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Usage / Billing / Pricing (data-plane metering) ───────────────────
router.get('/usage/logs', (req, res) => {
  try {
    const requestLog = require('../services/requestLogService');
    const result = requestLog.query({
      customerId: req.query.customerId ? String(req.query.customerId) : undefined,
      tokenId: req.query.tokenId ? String(req.query.tokenId) : undefined,
      group: req.query.group ? String(req.query.group) : undefined,
      model: req.query.model ? String(req.query.model) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage/summary', (req, res) => {
  try {
    const requestLog = require('../services/requestLogService');
    const result = requestLog.summary({
      groupBy: req.query.groupBy ? String(req.query.groupBy) : 'model',
      from: req.query.from ? String(req.query.from) : undefined,
      to: req.query.to ? String(req.query.to) : undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage/customers/:id', (req, res) => {
  try {
    const usage = require('../services/customerUsageService');
    const month = req.query.month ? String(req.query.month) : undefined;
    const data = usage.getMonthUsage(req.params.id, month);
    res.json({ customerId: req.params.id, month: month || usage.monthKey(), usage: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pricing', (req, res) => {
  try {
    const pricing = require('../services/pricingService');
    res.json(pricing.getState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pricing', (req, res) => {
  try {
    const pricing = require('../services/pricingService');
    const updated = pricing.updatePricing(req.body || {});
    res.json(updated);
  } catch (err) {
    const status = err.message.includes('invalid') || err.message.includes('required') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/groups', (req, res) => {
  try {
    const pricing = require('../services/pricingService');
    const state = pricing.getState();
    res.json({ groups: state.groups || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/groups', (req, res) => {
  try {
    const pricing = require('../services/pricingService');
    const groups = req.body && req.body.groups ? req.body.groups : req.body;
    const updated = pricing.updatePricing({ groups: groups || {} });
    res.json({ groups: updated.groups });
  } catch (err) {
    const status = err.message.includes('invalid') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/rate-limits', (req, res) => {
  try {
    const rateLimiter = require('../services/gateway/rateLimiter');
    res.json({ buckets: rateLimiter.snapshot() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Credential Watcher (proxy to backend service) ─────────────────────
router.get('/credential-watcher/status', async (req, res) => {
  try {
    const backendPort = process.env.BACKEND_PORT || 3000;
    const resp = await fetch(`http://127.0.0.1:${backendPort}/api/ai-gateway-admin/credential-watcher/status`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Backend unreachable: ${err.message}` });
  }
});

router.post('/credential-watcher/scan', async (req, res) => {
  try {
    const backendPort = process.env.BACKEND_PORT || 3000;
    const resp = await fetch(`http://127.0.0.1:${backendPort}/api/ai-gateway-admin/credential-watcher/scan`, { method: 'POST' });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Backend unreachable: ${err.message}` });
  }
});

router.post('/credential-watcher/start', async (req, res) => {
  try {
    const backendPort = process.env.BACKEND_PORT || 3000;
    const resp = await fetch(`http://127.0.0.1:${backendPort}/api/ai-gateway-admin/credential-watcher/start`, { method: 'POST' });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Backend unreachable: ${err.message}` });
  }
});

router.post('/credential-watcher/stop', async (req, res) => {
  try {
    const backendPort = process.env.BACKEND_PORT || 3000;
    const resp = await fetch(`http://127.0.0.1:${backendPort}/api/ai-gateway-admin/credential-watcher/stop`, { method: 'POST' });
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Backend unreachable: ${err.message}` });
  }
});

// ── Model Catalog ──

router.get('/models', async (req, res) => {
  try {
    const gateway = require('../services/gateway/aiGateway');
    if (!gateway._initialized) await gateway.init();
    const statuses = gateway.getStatus();
    const models = [];
    for (const adapter of statuses) {
      if (!adapter.available) continue;
      try {
        const adapterModels = await gateway.listModels(adapter.key || adapter.name);
        for (const m of adapterModels) {
          models.push({
            id: typeof m === 'string' ? m : m.id || m.name,
            adapter: adapter.name || adapter.key,
            ...(typeof m === 'object' ? m : {}),
          });
        }
      } catch { /* adapter may not support listModels */ }
    }
    res.json({ success: true, data: models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
