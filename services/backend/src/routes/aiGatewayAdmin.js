/**
 * AI Gateway Admin REST API + SSE endpoints.
 *
 * Mounted at /api/ai-gateway-admin in the main Express app.
 *
 * Endpoints:
 *   GET  /status              — Full gateway status
 *   GET  /pool                — API key pool status per provider
 *   POST /pool/:provider/keys — Add a key
 *   DELETE /pool/:provider/keys/:keyId — Remove a key
 *   GET  /model-config        — Relay model config snapshot
 *   PUT  /model-config        — Update relay model config
 *   GET  /monitor/traces      — Query traces
 *   GET  /monitor/stats       — Aggregated stats
 *   GET  /monitor/stream      — SSE real-time trace stream
 *   GET  /oauth/status        — OAuth token status
 *   POST /oauth/:provider/refresh — Force refresh
 *   GET  /plugins             — List gateway plugins
 *   POST /plugins/:name/toggle — Enable/disable plugin
 *   GET  /tls/status          — TLS sidecar status
 *   POST /tls/start           — Start sidecar
 *   POST /tls/stop            — Stop sidecar
 *   GET  /protocols           — Supported protocols
 *   GET  /slots               — Concurrency slot status
 *   GET  /health              — Channel health snapshot (Redis-backed)
 *   GET  /health/stream       — SSE real-time channel health updates
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { parseApiKeyEntries, extractPrimaryApiKey } = require('../services/apiKeyFormat');
const { resolveAnthropicBaseUrl } = require('../utils/proxyBaseUrl');
const router = express.Router();

// All routes require admin authentication
router.use(authenticateToken, requireAdmin);

const resolveEnvPathsForGateway = require('../utils/resolveGatewayEnvPaths');

const patchEnvContent = require('../utils/patchEnvContent');

function writeGatewayEnvPatch(envMap = {}, unsetKeys = []) {
  const { canonicalPath, targets } = resolveEnvPathsForGateway();
  for (const filePath of targets) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { /* no .env yet */ }
    const patched = patchEnvContent(content, envMap, unsetKeys);
    fs.writeFileSync(filePath, patched, 'utf-8');
  }
  for (const [key, value] of Object.entries(envMap)) process.env[key] = String(value);
  for (const key of unsetKeys) delete process.env[key];
  return canonicalPath;
}

// 收敛到 utils/normalizeCompatibility 单一真源(逐字节委托,调用点不变)
const normalizeCompatibility = require('../utils/normalizeCompatibility');

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

// 收敛到 utils/maskSecret 单一真源(逐字节委托,调用点不变)
const maskSecret = require('../utils/maskSecret');

function getModelConfigSnapshot() {
  const baseUrl = String(process.env.RELAY_API_ENDPOINT || '').trim();
  const modelId = String(process.env.RELAY_API_MODEL || '').trim();
  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const preferredModel = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  const compatibility = normalizeCompatibility(process.env.RELAY_API_COMPATIBILITY || 'openai') || 'openai';
  const apiKey = extractPrimaryApiKey(process.env.RELAY_API_KEY || '');
  return {
    baseUrl,
    modelId,
    compatibility,
    preferredAdapter,
    preferredModel,
    hasApiKey: !!apiKey,
    apiKeyMasked: apiKey ? maskSecret(apiKey) : '',
  };
}

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
    const { key, endpoint, priority, label } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    pool.addKey(req.params.provider, { key, endpoint, priority: priority || 10, label: label || '' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pool/:provider/keys/:keyId', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    pool.removeKey(req.params.provider, req.params.keyId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pool/:provider/keys/:keyId', (req, res) => {
  try {
    const pool = require('../services/apiKeyPool');
    pool.init();
    const entries = pool.getPoolStatus(req.params.provider) || [];
    const entry = entries.find(e => e.id === req.params.keyId || e.keyId === req.params.keyId);
    if (!entry) return res.status(404).json({ error: `Key ${req.params.keyId} not found` });
    if (req.body.endpoint !== undefined) entry.endpoint = String(req.body.endpoint || '').trim();
    if (req.body.label !== undefined) entry.label = String(req.body.label || '').trim();
    if (req.body.priority !== undefined) entry.priority = Number(req.body.priority) || 0;
    pool.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    const normalizedUrl = normalizeOpenAiLikeBaseUrl(baseUrlRaw);
    if (!normalizedUrl.ok) {
      return res.status(400).json({ error: 'baseUrl must be a valid http(s) URL' });
    }
    const compatibility = normalizeCompatibility(compatibilityRaw);
    if (!compatibility) {
      return res.status(400).json({ error: 'compatibility must be openai|anthropic|unknown' });
    }

    const envMap = {
      GATEWAY_PREFERRED_ADAPTER: 'relay_api',
      GATEWAY_PREFERRED_STRICT: 'true',
      GATEWAY_PREFERRED_MODEL: modelId,
      RELAY_API_ENDPOINT: normalizedUrl.url,
      RELAY_API_MODEL: modelId,
      RELAY_API_COMPATIBILITY: compatibility,
    };
    const unsetKeys = [];
    const parsedEntries = parseApiKeyEntries(apiKeyInput);
    const primaryKey = extractPrimaryApiKey(apiKeyInput);
    const primary = String(primaryKey || (parsedEntries[0] && parsedEntries[0].key) || '').trim();

    if (clearApiKey) {
      unsetKeys.push('RELAY_API_KEY', 'RELAY_API_KEYS');
    } else if (primary) {
      envMap.RELAY_API_KEY = primary;
      if (parsedEntries.length > 1) envMap.RELAY_API_KEYS = parsedEntries.map((entry) => entry.key).join(',');
      else unsetKeys.push('RELAY_API_KEYS');
    }

    const envPath = writeGatewayEnvPatch(envMap, unsetKeys);
    res.json({
      success: true,
      data: {
        updated: true,
        appendedV1: normalizedUrl.appendedV1,
        envPath,
        config: getModelConfigSnapshot(),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Codex upstream provider config ──
// Parity with the live aiManagementServer.js handlers: configure the codex CLI
// upstream (any OpenAI-compatible provider) by writing ~/.codex/config.toml +
// auth.json through the codex adapter.

router.get('/codex-config', (req, res) => {
  try {
    const codex = require('../services/gateway/adapters/codexAdapter');
    const snapshot = typeof codex.getCodexUpstreamSnapshot === 'function' ? codex.getCodexUpstreamSnapshot() : {};
    const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
    res.json({ success: true, data: { ...snapshot, active: preferredAdapter.toLowerCase() === 'codex', preferredAdapter } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/codex-config', (req, res) => {
  try {
    const providerName = String(req.body?.providerName || '').trim();
    const baseUrl = String(req.body?.baseUrl || '').trim();
    const model = String(req.body?.model || '').trim();
    if (!providerName) return res.status(400).json({ error: 'providerName is required' });
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl is required' });
    if (!model) return res.status(400).json({ error: 'model is required' });

    const codex = require('../services/gateway/adapters/codexAdapter');
    if (typeof codex.setCodexUpstream !== 'function') {
      return res.status(500).json({ error: 'codex adapter does not support upstream configuration' });
    }
    const apiKeyInput = String(req.body?.apiKey || '').trim();
    const written = codex.setCodexUpstream({
      providerName,
      baseUrl,
      model,
      reasoningEffort: req.body?.reasoningEffort,
      wireApi: req.body?.wireApi,
      ...(apiKeyInput ? { apiKey: apiKeyInput } : {}),
    });

    let activated = false;
    if (req.body?.activate === true) {
      writeGatewayEnvPatch({ GATEWAY_PREFERRED_ADAPTER: 'codex', GATEWAY_PREFERRED_MODEL: model }, []);
      activated = true;
    }

    const snapshot = typeof codex.getCodexUpstreamSnapshot === 'function' ? codex.getCodexUpstreamSnapshot() : {};
    res.json({
      success: true,
      data: {
        updated: true,
        activated,
        written: { provider: written.provider, baseUrl: written.baseUrl, model: written.model, wireApi: written.wireApi, configPath: written.configPath },
        config: { ...snapshot, active: String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase() === 'codex' },
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

  const events = monitor.createEventStream();
  const onTrace = (trace) => {
    res.write(`data: ${JSON.stringify(trace)}\n\n`);
  };

  events.on('trace:start', onTrace);
  events.on('trace:end', onTrace);
  events.on('trace:cascade', onTrace);

  req.on('close', () => {
    events.removeListener('trace:start', onTrace);
    events.removeListener('trace:end', onTrace);
    events.removeListener('trace:cascade', onTrace);
  });
});

// ── OAuth ──

router.get('/oauth/status', (req, res) => {
  try {
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    res.json(oauth.getAllStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/oauth/:provider/refresh', async (req, res) => {
  try {
    const oauth = require('../services/gateway/oauthManager');
    oauth.init();
    const token = await oauth.refreshToken(req.params.provider);
    res.json({ success: !!token, token: token ? '***' : null });
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
  default: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
});

function shouldWriteClaudeSettings() {
  // 布尔解析走 parseBoolean 单一真源（base tier）。与 aiManagementGatewayAdmin
  // 的同名孪生此前各自内联同一套 token，收敛后两处共用单一解析语义。
  const _parseBoolean = require('../utils/parseBoolean');
  return _parseBoolean(
    process.env.KHY_ALLOW_WRITE_CLAUDE_SETTINGS
      || process.env.KHY_MANAGE_CLAUDE_SETTINGS,
    false,
    { extended: false },
  );
}

router.get('/model-slots', (req, res) => {
  try {
    const os = require('os');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    const env = settings.env || {};
    const slots = {};
    for (const [slot, envKey] of Object.entries(MODEL_SLOT_DEFS)) {
      slots[slot] = { envKey, model: process.env[envKey] || env[envKey] || '' };
    }
    res.json({
      success: true,
      data: { slots, baseUrl: resolveAnthropicBaseUrl({ settingsEnv: env }) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/model-slots', (req, res) => {
  try {
    const os = require('os');
    const updates = {};
    for (const slot of Object.keys(MODEL_SLOT_DEFS)) {
      if (req.body[slot] !== undefined) updates[slot] = String(req.body[slot]).trim();
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '至少需要提供一个槽位更新' });
    const canWriteClaudeSettings = shouldWriteClaudeSettings();
    // 1) ~/.claude/settings.json (explicit opt-in only)
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { settings = {}; }
    if (!settings.env || typeof settings.env !== 'object') settings.env = {};
    const envMap = {};
    for (const [slot, model] of Object.entries(updates)) {
      const envKey = MODEL_SLOT_DEFS[slot];
      envMap[envKey] = model;
      if (canWriteClaudeSettings) settings.env[envKey] = model;
    }
    if (canWriteClaudeSettings) {
      const dir = path.dirname(settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = settingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, settingsPath);
    }
    // 2) .env + process.env
    writeGatewayEnvPatch(envMap);
    // 3) 返回新快照
    const slots = {};
    for (const [slot, envKey] of Object.entries(MODEL_SLOT_DEFS)) {
      slots[slot] = { envKey, model: process.env[envKey] || settings.env[envKey] || '' };
    }
    res.json({
      success: true,
      data: { slots, baseUrl: resolveAnthropicBaseUrl({ settingsEnv: settings.env || {} }) },
      meta: {
        claudeSettingsWriteEnabled: canWriteClaudeSettings,
        wroteClaudeSettings: canWriteClaudeSettings,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// ── Channel Health (Redis-backed) ──

router.get('/health', async (req, res) => {
  try {
    const gateway = require('../services/gateway/aiGateway');
    if (!gateway._initialized) await gateway.init();
    const broadcaster = gateway._healthBroadcaster;
    if (!broadcaster) return res.json({ adapters: [], activity: [], timestamp: Date.now() });
    const snapshot = await broadcaster.getSnapshot();
    snapshot.activity = broadcaster.getRecentActivity();
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/health/stream', async (req, res) => {
  // SSE endpoint for real-time channel health updates
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  try {
    const gateway = require('../services/gateway/aiGateway');
    if (!gateway._initialized) await gateway.init();
    const broadcaster = gateway._healthBroadcaster;

    if (!broadcaster) {
      send('error', { message: 'Health broadcaster not available' });
      return res.end();
    }

    // Send initial snapshot
    const snapshot = await broadcaster.getSnapshot();
    send('channel_health', snapshot);

    // Subscribe to health changes
    const onHealth = (snap) => send('channel_health', snap);
    broadcaster.onHealthChange(onHealth);

    // Keep-alive heartbeat
    const hb = setInterval(() => send('heartbeat', { ts: Date.now() }), 15000);
    if (hb.unref) hb.unref();

    req.on('close', () => {
      clearInterval(hb);
      // Remove listener (best effort — array filter)
      const idx = broadcaster._listeners.indexOf(onHealth);
      if (idx >= 0) broadcaster._listeners.splice(idx, 1);
    });
  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// ─── Credential Watcher ────────────────────────────────────────────────
router.get('/credential-watcher/status', (req, res) => {
  try {
    const watcher = require('../services/credentialWatcherService');
    res.json(watcher.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/credential-watcher/scan', async (req, res) => {
  try {
    const watcher = require('../services/credentialWatcherService');
    const results = await watcher.triggerScanNow();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/credential-watcher/start', async (req, res) => {
  try {
    const watcher = require('../services/credentialWatcherService');
    await watcher.start();
    res.json({ ok: true, status: watcher.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/credential-watcher/stop', (req, res) => {
  try {
    const watcher = require('../services/credentialWatcherService');
    watcher.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Dashboard ────────────────────────────────────────────────────

router.get('/agents/dashboard', async (_req, res) => {
  try {
    const { getAgentDashboard } = require('../coordinator/workerAgent');
    const dashboard = getAgentDashboard();
    res.json(dashboard);
  } catch (err) {
    res.json({ agents: [], tree: [], stats: { total: 0, running: 0, completed: 0, failed: 0, maxDepth: 0 }, error: err.message });
  }
});

// ── Capability Registry endpoints ──────────────────────────────────────

router.get('/capabilities', (_req, res) => {
  try {
    const { getCapabilityRegistry } = require('../services/gateway/capabilityRegistry');
    const registry = getCapabilityRegistry();
    res.json({
      matrix: registry.getMatrix(),
      taskRequirements: registry.getTaskRequirements(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/capabilities/match', (req, res) => {
  try {
    const { getCapabilityRegistry } = require('../services/gateway/capabilityRegistry');
    const registry = getCapabilityRegistry();
    let requirements;
    try {
      requirements = JSON.parse(String(req.query.requirements || '{}'));
    } catch { return res.status(400).json({ error: 'Invalid requirements JSON' }); }
    const ranked = registry.bestAdaptersFor(requirements, { onlyAvailable: false, limit: 10 });
    res.json({ requirements, ranked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Account Pool ──────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const provider = String(req.query.provider || '').trim();
    const accounts = await pool.getAllAccounts(provider || undefined);
    res.json({ success: true, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:provider/use/:id', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const result = await pool.useAccount(req.params.provider, req.params.id);
    res.json({ success: true, account: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:provider/import', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    const result = await pool.importProviderTokens(req.params.provider);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.removeAccount(Number(req.params.id));
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
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.enableAccount(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/disable', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.disableAccount(Number(req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accounts/:id/unban', async (req, res) => {
  try {
    const pool = require('../services/accountPool');
    await pool.init();
    await pool.updateAccount(Number(req.params.id), { status: 'available' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
