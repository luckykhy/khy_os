/**
 * Reverse Proxy Server — unified OpenAI-compatible API endpoint
 * that routes requests to gateway adapters (IDE + local + relay/API).
 *
 * Endpoints:
 *   POST /v1/chat/completions  — OpenAI-compatible chat (stream/non-stream)
 *   POST /v1/messages          — Anthropic-compatible messages
 *   GET  /v1/models            — Aggregated model list from public adapters
 *   GET  /health               — Health check
 *   GET  /reservoir/stats      — Reservoir cache statistics
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const parseBoolean = require('../../utils/parseBoolean');
const protocolConverter = require('./protocolConverter');
const responseSessionStore = require('./responseSessionStore');
const modelRouter = require('./modelRouter');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');
const webSearchInterceptor = require('./webSearchInterceptor');
const { encodeWindsurfModelConfigResponse } = require('./windsurfProtobuf');
const { PROTOCOLS } = protocolConverter;

let _server = null;
let _httpServer = null;
let _httpsServer = null;
let _runtime = null;
let _gateway = null;
let _memoryAuthToken = '';
let _memoryManagedTokens = [];
let _runtimeStartedAt = 0;

const KHY_DIR = getDataHome();
const LEGACY_KHY_DIR = getLegacyDataHome();
const PROXY_AUTH_FILE = path.join(KHY_DIR, 'proxy_server_auth.json');
const LEGACY_PROXY_AUTH_FILE = path.join(LEGACY_KHY_DIR, 'proxy_server_auth.json');
const PROXY_RUNTIME_FILE = path.join(KHY_DIR, 'proxy_server_runtime.json');
const LEGACY_PROXY_RUNTIME_FILE = path.join(LEGACY_KHY_DIR, 'proxy_server_runtime.json');
const PORT_RETRY_LIMIT = 10;

function getGateway() {
  if (!_gateway) _gateway = require('./aiGateway');
  return _gateway;
}

let _expandModelService;
function getExpandModelService() {
  if (!_expandModelService) _expandModelService = require('../expandModelService');
  return _expandModelService;
}

const PUBLIC_ADAPTERS = [
  'kiro',
  'cursor',
  'claude',
  'codex',
  'trae',
  'warp',
  'windsurf',
  'vscode',
  'localLLM',
  'ollama',
  'cursor2api',
  'relay_api',
  'api',
];
const ADAPTER_KEY_TO_PREFIX = modelRouter.DEFAULT_ADAPTER_TO_PREFIX;
const WINDSURF_MODEL_CONFIG_PATHS = new Set([
  '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigs',
  '/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs',
]);
const WINDSURF_PROXY_DEFAULT_MODELS = [
  'gpt-4o',
  'claude-3.5-sonnet',
  'windsurf-cascade',
];

const LOW_TIER_MODEL_PATTERN = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;
const _reservoir = new Map();

function parseList(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// 收敛到 utils/mkdirpSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../../utils/mkdirpSync');

function mergeAbortSignals(...signals) {
  const activeSignals = signals.filter(signal => signal && typeof signal.addEventListener === 'function');
  if (activeSignals.length === 0) return null;
  if (activeSignals.length === 1) return activeSignals[0];

  const merged = new AbortController();
  const cleanup = [];
  const forwardAbort = (source) => {
    if (merged.signal.aborted) return;
    const reason = source && 'reason' in source ? source.reason : undefined;
    try { merged.abort(reason); } catch { merged.abort(); }
    while (cleanup.length > 0) {
      const detach = cleanup.pop();
      try { detach(); } catch { /* ignore */ }
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      forwardAbort(signal);
      break;
    }
    const onAbort = () => forwardAbort(signal);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', onAbort));
  }

  return merged.signal;
}

/**
 * Repair unpaired tool_use/tool_result blocks in a messages array.
 * Degrades assistant tool_use blocks that lack matching tool_result
 * in the next user message to plain text, preventing Bedrock API errors.
 */
function _repairToolUsePairing(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const repaired = messages.map(m => ({ ...m }));
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolUseIds = new Set();
    for (const block of msg.content) {
      if (block && block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
    }
    if (toolUseIds.size === 0) continue;
    const next = repaired[i + 1];
    const resultIds = new Set();
    if (next && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block && block.type === 'tool_result' && block.tool_use_id) resultIds.add(block.tool_use_id);
      }
    }
    let allMatched = true;
    for (const id of toolUseIds) { if (!resultIds.has(id)) { allMatched = false; break; } }
    if (!allMatched) {
      const textParts = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) textParts.push(block.text);
        else if (block.type === 'tool_use') {
          const inputStr = block.input ? JSON.stringify(block.input).slice(0, 200) : '';
          textParts.push(`[Called tool: ${block.name || 'unknown'}${inputStr ? ` with ${inputStr}` : ''}]`);
        }
      }
      repaired[i] = { ...msg, content: textParts.join('\n') || '[assistant response]' };
      if (next && Array.isArray(next.content)) {
        const filtered = next.content.filter(b => b.type !== 'tool_result' || !toolUseIds.has(b.tool_use_id));
        if (filtered.length === 0) repaired[i + 1] = { ...next, content: '[tool results unavailable]' };
        else if (filtered.length !== next.content.length) repaired[i + 1] = { ...next, content: filtered };
      }
    }
  }
  return repaired;
}

function shouldExposeRawRelayModels() {
  return parseBoolean(process.env.PROXY_EXPOSE_RAW_RELAY_MODELS, true);
}

function toPort(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function loadTlsCredentials(options = {}) {
  const certPem = String(options.tlsCertPem ?? process.env.PROXY_TLS_CERT_PEM ?? '').trim();
  const keyPem = String(options.tlsKeyPem ?? process.env.PROXY_TLS_KEY_PEM ?? '').trim();
  if (certPem && keyPem) {
    return {
      cert: certPem,
      key: keyPem,
      source: 'env-pem',
      certFile: '',
      keyFile: '',
    };
  }

  const certFile = String(options.tlsCertFile ?? process.env.PROXY_TLS_CERT_FILE ?? '').trim();
  const keyFile = String(options.tlsKeyFile ?? process.env.PROXY_TLS_KEY_FILE ?? '').trim();
  if (certFile || keyFile) {
    if (!certFile || !keyFile) {
      throw new Error('HTTPS 需要同时提供证书与私钥：PROXY_TLS_CERT_FILE + PROXY_TLS_KEY_FILE');
    }
    if (!fs.existsSync(certFile)) {
      throw new Error(`HTTPS 证书文件不存在: ${certFile}`);
    }
    if (!fs.existsSync(keyFile)) {
      throw new Error(`HTTPS 私钥文件不存在: ${keyFile}`);
    }
    return {
      cert: fs.readFileSync(certFile, 'utf8'),
      key: fs.readFileSync(keyFile, 'utf8'),
      source: 'file',
      certFile,
      keyFile,
    };
  }

  return null;
}

function buildRuntimeStatus(config = {}, authToken = '') {
  const host = config.host || '127.0.0.1';
  const httpInfo = config.http?.enabled
    ? {
      enabled: true,
      port: config.http.port,
      host,
      url: `http://${host}:${config.http.port}`,
    }
    : { enabled: false, port: null, host, url: '' };
  const httpsInfo = config.https?.enabled
    ? {
      enabled: true,
      port: config.https.port,
      host,
      url: `https://${host}:${config.https.port}`,
      certSource: config.https.certSource || '',
      certFile: config.https.certFile || '',
      keyFile: config.https.keyFile || '',
    }
    : { enabled: false, port: null, host, url: '', certSource: '', certFile: '', keyFile: '' };
  const mode = httpInfo.enabled && httpsInfo.enabled
    ? 'dual'
    : (httpsInfo.enabled ? 'https-only' : 'http-only');
  return {
    mode,
    host,
    http: httpInfo,
    https: httpsInfo,
    authTokenMasked: maskToken(authToken),
  };
}

function writeRuntimeStatus(runtime) {
  const payload = {
    pid: process.pid,
    host: runtime?.host || '127.0.0.1',
    port: runtime?.http?.enabled && Number.isFinite(runtime.http.port)
      ? runtime.http.port
      : runtime?.https?.port || null,
    httpPort: runtime?.http?.enabled ? runtime.http.port : null,
    httpsPort: runtime?.https?.enabled ? runtime.https.port : null,
    httpsEnabled: runtime?.https?.enabled === true,
    httpsOnly: runtime?.https?.enabled === true && runtime?.http?.enabled !== true,
    mode: runtime?.mode || 'http-only',
    startedAt: _runtimeStartedAt || Date.now(),
    updatedAt: Date.now(),
  };
  const serialized = JSON.stringify(payload, null, 2);
  for (const filePath of [PROXY_RUNTIME_FILE, LEGACY_PROXY_RUNTIME_FILE]) {
    try {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, serialized, 'utf-8');
    } catch { /* best effort */ }
  }
}

function clearRuntimeStatus() {
  for (const filePath of [PROXY_RUNTIME_FILE, LEGACY_PROXY_RUNTIME_FILE]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* best effort */ }
  }
}

function cloneStartConfig(config = {}) {
  return {
    host: config.host || '127.0.0.1',
    http: {
      enabled: config.http?.enabled === true,
      port: config.http?.enabled ? config.http.port : null,
    },
    https: {
      enabled: config.https?.enabled === true,
      port: config.https?.enabled ? config.https.port : null,
      cert: config.https?.cert || '',
      key: config.https?.key || '',
      certSource: config.https?.certSource || '',
      certFile: config.https?.certFile || '',
      keyFile: config.https?.keyFile || '',
    },
  };
}

function bumpStartConfigPorts(config = {}, step = 1) {
  const next = cloneStartConfig(config);
  if (next.http.enabled && Number.isFinite(next.http.port)) {
    next.http.port = Math.min(next.http.port + step, 65535);
  }
  if (next.https.enabled && Number.isFinite(next.https.port)) {
    next.https.port = Math.min(next.https.port + step, 65535);
  }
  return next;
}

function resolveStartConfig(portOrOptions = null) {
  const options = (portOrOptions && typeof portOrOptions === 'object')
    ? { ...portOrOptions }
    : { port: portOrOptions };

  const host = String(options.host || process.env.PROXY_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const basePort = toPort(options.port, toPort(process.env.PROXY_PORT, 9100)) || 9100;

  const httpsOnly = parseBoolean(
    options.httpsOnly ?? options.https_only ?? process.env.PROXY_HTTPS_ONLY,
    false
  );
  let httpsEnabled = parseBoolean(options.https ?? process.env.PROXY_ENABLE_HTTPS, false);
  if (options.tlsCertFile || options.tlsKeyFile || options.tlsCertPem || options.tlsKeyPem) {
    httpsEnabled = true;
  }
  if (httpsOnly) httpsEnabled = true;

  let httpEnabled = parseBoolean(options.http ?? process.env.PROXY_ENABLE_HTTP, true);
  if (httpsOnly) httpEnabled = false;

  if (!httpEnabled && !httpsEnabled) {
    throw new Error('HTTP 与 HTTPS 不能同时禁用');
  }

  const httpPort = httpEnabled ? toPort(options.httpPort, basePort) : null;
  const httpsPort = httpsEnabled
    ? toPort(
      options.httpsPort,
      toPort(
        process.env.PROXY_HTTPS_PORT,
        httpsOnly
          ? basePort
          : (httpEnabled ? Math.min(basePort + 1, 65535) : basePort)
      )
    )
    : null;

  if (httpEnabled && !httpPort) throw new Error('HTTP 端口无效');
  if (httpsEnabled && !httpsPort) throw new Error('HTTPS 端口无效');
  if (httpEnabled && httpsEnabled && httpPort === httpsPort) {
    throw new Error(`HTTP 与 HTTPS 端口冲突: ${httpPort}`);
  }

  let tls = null;
  if (httpsEnabled) {
    tls = loadTlsCredentials(options);
    if (!tls) {
      throw new Error(
        'HTTPS 已启用，但未配置证书。请设置 PROXY_TLS_CERT_FILE/PROXY_TLS_KEY_FILE 或 PROXY_TLS_CERT_PEM/PROXY_TLS_KEY_PEM'
      );
    }
  }

  return {
    host,
    http: {
      enabled: httpEnabled,
      port: httpPort,
    },
    https: {
      enabled: httpsEnabled,
      port: httpsPort,
      cert: tls?.cert || '',
      key: tls?.key || '',
      certSource: tls?.source || '',
      certFile: tls?.certFile || '',
      keyFile: tls?.keyFile || '',
    },
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function listenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const normalizeAuthToken = require('../../utils/normalizeAuthToken');

function generateAuthToken() {
  return `khy-${crypto.randomBytes(24).toString('hex')}`;
}

// 收敛到 utils/maskToken 单一真源(逐字节委托,调用点不变)
const maskToken = require('../../utils/maskToken');

function normalizeTokenId(raw, fallback = '') {
  const id = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return id || fallback;
}

function generateTokenId(existing = new Set()) {
  for (let i = 0; i < 10; i += 1) {
    const id = `tk_${crypto.randomBytes(4).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
  return `tk_${Date.now().toString(36)}`;
}

function normalizeManagedTokens(rawTokens) {
  const rows = Array.isArray(rawTokens) ? rawTokens : [];
  const usedIds = new Set();
  const now = new Date().toISOString();
  const out = [];

  for (const row of rows) {
    const token = normalizeAuthToken(row?.token, { allowEmpty: true });
    if (!token) continue;

    let id = normalizeTokenId(row?.id);
    if (!id || usedIds.has(id)) {
      id = generateTokenId(usedIds);
    }
    usedIds.add(id);

    const label = String(row?.label || row?.name || '').trim().slice(0, 120);
    const enabled = row?.enabled !== false;
    out.push({
      id,
      label,
      token,
      enabled,
      createdAt: row?.createdAt || now,
      updatedAt: row?.updatedAt || row?.createdAt || now,
    });
  }

  return out;
}

function toManagedTokenView(item) {
  return {
    id: item.id,
    label: item.label || '',
    enabled: item.enabled !== false,
    tokenMasked: maskToken(item.token),
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

function loadAuthConfig() {
  const candidates = [PROXY_AUTH_FILE, LEGACY_PROXY_AUTH_FILE];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        authToken: normalizeAuthToken(raw.authToken, { allowEmpty: true }),
        managedTokens: normalizeManagedTokens(raw.managedTokens),
        updatedAt: raw.updatedAt || null,
      };
    } catch {
      // try next file
    }
  }
  return {
    authToken: _memoryAuthToken || '',
    managedTokens: normalizeManagedTokens(_memoryManagedTokens),
  };
}

function saveAuthConfig(next = {}) {
  const current = loadAuthConfig();
  const authToken = normalizeAuthToken(
    next.authToken !== undefined ? next.authToken : current.authToken,
    { allowEmpty: true }
  );
  const merged = {
    ...current,
    ...next,
    authToken,
    managedTokens: normalizeManagedTokens(
      next.managedTokens !== undefined ? next.managedTokens : current.managedTokens
    ),
    updatedAt: new Date().toISOString(),
  };
  _memoryAuthToken = String(merged.authToken || '');
  _memoryManagedTokens = normalizeManagedTokens(merged.managedTokens);
  try {
    ensureDir(path.dirname(PROXY_AUTH_FILE));
    fs.writeFileSync(PROXY_AUTH_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch {
    // Read-only env fallback: keep token for current process lifecycle.
    _memoryAuthToken = String(merged.authToken || '');
    _memoryManagedTokens = normalizeManagedTokens(merged.managedTokens);
  }
  return merged;
}

function resolvePrimaryAuthToken() {
  const envToken = normalizeAuthToken(process.env.PROXY_AUTH_TOKEN, { allowEmpty: true });
  if (envToken) {
    process.env.PROXY_AUTH_TOKEN = envToken;
    return { token: envToken, source: 'env', generated: false };
  }

  const cfg = loadAuthConfig();
  if (cfg.authToken) {
    return { token: cfg.authToken, source: 'persisted', generated: false };
  }

  const generated = generateAuthToken();
  saveAuthConfig({ authToken: generated });
  return { token: generated, source: 'generated', generated: true };
}

function setAuthToken(rawToken) {
  const token = normalizeAuthToken(rawToken, { allowEmpty: false });
  if (!token) {
    throw new Error('token 不能为空');
  }
  saveAuthConfig({ authToken: token });
  return {
    authToken: token,
    authTokenMasked: maskToken(token),
  };
}

function rotateAuthToken() {
  const token = generateAuthToken();
  saveAuthConfig({ authToken: token });
  return {
    authToken: token,
    authTokenMasked: maskToken(token),
  };
}

function getAuthStatus() {
  const primary = resolvePrimaryAuthToken();
  const cfg = loadAuthConfig();
  const managedTokens = normalizeManagedTokens(cfg.managedTokens);
  const authTokens = buildAuthTokenSet(primary.token, { managedTokens });
  return {
    authToken: primary.token,
    authTokenMasked: maskToken(primary.token),
    source: primary.source,
    generated: primary.generated,
    tokenCount: authTokens.size,
    managedTokenCount: managedTokens.length,
    managedTokenEnabledCount: managedTokens.filter(t => t.enabled !== false).length,
    managedTokens: managedTokens.map(toManagedTokenView),
  };
}

function buildAuthTokenSet(primaryToken, { managedTokens = [] } = {}) {
  const tokens = new Set();
  const primary = normalizeAuthToken(primaryToken, { allowEmpty: true });
  if (primary) tokens.add(primary);
  for (const t of parseList(process.env.PROXY_AUTH_TOKENS)) {
    const n = normalizeAuthToken(t, { allowEmpty: true });
    if (n) tokens.add(n);
  }
  for (const row of normalizeManagedTokens(managedTokens)) {
    if (row.enabled === false) continue;
    const n = normalizeAuthToken(row.token, { allowEmpty: true });
    if (n) tokens.add(n);
  }
  return tokens;
}

function listManagedTokens() {
  const cfg = loadAuthConfig();
  const rows = normalizeManagedTokens(cfg.managedTokens);
  return rows.map(toManagedTokenView);
}

function createManagedToken({ label = '', token = '', enabled = true } = {}) {
  const cfg = loadAuthConfig();
  const rows = normalizeManagedTokens(cfg.managedTokens);
  const used = new Set(rows.map(r => r.id));
  const createdToken = normalizeAuthToken(token, { allowEmpty: true }) || generateAuthToken();
  const entry = {
    id: generateTokenId(used),
    label: String(label || '').trim().slice(0, 120),
    token: createdToken,
    enabled: enabled !== false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  rows.push(entry);
  saveAuthConfig({ managedTokens: rows });
  return {
    ...toManagedTokenView(entry),
    token: entry.token,
  };
}

function setManagedTokenEnabled(tokenId, enabled) {
  const id = normalizeTokenId(tokenId);
  if (!id) throw new Error('token id 不能为空');
  const cfg = loadAuthConfig();
  const rows = normalizeManagedTokens(cfg.managedTokens);
  const idx = rows.findIndex(r => r.id === id);
  if (idx < 0) throw new Error(`未找到 token: ${tokenId}`);
  rows[idx] = {
    ...rows[idx],
    enabled: enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  saveAuthConfig({ managedTokens: rows });
  return toManagedTokenView(rows[idx]);
}

function deleteManagedToken(tokenId) {
  const id = normalizeTokenId(tokenId);
  if (!id) throw new Error('token id 不能为空');
  const cfg = loadAuthConfig();
  const rows = normalizeManagedTokens(cfg.managedTokens);
  const idx = rows.findIndex(r => r.id === id);
  if (idx < 0) throw new Error(`未找到 token: ${tokenId}`);
  const removed = rows[idx];
  rows.splice(idx, 1);
  saveAuthConfig({ managedTokens: rows });
  return toManagedTokenView(removed);
}

function rotateManagedToken(tokenId, nextToken = '') {
  const id = normalizeTokenId(tokenId);
  if (!id) throw new Error('token id 不能为空');
  const cfg = loadAuthConfig();
  const rows = normalizeManagedTokens(cfg.managedTokens);
  const idx = rows.findIndex(r => r.id === id);
  if (idx < 0) throw new Error(`未找到 token: ${tokenId}`);
  const token = normalizeAuthToken(nextToken, { allowEmpty: true }) || generateAuthToken();
  rows[idx] = {
    ...rows[idx],
    token,
    updatedAt: new Date().toISOString(),
  };
  saveAuthConfig({ managedTokens: rows });
  return {
    ...toManagedTokenView(rows[idx]),
    token,
  };
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isLowTierRoute(route, options) {
  const adapter = String(route?.adapterKey || '').toLowerCase();
  if (adapter === 'localllm' || adapter === 'ollama') return true;
  const model = String(options?.model || route?.modelId || '').toLowerCase();
  return LOW_TIER_MODEL_PATTERN.test(model);
}

function optimizeLowTier(route, prompt, options) {
  if (!isLowTierRoute(route, options)) {
    return { prompt, options };
  }

  const maxChars = Math.max(2000, parseInt(process.env.PROXY_LOW_MODEL_MAX_CHARS || '12000', 10) || 12000);
  const cleanedMessages = Array.isArray(options.messages)
    ? options.messages
      .map(m => ({ ...m, content: normalizeText(m.content) }))
      .filter(m => m.content.length > 0)
    : [];

  let total = cleanedMessages.reduce((sum, m) => sum + m.content.length, 0);
  if (total > maxChars && cleanedMessages.length > 1) {
    // Keep latest messages for smaller models.
    const kept = [];
    for (let i = cleanedMessages.length - 1; i >= 0; i--) {
      const msg = cleanedMessages[i];
      if (msg.content.length > maxChars && kept.length === 0) {
        kept.unshift({ ...msg, content: msg.content.slice(-maxChars) });
        total = maxChars;
        break;
      }
      if (total > maxChars) {
        total -= msg.content.length;
        continue;
      }
      kept.unshift(msg);
    }
    cleanedMessages.length = 0;
    cleanedMessages.push(...kept);
  }

  const system = normalizeText(options.system || '');
  const nextPrompt = normalizeText([
    system ? `System: ${system}` : '',
    ...cleanedMessages.map(m => `${m.role}: ${m.content}`),
  ].filter(Boolean).join('\n'));

  return {
    prompt: nextPrompt || prompt,
    options: {
      ...options,
      system: system || undefined,
      messages: cleanedMessages,
      // 输出上限：防止小模型中途截断 tool_call
      maxTokens: Math.min(
        options.maxTokens || 4096,
        parseInt(process.env.PROXY_LOW_TIER_MAX_TOKENS, 10) || 4096
      ),
      _isLowTierModel: true,
    },
  };
}

function getReservoirConfig() {
  return {
    enabled: process.env.PROXY_RESERVOIR_ENABLED !== 'false',
    ttlMs: Math.max(1000, parseInt(process.env.PROXY_RESERVOIR_TTL_MS || '300000', 10) || 300000),
    maxEntries: Math.max(50, parseInt(process.env.PROXY_RESERVOIR_MAX_ENTRIES || '500', 10) || 500),
  };
}

function makeReservoirKey(kind, route, prompt, options) {
  return JSON.stringify({
    k: kind,
    a: route?.adapterKey || 'auto',
    m: options?.model || '',
    t: options?.temperature ?? null,
    n: options?.maxTokens ?? null,
    s: options?.system || '',
    x: options?.messages || [],
    p: prompt || '',
  });
}

function reservoirGet(key) {
  const cfg = getReservoirConfig();
  if (!cfg.enabled) return null;

  const item = _reservoir.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    _reservoir.delete(key);
    return null;
  }
  return item.value;
}

function reservoirSet(key, value) {
  const cfg = getReservoirConfig();
  if (!cfg.enabled) return;

  _reservoir.set(key, {
    value,
    expiresAt: Date.now() + cfg.ttlMs,
  });

  if (_reservoir.size > cfg.maxEntries) {
    const overflow = _reservoir.size - cfg.maxEntries;
    let i = 0;
    for (const k of _reservoir.keys()) {
      _reservoir.delete(k);
      i += 1;
      if (i >= overflow) break;
    }
  }
}

function reservoirGetDegraded(kind, route) {
  const cfg = getReservoirConfig();
  if (!cfg.enabled || _reservoir.size === 0) return null;

  const desiredAdapter = route?.adapterKey || 'auto';
  const entries = Array.from(_reservoir.entries()).reverse();

  for (const [rawKey, item] of entries) {
    try {
      const key = JSON.parse(rawKey);
      if (key.k !== kind) continue;
      if (desiredAdapter !== 'auto' && key.a !== desiredAdapter) continue;
      return {
        value: item.value,
        stale: Date.now() > item.expiresAt,
        adapter: key.a || 'auto',
      };
    } catch {
      // skip malformed key
    }
  }
  return null;
}

function withFallbackMeta(payload, reason, source = 'reservoir') {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    khyFallback: {
      mode: 'degraded',
      source,
      reason: String(reason || 'upstream_unavailable'),
      generatedAt: new Date().toISOString(),
    },
  };
}

function extractOpenAIContent(responseBody) {
  try {
    return String(responseBody?.choices?.[0]?.message?.content || '').trim();
  } catch {
    return '';
  }
}

/**
 * Strip real IP headers from outgoing requests to prevent IP leaking.
 * Called before forwarding to IDE adapters.
 */
function sanitizeIpHeaders() {
  // Set fake forwarded headers to mask real IP
  const fakeIp = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  return {
    'X-Forwarded-For': fakeIp,
    'X-Real-IP': fakeIp,
    'CF-Connecting-IP': fakeIp,
    'True-Client-IP': fakeIp,
  };
}

function normalizeModelId(raw) {
  return String(raw || '').trim().replace(/^['"]|['"]$/g, '');
}

function isWindsurfModelConfigPath(pathname = '') {
  return WINDSURF_MODEL_CONFIG_PATHS.has(String(pathname || ''));
}

function parseWindsurfProxyModelOverrides() {
  return parseList(
    process.env.WINDSURF_PROXY_MODELS
    || process.env.WINDSURF_MODELS
    || ''
  )
    .map(normalizeModelId)
    .filter(Boolean);
}

function dedupeModels(models = []) {
  const out = [];
  const seen = new Set();
  for (const model of models) {
    const id = normalizeModelId(model);
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

// ── Windsurf protobuf 线编码 → 已抽出至 ./windsurfProtobuf.js（纯函数降巨石 DESIGN-ARCH-051）
// 去重职责（dedupeModels）保留在本文件，由唯一调用点在传入编码器前完成，行为逐字节一致。

async function resolveWindsurfProxyModels() {
  const overridden = parseWindsurfProxyModelOverrides();
  if (overridden.length > 0) return dedupeModels(overridden);

  try {
    const gw = getGateway();
    if (!gw._initialized) await gw.init();
    const models = await gw.listModels('windsurf');
    if (Array.isArray(models) && models.length > 0) {
      const prioritized = [
        ...models.filter(m => m && m.isDefault),
        ...models.filter(m => m && !m.isDefault),
      ];
      const resolved = prioritized
        .map(m => normalizeModelId(m?.id))
        .filter(Boolean);
      if (resolved.length > 0) return dedupeModels(resolved);
    }
  } catch {
    // fallback to defaults
  }

  return WINDSURF_PROXY_DEFAULT_MODELS.slice();
}

async function handleWindsurfModelConfigs(req, res) {
  const models = await resolveWindsurfProxyModels();
  // 去重在编码前完成（原内联于编码器，上提至此处，语义等价）。
  const payload = encodeWindsurfModelConfigResponse(dedupeModels(models));
  const reqContentType = String(req.headers['content-type'] || '').toLowerCase();

  if (reqContentType.includes('application/json')) {
    return sendJson(res, 200, {
      ok: true,
      models,
      source: 'khy-windsurf-proxy',
    });
  }

  res.writeHead(200, {
    'Content-Type': reqContentType || 'application/proto',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    'X-KHY-Intercepted': 'GetCascadeModelConfigs',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

/**
 * Parse request body as JSON.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function flattenMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.text) return String(part.text);
      if (part?.type === 'image_url') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function generateByRoute(gw, route, prompt, options) {
  const mergedOptions = {
    ...options,
    preferredAdapter: route?.preferredAdapter || options.preferredAdapter || undefined,
    preferredModel: route?.preferredModel || options.preferredModel || undefined,
    strictPreferred: route?.strictPreferred !== undefined
      ? !!route.strictPreferred
      : options.strictPreferred,
    // Durable "user explicitly pinned this channel" signal. When true the gateway
    // must never relax strict and cascade into an unselected adapter (e.g. trae);
    // it retries within the chosen channel and otherwise fails with a clear cause.
    userPinnedAdapter: route?.userPinned === true ? true : (options.userPinnedAdapter || undefined),
  };
  return gw.generate(prompt, mergedOptions);
}

/**
 * Persist a completed Responses turn for `previous_response_id` chaining.
 * Stores the full conversation (prior history already prepended into
 * `canonical.messages`, plus the assistant turn just produced) under the
 * session id. A `store:false` request still receives the id but is not saved.
 *
 * @param {object|null} codexSession  { id, store } from handleMultiProtocol, or null
 * @param {Array}  priorMessages      canonical.messages sent to the model
 * @param {string} assistantContent   the assistant's text reply
 * @param {Array|null} assistantToolCalls  [{ id, name, arguments }] or null
 */
/** Best-effort parse of a function_call arguments JSON string → object. */
function parseCodexArgs(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch { return { _raw: String(args) }; }
}

function persistCodexTurn(codexSession, priorMessages, assistantContent, assistantToolCalls) {
  if (!codexSession || !codexSession.store) return;
  try {
    const assistantMsg = {
      role: 'assistant',
      content: assistantContent || '',
      thinking: null,
      toolCalls: (Array.isArray(assistantToolCalls) && assistantToolCalls.length > 0) ? assistantToolCalls : null,
      toolResults: null,
    };
    responseSessionStore.put(codexSession.id, {
      messages: [...(priorMessages || []), assistantMsg],
      createdAt: Date.now(),
    });
  } catch { /* persistence is best-effort; never break the response */ }
}

function recordTrainingSample(prompt, reply, meta = {}) {
  const p = String(prompt || '').trim();
  const r = String(reply || '').trim();
  if (!p || !r) return;
  try {
    const training = require('../modelTrainingService');
    const saved = training.recordConversation(p, r, {
      provider: meta.provider || 'proxy',
      model: meta.model || '',
      quality: 'neutral',
      tokenCount: meta.tokenCount || 0,
    });
    if (saved && !saved.accepted && String(process.env.PROXY_TRAINING_DEBUG || '').toLowerCase() === 'true') {
      console.warn('[proxyServer] training sample skipped', {
        reasons: saved.reasons || [],
        path: saved.path || '',
      });
    }
  } catch { /* best-effort */ }
  try {
    const habits = require('../usageHabitService');
    habits.recordModelUsage(meta.adapter || meta.provider || 'proxy', meta.model || '', 'conversation', 1);
    habits.recordInteraction(p);
  } catch { /* best-effort */ }
}

/**
 * Handle POST /v1/chat/completions
 */
async function handleChatCompletions(req, res) {
  const body = await parseBody(req);
  const {
    messages: rawMsgs,
    model,
    stream,
    temperature,
    max_tokens: maxTokens,
    max_completion_tokens: maxCompletionTokens,
  } = body;

  if (!rawMsgs?.length) return sendJson(res, 400, { error: { message: 'messages required' } });

  // Extract system prompt and convert to flat prompt
  let system;
  const messages = [];
  for (const m of rawMsgs) {
    if (m.role === 'system') {
      system = flattenMessageContent(m.content);
      continue;
    }
    messages.push({ role: m.role, content: flattenMessageContent(m.content) });
  }

  const prompt = [
    system ? `System: ${system}` : '',
    ...messages.map(m => `${m.role}: ${m.content}`),
  ].filter(Boolean).join('\n');

  // ── ExpandModel 拦截 ──
  try {
    const expandSvc = getExpandModelService();
    if (expandSvc.isExpandModel(model)) {
      const userText = messages.filter(m => m.role === 'user').map(m => m.content).pop() || prompt;
      return _handleExpandChatCompletions(req, res, { model, stream, userText, messages, system, temperature, maxTokens, maxCompletionTokens });
    }
  } catch { /* expandModelService not available, proceed normally */ }

  const route = modelRouter.resolveModelRoute({ model });
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const generateOptions = {
    system: system || undefined,
    messages,
    model: route.modelId || undefined,
    temperature: typeof temperature === 'number' ? temperature : undefined,
    maxTokens: typeof maxTokens === 'number'
      ? maxTokens
      : (typeof maxCompletionTokens === 'number' ? maxCompletionTokens : undefined),
  };
  const optimized = optimizeLowTier(route, prompt, generateOptions);
  const runPrompt = optimized.prompt;
  const runOptions = optimized.options;

  if (stream) {
    // SSE streaming response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    });

    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const streamModel = model
      || (route.adapterKey ? `${ADAPTER_KEY_TO_PREFIX[route.adapterKey] || route.adapterKey}/${route.modelId || 'default'}` : (route.modelId || 'default'));

    const sendSSE = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await generateByRoute(gw, route, runPrompt, {
        ...runOptions,
        onChunk: (chunk) => {
          if (chunk.type === 'text') {
            sendSSE({
              id: responseId, object: 'chat.completion.chunk', created,
              model: streamModel,
              choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
            });
          }
        },
      });

      if (!result.success) {
        throw new Error(result.error || result.content || 'Generation failed');
      }

      const responseModel = model
        || (route.adapterKey ? `${ADAPTER_KEY_TO_PREFIX[route.adapterKey] || route.adapterKey}/${result.model || route.modelId || 'default'}` : (result.model || 'default'));

      recordTrainingSample(runPrompt, result.content, {
        provider: result.provider || route.adapterKey || 'proxy',
        adapter: route.adapterKey || result.adapter || null,
        model: responseModel,
      });

      sendSSE({
        id: responseId, object: 'chat.completion.chunk', created,
        model: responseModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.end();
    }
  } else {
    // Non-streaming
    try {
      const reservoirKey = makeReservoirKey('chat', route, runPrompt, runOptions);
      const cached = reservoirGet(reservoirKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const result = await generateByRoute(gw, route, runPrompt, runOptions);

      if (!result.success) {
        return sendJson(res, 500, { error: { message: result.error || result.content || 'Generation failed' } });
      }

      const responseModel = model
        || (route.adapterKey ? `${ADAPTER_KEY_TO_PREFIX[route.adapterKey] || route.adapterKey}/${result.model || route.modelId || 'default'}` : (result.model || 'default'));

      const responseBody = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: responseModel,
        choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      recordTrainingSample(runPrompt, result.content, {
        provider: result.provider || route.adapterKey || 'proxy',
        adapter: route.adapterKey || result.adapter || null,
        model: responseModel,
      });
      reservoirSet(reservoirKey, responseBody);
      sendJson(res, 200, responseBody);
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message } });
    }
  }
}

/**
 * Handle multi-protocol requests — converts input protocol to canonical,
 * generates via gateway, then converts response back to source protocol.
 */
async function handleMultiProtocol(req, res, sourceProtocol) {
  const body = await parseBody(req);

  // ── WebSearch 服务端工具拦截 ──
  // Claude Code 的 WebSearch 会发出仅含 web_search 工具的专用子请求，期望上游
  // 服务端执行搜索并返回 server_tool_use → web_search_tool_result。非 Anthropic
  // 后端无法执行该服务端工具，会导致 "Did 0 searches" 死循环。这里在路由前用
  // KHY 自带的多引擎搜索直接合成响应，绕过模型后端，对所有适配器一致生效。
  if (sourceProtocol === PROTOCOLS.ANTHROPIC
      && String(process.env.PROXY_WEBSEARCH_INTERCEPT || 'true').toLowerCase() !== 'false'
      && webSearchInterceptor.isPureWebSearchRequest(body)) {
    try {
      const handled = await webSearchInterceptor.handleWebSearchRequest(req, res, body);
      if (handled) return;
    } catch (err) {
      // 拦截失败则继续走正常路由，避免拦截器自身故障阻断请求。
      if (String(process.env.PROXY_TOOL_DEBUG || '').toLowerCase() === 'true') {
        console.log(`[proxy:websearch] handler error, fallthrough: ${err && err.message}`);
      }
    }
  }

  const { canonical, detectedProtocol } = protocolConverter.convertRequest(body, sourceProtocol);

  // ── Responses API session chaining (previous_response_id / store) ──
  // Only the codex/Responses inbound protocol carries these fields. We mint one
  // stable `resp_…` id up front: it is BOTH the id streamed/returned to the
  // client AND the key the turn is persisted under, so a follow-up request's
  // `previous_response_id` resolves the very thread the client just saw.
  const codexSession = (sourceProtocol === PROTOCOLS.CODEX)
    ? { id: `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, store: body.store !== false }
    : null;
  if (codexSession && body.previous_response_id) {
    const prior = responseSessionStore.get(body.previous_response_id);
    if (prior && Array.isArray(prior.messages)) {
      // Prepend persisted history so the model sees the full thread without the
      // client re-sending it.
      canonical.messages = [...prior.messages, ...canonical.messages];
    } else if (String(process.env.RESPONSES_STORE_STRICT || 'true').toLowerCase() !== 'false') {
      // Unknown / expired id → Responses-style 400 (env-relaxable to ignore).
      return sendJson(res, 400, {
        error: {
          message: `Previous response '${body.previous_response_id}' not found or expired.`,
          type: 'invalid_request_error',
          code: 'previous_response_not_found',
          param: 'previous_response_id',
        },
      });
    }
  }

  // ── ExpandModel 拦截 ──
  try {
    const expandSvc = getExpandModelService();
    if (expandSvc.isExpandModel(canonical.model)) {
      const userText = (canonical.messages || [])
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''))
        .pop() || '';
      const isStream = canonical.metadata?.stream || body.stream;
      return _handleExpandMultiProtocol(req, res, {
        userText, messages: canonical.messages, system: canonical.system,
        temperature: canonical.metadata?.temperature, maxTokens: canonical.metadata?.maxTokens,
        stream: isStream, protocol: detectedProtocol || sourceProtocol,
      });
    }
  } catch { /* proceed normally */ }

  const route = modelRouter.resolveModelRoute({ model: canonical.model || null });

  // Anthropic 协议（Claude Code 接入）：强制级联模式，让 kiro → trae → codex 等
  // IDE 适配器依次尝试，不绑死单一通道。
  // 但用户显式路由（route-map / explicit）保留 strict，避免
  // sensenova-6.7-flash-lite 等直连 API 模型被 kiro 截走。
  const routeSource = route.metadata?.source || route.source || '';
  if (sourceProtocol === PROTOCOLS.ANTHROPIC) {
    if (routeSource !== 'explicit' && routeSource !== 'route-map') {
      route.strictPreferred = false;
      route.preferredAdapter = null;
    }
  }

  // Claude Code 发来的 claude-* 模型名 → 优先走 claude 适配器（透传模式），
  // 避免被 kiro 截走导致 tool_use 重组出错。
  // 仅当用户未显式指定适配器前缀时生效（trae/deepseek-v3 会正常路由）。
  if (sourceProtocol === PROTOCOLS.ANTHROPIC
      && routeSource !== 'explicit' && routeSource !== 'route-map'
      && /^claude[-_]/i.test(String(canonical.model || ''))) {
    // 如果 claude 适配器可用（有 API key 或已登录），优先透传
    const _gw = getGateway();
    const _claudeAdapter = _gw?._adapters?.find(a => a.key === 'claude');
    const _claudeAvailable = _claudeAdapter && typeof _claudeAdapter.adapter?.isAvailable === 'function'
      ? _claudeAdapter.adapter.isAvailable() : false;
    if (_claudeAvailable) {
      route.adapterKey = 'claude';
      route.preferredAdapter = 'claude';
      route.strictPreferred = true;
    } else {
      // claude 不可用，清空模型名让级联适配器自动选择
      route.modelId = null;
      route.preferredModel = null;
    }
  }

  // Preserve structured messages for adapters that support multi-turn
  // content 扁平化为纯文本，供只接受字符串的适配器使用。
  // rawMessages 使用原始请求体中的 messages（body.messages），而非 canonical.messages，
  // 因为 canonical 会把 tool_use/tool_result 从 content 数组中提取到 toolCalls/toolResults 顶层字段，
  // 但 kiroAdapter/relayApiAdapter 期望原始 Anthropic 格式（content 数组内含 tool_use/tool_result 块）。
  const structuredMessages = canonical.messages.map(m => {
    const base = { role: m.role };
    if (typeof m.content === 'string') {
      base.content = m.content;
    } else if (Array.isArray(m.content)) {
      base.content = m.content.map(b => (b.type === 'text' ? b.text || '' : '')).join('');
    } else {
      base.content = '';
    }
    if (m.toolCalls) base.toolCalls = m.toolCalls;
    if (m.toolResults) base.toolResults = m.toolResults;
    if (m.thinking) base.thinking = m.thinking;
    return base;
  });

  // Flat prompt as fallback for adapters that only accept a string
  const prompt = [
    canonical.system ? `System: ${canonical.system}` : '',
    ...structuredMessages.map(m => `${m.role}: ${m.content}`),
  ].filter(Boolean).join('\n');

  // ── Repair unpaired tool_use/tool_result in raw messages ──────────
  // Bedrock requires every tool_use to have a matching tool_result.
  // If the client session state is corrupted (interrupted tool, truncation),
  // degrade unpaired tool_use blocks to text before passing to adapters.
  let repairedRawMessages = body.messages || undefined;
  if (Array.isArray(repairedRawMessages) && repairedRawMessages.length > 0) {
    repairedRawMessages = _repairToolUsePairing(repairedRawMessages);
  }

  const generateOptions = {
    system: canonical.system || undefined,
    messages: structuredMessages,
    rawMessages: repairedRawMessages,  // 原始 Anthropic 请求体中的 messages，已修复 tool_use/tool_result 配对
    model: route.modelId || undefined,
    temperature: canonical.metadata.temperature || undefined,
    maxTokens: canonical.metadata.maxTokens || undefined,
    // 采样/控制参数透传 —— 由 B 层 handler 按目标协议条件写入 body
    topP: canonical.metadata.topP ?? undefined,
    stopSequences: canonical.metadata.stopSequences || undefined,
    toolChoice: canonical.toolChoice || undefined,
    frequencyPenalty: canonical.metadata.frequencyPenalty ?? undefined,
    presencePenalty: canonical.metadata.presencePenalty ?? undefined,
    seed: canonical.metadata.seed ?? undefined,
    responseFormat: canonical.metadata.responseFormat ?? undefined,
    reasoningEffort: canonical.metadata.reasoningEffort ?? undefined,
    thinking: canonical.metadata.thinking ?? undefined,
    tools: canonical.tools || undefined,
    rawTools: body.tools || undefined,  // 保留原始工具定义（含服务端工具 type 字段如 web_search_20250305）
    // 透传 CC 追踪头部
    _ccTraceHeaders: req._ccTraceHeaders || undefined,
    // 透传 CC 的 anthropic-beta 头部
    _anthropicBeta: req.headers['anthropic-beta'] || undefined,
  };

  // 清理 CC 实验字段：非 Anthropic 直连的适配器不认识 strict/eager_input_streaming/defer_loading
  // 对齐 CC 的 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 行为
  if (Array.isArray(generateOptions.tools) && generateOptions.tools.length > 0
      && route.adapterKey !== 'claude' && route.adapterKey !== 'api') {
    generateOptions.tools = generateOptions.tools.map(t => {
      const { strict, eager_input_streaming, defer_loading, ...clean } = t;
      return clean;
    });
  }

  // 调试：工具/消息传递链路
  if (String(process.env.PROXY_TOOL_DEBUG || '').toLowerCase() === 'true') {
    const toolCount = canonical.tools?.length || 0;
    const rawMsgCount = canonical.messages?.length || 0;
    const hasToolUseInMsgs = canonical.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use'));
    const hasToolResultInMsgs = canonical.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    console.log(`[proxy:tool-debug] tools=${toolCount} rawMsgs=${rawMsgCount} hasToolUse=${hasToolUseInMsgs} hasToolResult=${hasToolResultInMsgs} route=${route.adapterKey}/${route.modelId}`);
  }
  const optimized = optimizeLowTier(route, prompt, generateOptions);
  const runPrompt = optimized.prompt;
  const runOptions = optimized.options;

  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const outputProtocol = detectedProtocol;

  if (canonical.metadata.stream) {
    // ── Anthropic 原生透传：如果目标是 claude Direct 且协议是 Anthropic，
    // 直接把上游 SSE 原样 pipe 到下游，跳过 parse→reconstruct 链路 ──
    // Only claudeAdapter supports onRawChunk/passthroughStream — do NOT include
    // 'api' or 'relay_api' here; they use OpenAI protocol upstream and would
    // produce an empty SSE stream since onRawChunk is never called.
    const isAnthropicPassthrough = sourceProtocol === PROTOCOLS.ANTHROPIC
      && outputProtocol === PROTOCOLS.ANTHROPIC
      && route.adapterKey === 'claude'
      && String(process.env.PROXY_ANTHROPIC_PASSTHROUGH || 'true').toLowerCase() !== 'false';

    if (isAnthropicPassthrough) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
      });
      try {
        const result = await generateByRoute(gw, route, runPrompt, {
          ...runOptions,
          passthroughStream: true,
          onRawChunk: (buf) => {
            try { res.write(buf); } catch { /* client disconnected */ }
          },
        });
        if (!result.success && !result.passthrough) {
          // 透传不可用（适配器不支持），回退到重组模式
          // 此分支不应触发（只有 claude Direct 模式进此路径）
          const sseEvent = (eventType, data) => {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          sseEvent('error', { type: 'error', error: { type: 'api_error', message: result.error || 'Passthrough failed' } });
        }
        res.end();
        return;
      } catch (err) {
        // 透传失败，发送错误事件
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })}\n\n`);
        } catch { /* client disconnected */ }
        res.end();
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
    });

    const isAnthropic = outputProtocol === PROTOCOLS.ANTHROPIC;
    // Codex = OpenAI Responses API wire format. Gets its own true-streaming state
    // machine (response.* semantic events) below; the legacy `!isAnthropic` blob
    // path is reserved for plain OpenAI/Gemini and left untouched (zero regression).
    const isCodex = outputProtocol === PROTOCOLS.CODEX;
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const resolvedModel = canonical.model || 'default';

    // Anthropic SSE 辅助函数
    const sseEvent = (eventType, data) => {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (isAnthropic) {
      // 1) message_start
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: resolvedModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      sseEvent('ping', { type: 'ping' });
      // 注意：不再预开 content_block，等待首个 chunk 确定 block 类型
    }

    let fullContent = '';
    let outputTokens = 0;
    let blockIndex = 0;
    let hasThinkingBlock = false;
    let hasTextBlock = false;
    let hasToolUse = false;
    let streamToolUseBlocks = [];
    let tokenUsage = null;

    // ── Codex (Responses API) streaming state machine ──
    // Emits the real ordered event stream a strict Responses client expects:
    //   response.created → response.in_progress
    //   message: output_item.added → content_part.added → output_text.delta*
    //            → output_text.done → content_part.done → output_item.done
    //   function_call: output_item.added → function_call_arguments.delta*
    //            → function_call_arguments.done → output_item.done
    //   response.completed   (NO [DONE] sentinel — completed is terminal)
    // Every event carries a monotonic sequence_number (from 0). Two distinct ids
    // per tool call: item_id (`fc_…`, keys arg-delta events) vs call_id (`call_…`,
    // referenced by the client's next function_call_output).
    let codexSeq = 0;
    let codexOutputIndex = 0;
    let codexMsgItemId = null;
    let codexMsgOpen = false;
    let codexMsgText = '';
    let codexCurrentTool = null; // in-flight incremental function_call entry
    const codexToolItems = []; // { itemId, callId, name, arguments } for the final snapshot
    const codexRespId = (codexSession && codexSession.id)
      || `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const codexEvent = (eventType, data) => {
      const payload = { type: eventType, sequence_number: codexSeq++, ...data };
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const codexSnapshot = (status, output, usage) => ({
      id: codexRespId,
      object: 'response',
      status,
      model: resolvedModel,
      output: output || [],
      usage: usage || null,
    });
    const codexOpenMsg = () => {
      if (codexMsgOpen) return;
      codexMsgItemId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      codexMsgText = '';
      codexEvent('response.output_item.added', {
        output_index: codexOutputIndex,
        item: { id: codexMsgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      codexEvent('response.content_part.added', {
        item_id: codexMsgItemId, output_index: codexOutputIndex, content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      codexMsgOpen = true;
    };
    const codexCloseMsg = () => {
      if (!codexMsgOpen) return;
      codexEvent('response.output_text.done', {
        item_id: codexMsgItemId, output_index: codexOutputIndex, content_index: 0, text: codexMsgText,
      });
      codexEvent('response.content_part.done', {
        item_id: codexMsgItemId, output_index: codexOutputIndex, content_index: 0,
        part: { type: 'output_text', text: codexMsgText, annotations: [] },
      });
      codexEvent('response.output_item.done', {
        output_index: codexOutputIndex,
        item: { id: codexMsgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: codexMsgText, annotations: [] }] },
      });
      codexOutputIndex++;
      codexMsgOpen = false;
    };
    // Emit a complete function_call item in one shot (whole-chunk + fallback paths).
    const codexEmitToolBlock = (callId, name, argsStr) => {
      const itemId = `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
      codexToolItems.push({ itemId, callId, name, arguments: argsStr });
      codexEvent('response.output_item.added', {
        output_index: codexOutputIndex,
        item: { id: itemId, type: 'function_call', status: 'in_progress', name, call_id: callId, arguments: '' },
      });
      codexEvent('response.function_call_arguments.delta', { item_id: itemId, output_index: codexOutputIndex, delta: argsStr });
      codexEvent('response.function_call_arguments.done', { item_id: itemId, output_index: codexOutputIndex, arguments: argsStr });
      codexEvent('response.output_item.done', {
        output_index: codexOutputIndex,
        item: { id: itemId, type: 'function_call', status: 'completed', name, call_id: callId, arguments: argsStr },
      });
      codexOutputIndex++;
    };
    // Final response snapshot output[] built from the ACTUAL streamed items (same
    // ids the client already saw), guaranteeing stream/snapshot consistency.
    const codexBuildFinalOutput = () => {
      const output = [];
      if (fullContent) {
        output.push({
          type: 'message', id: codexMsgItemId || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
          status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: fullContent, annotations: [] }],
        });
      }
      for (const t of codexToolItems) {
        output.push({ type: 'function_call', id: t.itemId, call_id: t.callId, name: t.name, arguments: t.arguments, status: 'completed' });
      }
      return output;
    };
    const codexUsage = () => (tokenUsage
      ? {
          input_tokens: tokenUsage.inputTokens || 0,
          output_tokens: tokenUsage.outputTokens || 0,
          total_tokens: (tokenUsage.inputTokens || 0) + (tokenUsage.outputTokens || 0),
        }
      : { input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens });

    if (isCodex) {
      codexEvent('response.created', { response: codexSnapshot('in_progress', [], null) });
      codexEvent('response.in_progress', { response: codexSnapshot('in_progress', [], null) });
    }

    // 代理层默认不额外强杀流；仅在显式启用时补一层 idle abort。
    const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.PROXY_STREAM_IDLE_TIMEOUT_MS || '90000', 10);
    const PROXY_STREAM_IDLE_ABORT_ENABLED = parseBoolean(process.env.PROXY_STREAM_IDLE_ABORT_ENABLED, false);
    const streamIdleAc = PROXY_STREAM_IDLE_ABORT_ENABLED ? new AbortController() : null;
    let streamIdleTimer = null;
    const resetStreamIdle = () => {
      if (!streamIdleAc) return;
      if (streamIdleTimer) clearTimeout(streamIdleTimer);
      streamIdleTimer = setTimeout(() => {
        streamIdleAc.abort('stream idle timeout');
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    const clearStreamIdle = () => {
      if (streamIdleTimer) { clearTimeout(streamIdleTimer); streamIdleTimer = null; }
    };
    if (streamIdleAc) resetStreamIdle(); // 首次启动
    const mergedAbortSignal = mergeAbortSignals(runOptions.abortSignal || null, streamIdleAc ? streamIdleAc.signal : null);

    try {
      const result = await generateByRoute(gw, route, runPrompt, {
        ...runOptions,
        ...(mergedAbortSignal ? { abortSignal: mergedAbortSignal } : {}),
        onChunk: (chunk) => {
          if (streamIdleAc) resetStreamIdle(); // 每收到 chunk 重置计时器

          if (chunk.type === 'token_usage') {
            // 保存 token usage 供 message_delta 使用
            tokenUsage = chunk;
            return;
          }

          if (isCodex) {
            // ── Responses API streaming state machine ──
            if (chunk.type === 'text') {
              codexOpenMsg();
              fullContent += chunk.text;
              codexMsgText += chunk.text;
              outputTokens++;
              codexEvent('response.output_text.delta', {
                item_id: codexMsgItemId, output_index: codexOutputIndex, content_index: 0, delta: chunk.text,
              });
            } else if (chunk.type === 'tool_use_start') {
              codexCloseMsg();
              const itemId = `fc_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
              const callId = chunk.toolUseId || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
              codexCurrentTool = { itemId, callId, name: chunk.name, outputIndex: codexOutputIndex, arguments: '' };
              codexToolItems.push(codexCurrentTool);
              codexEvent('response.output_item.added', {
                output_index: codexOutputIndex,
                item: { id: itemId, type: 'function_call', status: 'in_progress', name: chunk.name, call_id: callId, arguments: '' },
              });
            } else if (chunk.type === 'tool_use_input_delta') {
              if (codexCurrentTool) {
                const part = chunk.partialJson || '';
                codexCurrentTool.arguments += part;
                codexEvent('response.function_call_arguments.delta', {
                  item_id: codexCurrentTool.itemId, output_index: codexCurrentTool.outputIndex, delta: part,
                });
              }
            } else if (chunk.type === 'tool_use_end') {
              hasToolUse = true;
              if (codexCurrentTool) {
                codexEvent('response.function_call_arguments.done', {
                  item_id: codexCurrentTool.itemId, output_index: codexCurrentTool.outputIndex, arguments: codexCurrentTool.arguments,
                });
                codexEvent('response.output_item.done', {
                  output_index: codexCurrentTool.outputIndex,
                  item: { id: codexCurrentTool.itemId, type: 'function_call', status: 'completed', name: codexCurrentTool.name, call_id: codexCurrentTool.callId, arguments: codexCurrentTool.arguments },
                });
                codexOutputIndex++;
                codexCurrentTool = null;
              }
            } else if (chunk.type === 'tool_use') {
              // Whole-chunk tool call (adapters that don't stream arg deltas).
              codexCloseMsg();
              hasToolUse = true;
              const callId = chunk.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
              codexEmitToolBlock(callId, chunk.name, JSON.stringify(chunk.input || chunk.arguments || {}));
            }
            // thinking / thinking_signature are dropped in v1 (no malformed
            // reasoning item; clients tolerate its absence).
            return;
          }

          if (!isAnthropic) {
            // OpenAI / 通用格式：只转发 text
            if (chunk.type === 'text') {
              fullContent += chunk.text;
              outputTokens++;
              res.write(`data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: chunk.text } })}\n\n`);
            }
            return;
          }

          // ── Anthropic SSE 状态机 ──

          // 辅助：关闭已开的 thinking block
          const closeThinking = () => {
            if (hasThinkingBlock) {
              sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
          };
          // 辅助：关闭已开的 text block
          const closeText = () => {
            if (hasTextBlock) {
              sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasTextBlock = false;
            }
          };

          if (chunk.type === 'thinking') {
            // thinking 块：需先关闭已开的 text block（thinking→text→thinking 切换场景）
            closeText();
            if (!hasThinkingBlock) {
              sseEvent('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              });
              hasThinkingBlock = true;
            }
            sseEvent('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'thinking_delta', thinking: chunk.text },
            });
          } else if (chunk.type === 'thinking_signature') {
            // thinking 签名 + 关闭 thinking block
            if (hasThinkingBlock) {
              sseEvent('content_block_delta', {
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'signature_delta', signature: chunk.signature },
              });
              sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
              blockIndex++;
              hasThinkingBlock = false;
            }
          } else if (chunk.type === 'text') {
            // text 块：需先关闭已开的 thinking block
            closeThinking();
            if (!hasTextBlock) {
              sseEvent('content_block_start', {
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'text', text: '' },
              });
              hasTextBlock = true;
            }
            fullContent += chunk.text;
            outputTokens++;
            sseEvent('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'text_delta', text: chunk.text },
            });
          } else if (chunk.type === 'tool_use_start') {
            // 增量 tool_use 开始（kiroAdapter 发出）
            closeThinking();
            closeText();
            const toolId = chunk.toolUseId || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
            sseEvent('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: toolId, name: chunk.name, input: {} },
            });
          } else if (chunk.type === 'tool_use_input_delta') {
            // 增量 tool_use input 片段
            sseEvent('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: chunk.partialJson },
            });
          } else if (chunk.type === 'tool_use_end') {
            // 增量 tool_use 结束
            hasToolUse = true;
            streamToolUseBlocks.push(chunk);
            sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
          } else if (chunk.type === 'tool_use') {
            // 旧格式兼容（其他适配器可能仍发完整 tool_use chunk）
            closeThinking();
            closeText();
            hasToolUse = true;
            const toolId = chunk.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
            streamToolUseBlocks.push(chunk);
            sseEvent('content_block_start', {
              type: 'content_block_start', index: blockIndex,
              content_block: { type: 'tool_use', id: toolId, name: chunk.name, input: {} },
            });
            sseEvent('content_block_delta', {
              type: 'content_block_delta', index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(chunk.input || chunk.arguments || {}) },
            });
            sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            blockIndex++;
          }
        },
      });
      if (!result.success) {
        throw new Error(result.error || result.content || 'Generation failed');
      }
      if (!fullContent && result.content) {
        fullContent = result.content;
      }

      const finalModel = canonical.model || result.model || 'default';

      // 调试：结果工具信息
      if (String(process.env.PROXY_TOOL_DEBUG || '').toLowerCase() === 'true') {
        console.log(`[proxy:tool-debug] result: success=${result.success} stopReason=${result.stopReason} toolUseBlocks=${result.toolUseBlocks?.length || 0} hasToolUseInStream=${hasToolUse} streamToolUseBlocks=${streamToolUseBlocks?.length || 0} contentLen=${fullContent?.length || 0}`);
      }

      recordTrainingSample(runPrompt, fullContent, {
        provider: result.provider || route.adapterKey || 'proxy',
        adapter: route.adapterKey || result.adapter || null,
        model: finalModel,
      });

      // 如果 result 返回了 toolUseBlocks 但流式未收到 tool_use chunk，补发
      if (!hasToolUse && Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0) {
        if (isCodex) {
          // Codex fallback: close any open message item, then emit a full
          // function_call item sequence per tool block.
          codexCloseMsg();
          hasToolUse = true;
          for (const tc of result.toolUseBlocks) {
            const callId = tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
            codexEmitToolBlock(callId, tc.name, JSON.stringify(tc.input || tc.arguments || {}));
          }
        } else {
        // 关闭已开的 thinking/text block
        if (hasThinkingBlock) {
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          hasThinkingBlock = false;
        }
        if (hasTextBlock) {
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          hasTextBlock = false;
        }
        hasToolUse = true;
        for (const tc of result.toolUseBlocks) {
          const toolId = tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
          sseEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: toolId, name: tc.name, input: {} },
          });
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input || tc.arguments || {}) },
          });
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
        }
        }
      }

      if (isCodex) {
        // Close any still-open message item, then emit the terminal
        // response.completed with a snapshot built from the streamed items.
        codexCloseMsg();
        const finalOutput = codexBuildFinalOutput();
        const status = codexToolItems.length > 0 ? 'requires_action' : 'completed';
        codexEvent('response.completed', { response: codexSnapshot(status, finalOutput, codexUsage()) });
        // NO `data: [DONE]` — response.completed is the terminal event.
        // Persist the turn for previous_response_id chaining (store:true only).
        persistCodexTurn(
          codexSession, canonical.messages, fullContent,
          codexToolItems.map((t) => ({ id: t.callId, name: t.name, arguments: parseCodexArgs(t.arguments) })),
        );
      } else if (isAnthropic) {
        // 关闭未关闭的 thinking/text block
        if (hasThinkingBlock) {
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          hasThinkingBlock = false;
        }
        if (hasTextBlock) {
          sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          hasTextBlock = false;
        }
        // message_delta — stop_reason 取决于是否有 tool_use，usage 优先使用真实 token 统计
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: {
            output_tokens: tokenUsage ? tokenUsage.outputTokens : outputTokens,
            input_tokens: tokenUsage ? tokenUsage.inputTokens : 0,
            cache_read_input_tokens: tokenUsage ? (tokenUsage.cacheReadInputTokens || 0) : 0,
            cache_creation_input_tokens: tokenUsage ? (tokenUsage.cacheWriteInputTokens || 0) : 0,
          },
        });
        // message_stop
        sseEvent('message_stop', { type: 'message_stop' });
      } else {
        const elseToolCalls = Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0
          ? result.toolUseBlocks.map(tc => ({
              id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
              name: tc.name,
              arguments: tc.input || tc.arguments || {},
            }))
          : null;
        const canonicalResp = { id: msgId, model: finalModel, content: fullContent, thinking: null, toolCalls: elseToolCalls, stopReason: elseToolCalls ? 'tool_use' : 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
        const formatted = protocolConverter.convertResponse(canonicalResp, outputProtocol);
        res.write(`data: ${JSON.stringify(formatted)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      clearStreamIdle();
    } catch (err) {
      clearStreamIdle();
      if (isCodex) {
        // Guarantee a complete, well-formed terminal sequence even on mid-stream
        // failure: close any dangling message/tool item, then emit
        // response.completed (never leave a half-open item).
        try {
          if (codexCurrentTool) {
            codexEvent('response.function_call_arguments.done', {
              item_id: codexCurrentTool.itemId, output_index: codexCurrentTool.outputIndex, arguments: codexCurrentTool.arguments,
            });
            codexEvent('response.output_item.done', {
              output_index: codexCurrentTool.outputIndex,
              item: { id: codexCurrentTool.itemId, type: 'function_call', status: 'completed', name: codexCurrentTool.name, call_id: codexCurrentTool.callId, arguments: codexCurrentTool.arguments },
            });
            codexOutputIndex++;
            codexCurrentTool = null;
          }
          codexCloseMsg();
          const status = codexToolItems.length > 0 ? 'requires_action' : 'completed';
          codexEvent('response.completed', { response: codexSnapshot(status, codexBuildFinalOutput(), codexUsage()) });
        } catch { /* client may have disconnected */ }
      } else if (isAnthropic) {
        // 流中断时确保 content_block 正确关闭（对齐 CC 的孤儿 tool_use 处理）
        try {
          if (hasThinkingBlock) {
            sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          } else if (hasTextBlock) {
            sseEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          }
        } catch {}
        // 发送 message_delta + message_stop 确保 SSE 序列完整
        try {
          sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: {
              output_tokens: tokenUsage ? tokenUsage.outputTokens : outputTokens,
              input_tokens: tokenUsage ? tokenUsage.inputTokens : 0,
            },
          });
          sseEvent('message_stop', { type: 'message_stop' });
        } catch { /* client may have disconnected */ }
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      }
      res.end();
    }
  } else {
    try {
      const reservoirKey = makeReservoirKey(`proto:${sourceProtocol}`, route, runPrompt, runOptions);
      const cached = reservoirGet(reservoirKey);
      if (cached) {
        return sendJson(res, 200, cached);
      }

      const result = await generateByRoute(gw, route, runPrompt, runOptions);
      if (!result.success) {
        return sendJson(res, 500, { error: { message: result.error || result.content || 'Generation failed' } });
      }

      const resolvedModel = canonical.model || result.model || 'default';
      const toolCalls = Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0
        ? result.toolUseBlocks.map(tc => ({
            id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
            name: tc.name,
            arguments: tc.input || tc.arguments || {},
          }))
        : null;
      const canonicalResp = { id: (codexSession && codexSession.id) || `msg_${crypto.randomUUID()}`, model: resolvedModel, content: result.content, thinking: null, toolCalls, stopReason: toolCalls ? 'tool_use' : 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      const formatted = protocolConverter.convertResponse(canonicalResp, outputProtocol);
      // Persist for previous_response_id chaining (codex/Responses, store:true).
      persistCodexTurn(codexSession, canonical.messages, result.content,
        toolCalls ? toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) : null);
      recordTrainingSample(runPrompt, result.content, {
        provider: result.provider || route.adapterKey || 'proxy',
        adapter: route.adapterKey || result.adapter || null,
        model: resolvedModel,
      });
      reservoirSet(reservoirKey, formatted);
      sendJson(res, 200, formatted);
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message } });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ExpandModel Handlers — khy-expand 虚拟模型
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle OpenAI chat/completions for khy-expand model.
 */
async function _handleExpandChatCompletions(req, res, ctx) {
  const { model, stream, userText, messages, system, temperature, maxTokens, maxCompletionTokens } = ctx;
  const expandSvc = getExpandModelService();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const expandOpts = {
    cwd: process.cwd(),
    messages, system, temperature,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : (typeof maxCompletionTokens === 'number' ? maxCompletionTokens : undefined),
  };

  if (!stream) {
    const result = await expandSvc.handleExpandModel(userText, expandOpts);
    return sendJson(res, 200, {
      id: responseId,
      object: 'chat.completion',
      created,
      model: 'khy-expand',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content || '' },
        finish_reason: 'stop',
      }],
      usage: result.tokenUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // Streaming SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
  });

  const sendSSE = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };

  // Role chunk
  sendSSE({ id: responseId, object: 'chat.completion.chunk', created, model: 'khy-expand',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

  let fullContent = '';
  const result = await expandSvc.handleExpandModelStream(userText, {
    ...expandOpts,
    onChunk: (chunk) => {
      const text = chunk?.text || chunk?.content || '';
      if (text) {
        fullContent += text;
        sendSSE({ id: responseId, object: 'chat.completion.chunk', created, model: 'khy-expand',
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
    },
  });

  // Finish chunk
  sendSSE({ id: responseId, object: 'chat.completion.chunk', created, model: 'khy-expand',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Handle Anthropic/multi-protocol for khy-expand model.
 */
async function _handleExpandMultiProtocol(req, res, ctx) {
  const { userText, messages, system, temperature, maxTokens, stream, protocol } = ctx;
  const expandSvc = getExpandModelService();
  const msgId = `msg_${crypto.randomUUID()}`;

  const expandOpts = { cwd: process.cwd(), messages, system, temperature, maxTokens };

  if (!stream) {
    const result = await expandSvc.handleExpandModel(userText, expandOpts);
    return sendJson(res, 200, {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: 'khy-expand',
      content: [{ type: 'text', text: result.content || '' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: result.tokenUsage || { input_tokens: 0, output_tokens: 0 },
    });
  }

  // Anthropic SSE streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
  });

  const sendEvent = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };

  // message_start
  sendEvent('message_start', {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model: 'khy-expand',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } },
  });

  sendEvent('ping', { type: 'ping' });

  // content_block_start
  sendEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  let fullContent = '';
  await expandSvc.handleExpandModelStream(userText, {
    ...expandOpts,
    onChunk: (chunk) => {
      const text = chunk?.text || chunk?.content || '';
      if (text) {
        fullContent += text;
        sendEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }
    },
  });

  // content_block_stop
  sendEvent('content_block_stop', { type: 'content_block_stop', index: 0 });

  // message_delta
  sendEvent('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: fullContent.length } });

  // message_stop
  sendEvent('message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Handle GET /v1/models — aggregate from all public adapters
 */
async function handleListModels(req, res) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const created = Math.floor(Date.now() / 1000);
  const includeRawRelayModels = shouldExposeRawRelayModels();
  const allModels = [];
  const seen = new Set();
  const pushModel = ({
    id,
    owner = 'proxy',
    name = '',
    description = '',
    isDefault = false,
  } = {}) => {
    const normalizedId = String(id || '').trim();
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    allModels.push({
      id: normalizedId,
      object: 'model',
      created,
      owned_by: owner,
      name: name || normalizedId,
      description: description || '',
      is_default: !!isDefault,
    });
  };

  for (const key of PUBLIC_ADAPTERS) {
    try {
      const models = await gw.listModels(key);
      const prefix = ADAPTER_KEY_TO_PREFIX[key] || key;
      for (const m of models) {
        if (!m?.id) continue;
        pushModel({
          id: `${prefix}/${m.id}`,
          owner: key,
          name: m.name || m.id,
          description: m.description || '',
          isDefault: m.isDefault || false,
        });
        if (key === 'relay_api' && includeRawRelayModels) {
          pushModel({
            id: m.id,
            owner: key,
            name: m.name || m.id,
            description: m.description || '',
            isDefault: m.isDefault || false,
          });
        }
        // Compatibility aliases: antigravity/* and nirvana/* route to Trae adapter.
        if (key === 'trae') {
          pushModel({
            id: `antigravity/${m.id}`,
            owner: key,
            name: `Antigravity ${m.name || m.id}`,
            description: m.description || '',
            isDefault: false,
          });
          pushModel({
            id: `nirvana/${m.id}`,
            owner: key,
            name: `Nirvana ${m.name || m.id}`,
            description: m.description || '',
            isDefault: false,
          });
        }
      }
    } catch { /* adapter not available */ }
  }

  // Inject khy-expand virtual model
  try {
    const expandInfo = getExpandModelService().getExpandModelInfo();
    pushModel({
      id: expandInfo.id,
      owner: 'khy',
      name: expandInfo.name || 'KHY ExpandModel',
      description: expandInfo.description || '',
    });
  } catch { /* expandModelService not available */ }

  sendJson(res, 200, { object: 'list', data: allModels });
}

/**
 * Start the proxy server.
 */
async function start(portOrOptions) {
  if (_server) {
    throw new Error('Proxy server already running');
  }

  const requestedConfig = resolveStartConfig(portOrOptions);
  const primaryAuth = resolvePrimaryAuthToken();
  const authToken = primaryAuth.token;
  const cfg = loadAuthConfig();
  const authTokens = buildAuthTokenSet(authToken, { managedTokens: cfg.managedTokens });

  // Log token source on start for IDE/client configuration.
  if (primaryAuth.generated) {
    console.log(`[Proxy] Auto-generated auth token: ${authToken}`);
    console.log('[Proxy] Token has been persisted at ~/.khy/proxy_server_auth.json');
  } else if (primaryAuth.source === 'persisted') {
    console.log(`[Proxy] Using persisted auth token: ${maskToken(authToken)}`);
  } else {
    console.log('[Proxy] Using auth token from PROXY_AUTH_TOKEN');
  }

  const requestHandler = async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': process.env.PROXY_CORS_ORIGINS || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-goog-api-key',
        'Access-Control-Max-Age': '86400',
      });
      return res.end();
    }

    // Auth check (always enforced — token is auto-generated if not configured)
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const apiKey = String(req.headers['x-api-key'] || req.headers['x-goog-api-key'] || '').trim();
    const liveCfg = loadAuthConfig();
    const livePrimary = resolvePrimaryAuthToken();
    const liveTokens = buildAuthTokenSet(livePrimary.token, { managedTokens: liveCfg.managedTokens });
    const queryKey = String(new URL(req.url, 'http://localhost').searchParams.get('key') || '').trim();
    const presented = bearer || apiKey || queryKey;
    if (!presented || !liveTokens.has(presented)) {
      return sendJson(res, 401, { error: { message: 'Unauthorized — use Authorization: Bearer <khy-...> (PROXY_AUTH_TOKEN or PROXY_AUTH_TOKENS)' } });
    }

    // Strip real client IP from incoming request before processing
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-real-ip'];
    delete req.headers['cf-connecting-ip'];
    delete req.headers['true-client-ip'];

    // 保留 Claude Code 追踪头部供下游适配器使用
    req._ccTraceHeaders = {
      'x-client-request-id': req.headers['x-client-request-id'] || '',
      'x-claude-code-session-id': req.headers['x-claude-code-session-id'] || '',
    };

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      if (req.method === 'POST' && isWindsurfModelConfigPath(pathname)) {
        await handleWindsurfModelConfigs(req, res);
      } else if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        await handleChatCompletions(req, res);
      } else if (req.method === 'POST' && pathname === '/v1/messages') {
        await handleMultiProtocol(req, res, PROTOCOLS.ANTHROPIC);
      } else if (req.method === 'POST' && pathname.match(/^\/v1beta\/models\/[^/]+:generateContent$/)) {
        await handleMultiProtocol(req, res, PROTOCOLS.GEMINI);
      } else if (req.method === 'POST' && pathname === '/v1/responses') {
        await handleMultiProtocol(req, res, PROTOCOLS.CODEX);
      } else if (req.method === 'GET' && pathname === '/v1/models') {
        await handleListModels(req, res);
      } else if (req.method === 'GET' && pathname === '/health') {
        const r = getReservoirConfig();
        sendJson(res, 200, {
          status: 'ok',
          adapters: PUBLIC_ADAPTERS,
          protocols: protocolConverter.getSupportedProtocols(),
          runtime: _runtime || buildRuntimeStatus(activeConfig, authToken),
          reservoir: { enabled: r.enabled, size: _reservoir.size, ttlMs: r.ttlMs, maxEntries: r.maxEntries },
        });
      } else if (req.method === 'GET' && pathname === '/reservoir/stats') {
        const r = getReservoirConfig();
        sendJson(res, 200, {
          enabled: r.enabled,
          size: _reservoir.size,
          ttlMs: r.ttlMs,
          maxEntries: r.maxEntries,
        });
      } else {
        sendJson(res, 404, { error: { message: 'Not found' } });
      }
    } catch (err) {
      sendJson(res, 500, { error: { message: err.message } });
    }
  };

  let activeConfig = cloneStartConfig(requestedConfig);
  let localHttpServer = null;
  let localHttpsServer = null;

  for (let attempt = 0; attempt <= PORT_RETRY_LIMIT; attempt += 1) {
    localHttpServer = activeConfig.http.enabled ? http.createServer(requestHandler) : null;
    localHttpsServer = activeConfig.https.enabled
      ? https.createServer({ cert: activeConfig.https.cert, key: activeConfig.https.key }, requestHandler)
      : null;

    try {
      if (localHttpServer) await listenServer(localHttpServer, activeConfig.http.port, activeConfig.host);
      if (localHttpsServer) await listenServer(localHttpsServer, activeConfig.https.port, activeConfig.host);
      break;
    } catch (err) {
      await closeServer(localHttpServer);
      await closeServer(localHttpsServer);
      localHttpServer = null;
      localHttpsServer = null;
      if (err?.code === 'EADDRINUSE' && attempt < PORT_RETRY_LIMIT) {
        const httpPort = activeConfig.http.enabled ? activeConfig.http.port : '-';
        const httpsPort = activeConfig.https.enabled ? activeConfig.https.port : '-';
        console.warn(
          '[Proxy] Listen port conflict on http=%s https=%s, retrying next port set (%d/%d)',
          httpPort,
          httpsPort,
          attempt + 1,
          PORT_RETRY_LIMIT
        );
        activeConfig = bumpStartConfigPorts(activeConfig, 1);
        continue;
      }
      throw err;
    }
  }

  _httpServer = localHttpServer;
  _httpsServer = localHttpsServer;
  _server = _httpServer || _httpsServer;
  _runtimeStartedAt = Date.now();
  _runtime = buildRuntimeStatus(activeConfig, authToken);
  writeRuntimeStatus(_runtime);

  return {
    port: getPort(),
    host: activeConfig.host,
    mode: _runtime.mode,
    http: _runtime.http,
    https: _runtime.https,
    authToken,
    authTokenMasked: maskToken(authToken),
    generatedToken: primaryAuth.generated,
    authTokenSource: primaryAuth.source,
    tokenCount: authTokens.size,
  };
}

/**
 * Stop the proxy server.
 */
function stop() {
  return Promise.resolve().then(async () => {
    await closeServer(_httpServer);
    await closeServer(_httpsServer);
    _httpServer = null;
    _httpsServer = null;
    _server = null;
    _runtime = null;
    _runtimeStartedAt = 0;
    clearRuntimeStatus();
  });
}

function isRunning() { return !!_httpServer || !!_httpsServer; }

function getPort() {
  if (_runtime?.http?.enabled && Number.isFinite(_runtime.http.port)) return _runtime.http.port;
  if (_runtime?.https?.enabled && Number.isFinite(_runtime.https.port)) return _runtime.https.port;
  return toPort(process.env.PROXY_PORT, 9100) || 9100;
}

function getRuntimeStatus() {
  if (_runtime) return { ..._runtime, http: { ..._runtime.http }, https: { ..._runtime.https } };
  try {
    const fallback = resolveStartConfig({ port: getPort() });
    return buildRuntimeStatus(fallback, resolvePrimaryAuthToken().token);
  } catch {
    return {
      mode: 'http-only',
      host: process.env.PROXY_HOST || '127.0.0.1',
      http: {
        enabled: true,
        port: toPort(process.env.PROXY_PORT, 9100) || 9100,
        host: process.env.PROXY_HOST || '127.0.0.1',
        url: `http://${process.env.PROXY_HOST || '127.0.0.1'}:${toPort(process.env.PROXY_PORT, 9100) || 9100}`,
      },
      https: {
        enabled: false,
        port: null,
        host: process.env.PROXY_HOST || '127.0.0.1',
        url: '',
        certSource: '',
        certFile: '',
        keyFile: '',
      },
      authTokenMasked: maskToken(resolvePrimaryAuthToken().token),
    };
  }
}

module.exports = {
  start,
  stop,
  // Exposed for unit tests (codex/Responses streaming golden-sequence asserts).
  handleMultiProtocol,
  isRunning,
  getPort,
  getRuntimeStatus,
  getAuthStatus,
  setAuthToken,
  rotateAuthToken,
  listManagedTokens,
  createManagedToken,
  setManagedTokenEnabled,
  deleteManagedToken,
  rotateManagedToken,
  normalizeAuthToken,
};
