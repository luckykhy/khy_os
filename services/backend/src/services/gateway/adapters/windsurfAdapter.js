/**
 * Windsurf IDE Adapter — connect to Windsurf (Codeium) IDE's AI models.
 *
 * Reads Windsurf's auth token from local storage and provides
 * access to its built-in AI capabilities.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');
// Model-name SSOT: default IDE model flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');
const { attachImagesToOpenAIMessages } = require('./_imageCompat');
const { resolveMessages } = require('./_messageBuilder');
const { requestJson } = require('./_proxyTunnel');
const { parseList, dedupe } = require('./_adapterUtils');
const { consumeSseText } = require('./_sseParser');
const { anthropicToOpenAI, openAIToolCallsToAnthropic, convertMessagesAnthropicToOpenAI } = require('./_toolSchemaConverter');
const { createProtocolHandler } = require('./_protocolPipeline');
const {
  normalizeToken, isLikelyCredentialToken, isTokenExpired, dedupeTokens,
  isNativeLoginToken, countsTowardAvailability,
  extractMessageText, mergeAttempts,
  readWebReadableAsText, readWebReadableAsSse,
  normalizeModelId, canonicalModelKey, extractModelIdsFromString,
  discoverModelsFromSnapshots, buildModelList,
  createTokenManager,
} = require('./_ideTokenMixin');
const { buildSuccess, buildFailure } = require('./_responseBuilder');

const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'windsurf' });

const WINDSURF_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  // Legacy Codeium paths
  path.join(os.homedir(), '.config', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Codeium', 'User', 'globalStorage', 'storage.json'),
];

const KNOWN_MODELS = [
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', isDefault: false },
  { id: 'windsurf-cascade', name: 'Windsurf Cascade', isDefault: false },
  { id: 'swe-1.6', name: 'SWE-1.6', isDefault: false },
  { id: 'swe-1.6-m1.5', name: 'SWE-1.6 M1.5', isDefault: false },
  { id: 'kimi2.6', name: 'Kimi2.6', isDefault: false },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', isDefault: false },
];

const { DEFAULT_TIMEOUT_MS } = require('./_protocolPipeline');
const TIMEOUT_MS = parseInt(process.env.WINDSURF_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
const MODEL_TOKEN_REGEX = /\b[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}\b/g;
const MODEL_DISCOVERY_CACHE_MS = Math.max(5000, parseInt(process.env.WINDSURF_MODEL_CACHE_MS || '120000', 10) || 120000);
const WINDSURF_DEFAULT_MODELS_ENDPOINTS = [
  'https://api.codeium.com/windsurf/v1/models',
  'https://api.codeium.com/v1/models',
];
const WINDSURF_DEFAULT_CHAT_ENDPOINTS = [
  'https://api.codeium.com/windsurf/v1/chat/completions',
  'https://api.codeium.com/v1/chat/completions',
];

let _available = null;
let _token = null;
let _models = [];
let _installPath = null;
let _modelsFetchedAt = 0;
const ACCOUNT_POOL_TYPE = 'windsurf';
let _lastDiscoveryMeta = {
  at: 0,
  officialHit: false,
  officialEndpoint: '',
  officialCount: 0,
  localCount: 0,
  mergedCount: 0,
  error: '',
  mode: 'http',
};
let _sdkLoadTried = false;
let _sdkModule = null;
let _sdkLoadError = null;
let _sdkClient = null;
let _sdkClientEndpoint = '';


function normalizeEndpointBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  let value = text;
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value.replace(/^\/+/, '')}`;
  }

  try {
    const parsed = new URL(value);
    const pathname = String(parsed.pathname || '').replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return '';
  }
}

function normalizeApiEndpoint(raw, type = 'chat') {
  const base = normalizeEndpointBase(raw);
  if (!base) return '';

  const isChat = type === 'chat';
  const hasChat = /\/chat\/completions$/i.test(base);
  const hasModels = /\/models$/i.test(base);
  if ((isChat && hasChat) || (!isChat && hasModels)) return base;

  const suffix = isChat ? '/chat/completions' : '/models';
  return `${base.replace(/\/+$/, '')}${suffix}`;
}

function resolveWindsurfModelsEndpoints(tokenData = null) {
  const envEndpoints = [
    ...parseList(process.env.WINDSURF_MODELS_ENDPOINTS),
    ...parseList(process.env.WINDSURF_MODELS_ENDPOINT),
    ...parseList(process.env.WINDSURF_API_MODELS_ENDPOINT),
  ];
  const tokenEndpoints = [
    tokenData?.modelsEndpoint,
    tokenData?.endpoint,
    tokenData?.host,
    tokenData?.baseUrl,
    tokenData?.baseURL,
  ];
  return dedupe([
    ...envEndpoints,
    ...tokenEndpoints,
    ...WINDSURF_DEFAULT_MODELS_ENDPOINTS,
  ].map(v => normalizeApiEndpoint(v, 'models')).filter(Boolean));
}

function resolveWindsurfChatEndpoints(tokenData = null) {
  const envEndpoints = [
    ...parseList(process.env.WINDSURF_CHAT_ENDPOINTS),
    ...parseList(process.env.WINDSURF_CHAT_ENDPOINT),
    ...parseList(process.env.WINDSURF_API_CHAT_ENDPOINT),
    ...parseList(process.env.WINDSURF_API_ENDPOINT),
  ];
  const tokenEndpoints = [
    tokenData?.chatEndpoint,
    tokenData?.endpoint,
    tokenData?.host,
    tokenData?.baseUrl,
    tokenData?.baseURL,
  ];
  return dedupe([
    ...envEndpoints,
    ...tokenEndpoints,
    ...WINDSURF_DEFAULT_CHAT_ENDPOINTS,
  ].map(v => normalizeApiEndpoint(v, 'chat')).filter(Boolean));
}

function toRelayEndpointBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const normalized = normalizeEndpointBase(text);
  if (!normalized) return '';
  return normalized.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

function jsonRequest(url, { method = 'GET', headers = {}, body = null, timeout = 12000 } = {}) {
  return requestJson(
    url,
    {
      method,
      timeout,
      headers: sanitizeOutgoingHeaders(headers),
      body,
    },
    {
      namespace: 'windsurf',
      envKeys: ['WINDSURF_HTTP_PROXY', 'WINDSURF_HTTPS_PROXY', 'WINDSURF_PROXY', 'WINDSURF_ALL_PROXY'],
      autoEnvKey: 'WINDSURF_AUTO_PROXY',
      portsEnvKey: 'WINDSURF_AUTO_PROXY_PORTS',
    }
  );
}

function isLikelyModelId(id) {
  const normalized = normalizeModelId(id);
  const model = normalized.toLowerCase();
  if (!model) return false;
  if (model.length < 3 || model.length > 96) return false;
  if (model.startsWith('http') || model.includes('@') || model.includes('\\')) return false;
  if (/[^a-z0-9._:-]/i.test(model)) return false;
  if (model === 'windsurf-cascade' || model === 'cursor-small') return true;
  if (!/\d/.test(model)) return false;
  return /(gpt|claude|o[1-9]|gemini|deepseek|qwen|glm|doubao|llama|mistral|moonshot|yi|ernie|copilot|cursor|codeium|kimi|swe|sonnet|haiku|opus|cascade)/i.test(model);
}

function modelDisplayName(id) {
  const normalized = normalizeModelId(id);
  const key = canonicalModelKey(normalized);
  const known = KNOWN_MODELS.find(m => canonicalModelKey(m.id) === key);
  if (known?.name) return known.name;
  if (/^swe[._-]?\d/i.test(normalized)) return normalized.toUpperCase().replace(/^SWE([._-]?)/, 'SWE$1');
  if (/^kimi/i.test(normalized)) return normalized.replace(/^kimi/i, 'Kimi');
  if (/^gpt/i.test(normalized)) return normalized.replace(/^gpt/i, 'GPT');
  if (/^claude/i.test(normalized)) return normalized.replace(/^claude/i, 'Claude');
  return normalized;
}

function readWindsurfStorageSnapshots() {
  const snapshots = [];
  for (const p of WINDSURF_STORAGE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      snapshots.push({ path: p, data });
    } catch { /* skip */ }
  }
  return snapshots;
}

function detectWindsurfInstallation() {
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    return findInstallation('windsurf') || findDataPath('windsurf') || null;
  } catch {
    return null;
  }
}

function readWindsurfToken() {
  const snapshots = readWindsurfStorageSnapshots();
  for (const snapshot of snapshots) {
    const data = snapshot.data || {};
    const token = data.windsurfAuth?.accessToken
      || data['windsurfAuth/accessToken']
      || data['windsurf.auth']?.accessToken
      || data['windsurf.auth.accessToken']
      || data['codeium/accessToken']
      || data['codeium.auth']?.accessToken
      || data['codeium.auth.accessToken']
      || data.accessToken;
    if (isLikelyCredentialToken(token)) {
      const endpoint = normalizeEndpointBase(
        data.windsurfAuth?.endpoint
        || data.windsurfAuth?.host
        || data['windsurf.auth']?.endpoint
        || data['windsurf.auth']?.host
        || data['codeium.auth']?.endpoint
        || data['codeium.auth']?.host
        || data.endpoint
        || data.baseUrl
        || data.baseURL
      );
      return {
        accessToken: normalizeToken(token),
        refreshToken: data.windsurfAuth?.refreshToken
          || data['windsurfAuth/refreshToken']
          || data['windsurf.auth']?.refreshToken
          || data['codeium.auth']?.refreshToken
          || null,
        source: path.basename(path.dirname(path.dirname(path.dirname(snapshot.path)))),
        path: snapshot.path,
        expiresAt: data.windsurfAuth?.expiresAt
          || data['windsurfAuth/expiresAt']
          || data['windsurf.auth']?.expiresAt
          || data['codeium.auth']?.expiresAt
          || null,
        endpoint,
        sdkEndpoint: data.windsurfAuth?.sdkEndpoint
          || data['windsurf.auth']?.sdkEndpoint
          || data['codeium.auth']?.sdkEndpoint
          || null,
      };
    }
  }
  return null;
}

const _tokenMgr = createTokenManager({
  poolType: ACCOUNT_POOL_TYPE,
  envPrefix: 'WINDSURF',
  readTokenFn: readWindsurfToken,
  normalizeEndpointBaseFn: normalizeEndpointBase,
});

async function getTokenCandidates() {
  const localToken = readWindsurfToken();
  const poolToken = await _tokenMgr.getPoolActiveToken();
  const currentToken = (_token && _token.accessToken) ? _token : null;

  if (localToken && localToken.accessToken) {
    _tokenMgr.persistObservedToken(localToken);
  }

  const ordered = _tokenMgr.resolveTokenPriority() === 'local-first'
    ? [localToken, poolToken, currentToken]
    : [poolToken, localToken, currentToken];
  return dedupeTokens(ordered);
}

async function selectToken({ allowExpired = false } = {}) {
  const candidates = await getTokenCandidates();
  if (candidates.length === 0) {
    return { token: null, fallback: null, candidates: [] };
  }

  const nonExpired = candidates.filter(t => !isTokenExpired(t));
  const token = nonExpired[0] || (allowExpired ? candidates[0] : null);
  if (!token) {
    return { token: null, fallback: null, candidates };
  }

  const fallback = nonExpired.find(t => t.accessToken !== token.accessToken) || null;
  return { token, fallback, candidates };
}

function parseApiModels(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const candidates = []
    .concat(Array.isArray(data.models) ? data.models : [])
    .concat(Array.isArray(data.data) ? data.data : [])
    .concat(Array.isArray(data.availableModels) ? data.availableModels : [])
    .concat(Array.isArray(data.result?.models) ? data.result.models : []);
  const defaultHint = data.defaultModel
    || data.default
    || data.defaultModelId
    || data.result?.defaultModel
    || data.result?.defaultModelId
    || null;

  const found = [];
  for (const item of candidates) {
    if (!item) continue;
    if (typeof item === 'string') {
      const id = normalizeModelId(item);
      if (isLikelyModelId(id)) found.push({ id, name: modelDisplayName(id) });
      continue;
    }
    if (typeof item === 'object') {
      const rawId = item.id || item.model || item.modelId || item.name || '';
      const id = normalizeModelId(rawId);
      if (!isLikelyModelId(id)) continue;
      const name = normalizeModelId(item.displayName || item.modelName || item.name) || modelDisplayName(id);
      found.push({ id, name });
    }
  }
  return {
    models: found,
    defaultModelId: normalizeModelId(defaultHint),
  };
}

async function fetchModelsFromApi(tokenData, options = {}) {
  const timeoutMs = Math.max(3000, parseInt(options.timeoutMs || '10000', 10) || 10000);
  const authHeader = `Bearer ${tokenData.accessToken}`;
  let lastErr = null;

  for (const endpoint of resolveWindsurfModelsEndpoints(tokenData)) {
    try {
      const res = await jsonRequest(endpoint, {
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          'Accept': 'application/json',
          'Authorization': authHeader,
          'x-api-key': tokenData.accessToken,
        },
      });
      if (res.status === 401 || res.status === 403) {
        const authErr = new Error(`Windsurf auth failed (${res.status})`);
        authErr.code = 'AUTH';
        throw authErr;
      }
      if (res.status < 200 || res.status >= 300) {
        lastErr = new Error(`models endpoint ${endpoint} -> HTTP ${res.status}`);
        continue;
      }
      const parsed = parseApiModels(res.data || {});
      if (parsed.models.length > 0) return { ...parsed, endpoint };
      lastErr = new Error(`models endpoint ${endpoint} returned empty model list`);
    } catch (err) {
      if (err && err.code === 'AUTH') throw err;
      lastErr = err instanceof Error ? err : new Error(String(err || 'unknown models error'));
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('models endpoint unavailable');
}

// Strict availability: a native login token (read from Windsurf's own storage)
// proves install+login. Pool/imported tokens only count when the IDE is locally
// installed AND KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS is set. `_token` is still
// kept for routing/generate regardless.
function _computeAvailable(token) {
  if (isNativeLoginToken(token)) return true;
  return !!_installPath && countsTowardAvailability(token);
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  const localToken = readWindsurfToken();
  if (localToken) {
    _token = localToken;
    _tokenMgr.persistObservedToken(localToken);
  } else if (!(_token && _token.accessToken && String(_token.source || '').startsWith('pool:'))) {
    _token = null;
  }
  _installPath = detectWindsurfInstallation();
  _available = _computeAvailable(_token);
  if (!_available) _models = [];
  return _available;
}

async function listModels() {
  detect(true);
  const selected = await selectToken({ allowExpired: true });
  if (selected.token && selected.token.accessToken) {
    _token = selected.token;
    _available = true;
    _tokenMgr.persistObservedToken(_token);
  }
  if (!_token || !_token.accessToken) {
    _models = [];
    _available = false;
    return [];
  }

  // Return cached list to reduce repeated endpoint pressure in menu refresh loops.
  if (_models.length > 0 && (Date.now() - _modelsFetchedAt) < MODEL_DISCOVERY_CACHE_MS) {
    _lastDiscoveryMeta = {
      ..._lastDiscoveryMeta,
      at: _lastDiscoveryMeta.at || Date.now(),
      mergedCount: _models.length,
    };
    return _models;
  }

  const snapshots = readWindsurfStorageSnapshots();
  const discovered = discoverModelsFromSnapshots(snapshots, { isLikelyModelIdFn: isLikelyModelId });
  const localModelIds = discovered.discoveredModelIds || [];
  let apiModels = [];
  let apiDefault = null;
  let officialHit = false;
  let officialEndpoint = '';
  let discoveryError = '';
  if (_token && _token.accessToken && !isTokenExpired(_token)) {
    try {
      const api = await fetchModelsFromApi(_token);
      apiModels = (api.models || []).map(m => m.id);
      apiDefault = api.defaultModelId || null;
      officialHit = apiModels.length > 0;
      officialEndpoint = api.endpoint || resolveWindsurfModelsEndpoints(_token)[0] || '';
    } catch (err) {
      // Auth errors should clear availability; network errors fallback to local discovery.
      discoveryError = err && err.message ? err.message : String(err || 'models discovery failed');
      if (err && err.code === 'AUTH') {
        const fallback = selected.fallback;
        if (fallback && fallback.accessToken && !isTokenExpired(fallback)) {
          try {
            _token = fallback;
            _tokenMgr.persistObservedToken(_token);
            const api = await fetchModelsFromApi(_token);
            apiModels = (api.models || []).map(m => m.id);
            apiDefault = api.defaultModelId || null;
            officialHit = apiModels.length > 0;
            officialEndpoint = api.endpoint || resolveWindsurfModelsEndpoints(_token)[0] || '';
            discoveryError = '';
          } catch (retryErr) {
            discoveryError = retryErr && retryErr.message ? retryErr.message : discoveryError;
            if (retryErr && retryErr.code === 'AUTH') {
              _available = false;
              _models = [];
              _modelsFetchedAt = Date.now();
              _lastDiscoveryMeta = {
                at: Date.now(),
                officialHit: false,
                officialEndpoint: '',
                officialCount: 0,
                localCount: localModelIds.length,
                mergedCount: 0,
                error: discoveryError,
              };
              return [];
            }
          }
        } else {
          _available = false;
          _models = [];
          _modelsFetchedAt = Date.now();
          _lastDiscoveryMeta = {
            at: Date.now(),
            officialHit: false,
            officialEndpoint: '',
            officialCount: 0,
            localCount: localModelIds.length,
            mergedCount: 0,
            error: discoveryError,
          };
          return [];
        }
      }
    }
  }

  const merged = buildModelList(
    [...apiModels, ...discovered.discoveredModelIds],
    apiDefault || discovered.defaultModelId,
    {
      knownModels: KNOWN_MODELS,
      modelDisplayNameFn: modelDisplayName,
      isLikelyModelIdFn: isLikelyModelId,
      defaultFallbackModelKey: MODELS.ide,
      apiModelIds: apiModels,
      localModelIds,
    }
  );
  _models = merged.map(m => ({
    ...m,
    provider: 'windsurf',
    description: '',
  }));
  _available = true;
  _modelsFetchedAt = Date.now();
  _lastDiscoveryMeta = {
    at: Date.now(),
    officialHit,
    officialEndpoint,
    officialCount: apiModels.length,
    localCount: localModelIds.length,
    mergedCount: _models.length,
    error: discoveryError,
  };
  return _models;
}

async function detectAsync(forceRefresh = false) {
  let ok = detect(forceRefresh);
  const selected = await selectToken({ allowExpired: false });
  if (selected.token && selected.token.accessToken) {
    _token = selected.token;
    _available = true;
    ok = true;
    _tokenMgr.persistObservedToken(_token);
  }
  if (!ok) return false;
  // Optional async validation to avoid false "available" when token expired/revoked.
  const validate = String(process.env.WINDSURF_VALIDATE_TOKEN || 'true').toLowerCase() !== 'false';
  if (!validate || !_token || !_token.accessToken) return ok;
  if (isTokenExpired(_token)) {
    _available = false;
    return false;
  }
  try {
    await fetchModelsFromApi(_token, { timeoutMs: 8000 });
    _available = true;
    return true;
  } catch (err) {
    if (err && err.code === 'AUTH') {
      if (selected.fallback && selected.fallback.accessToken && !isTokenExpired(selected.fallback)) {
        try {
          _token = selected.fallback;
          _tokenMgr.persistObservedToken(_token);
          await fetchModelsFromApi(_token, { timeoutMs: 8000 });
          _available = true;
          return true;
        } catch (retryErr) {
          if (retryErr && retryErr.code === 'AUTH') {
            _available = false;
            return false;
          }
        }
      } else {
        _available = false;
        return false;
      }
    }
    // Network errors should not force unavailable state if local login token exists.
    _available = true;
    return true;
  }
}

// buildWindsurfMessages replaced by shared _messageBuilder (Phase 5B)
function buildWindsurfMessages(prompt, options = {}) {
  let _flattenWS;
  try { _flattenWS = require('../../../services/contentBlockUtils').flattenContent; } catch { _flattenWS = (c) => String(c || ''); }

  // Flatten content blocks before resolving (Windsurf doesn't support content arrays)
  const flatOpts = { ...options };
  if (Array.isArray(flatOpts.messages)) {
    flatOpts.messages = flatOpts.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : _flattenWS(m.content),
    }));
  }
  const { messages } = resolveMessages(prompt, flatOpts, {
    protocol: 'openai',
    attachImages: attachImagesToOpenAIMessages,
  });
  return messages;
}

function resolveWindsurfSdkMode() {
  const mode = String(process.env.WINDSURF_SDK_MODE || 'auto').trim().toLowerCase();
  if (mode === 'off' || mode === 'disable' || mode === 'disabled') return 'off';
  if (mode === 'force' || mode === 'only') return 'force';
  return 'auto';
}

function resolveWindsurfInstallPaths() {
  const out = [];
  const envInstall = String(process.env.WINDSURF_INSTALL_PATH || '').trim();
  if (envInstall) out.push(envInstall);
  if (_installPath) out.push(_installPath);
  const detected = detectWindsurfInstallation();
  if (detected) out.push(detected);
  return dedupe(out);
}

function resolveWindsurfSdkModuleCandidates() {
  const out = [];
  for (const item of parseList(process.env.WINDSURF_SDK_MODULE_PATHS || process.env.WINDSURF_SDK_MODULE_PATH || '')) {
    out.push(item);
  }
  out.push('@codeium/windsurf-network-client');
  out.push('@exafunction/windsurf-network-client');
  out.push('@windsurf/network-client');
  out.push('@windsurf-ai/network-client');
  out.push('@codeium/network-client');

  const installs = resolveWindsurfInstallPaths();
  const packageNames = [
    '@codeium/windsurf-network-client',
    '@exafunction/windsurf-network-client',
    '@windsurf/network-client',
    '@windsurf-ai/network-client',
    '@codeium/network-client',
  ];
  for (const root of installs) {
    for (const pkgName of packageNames) {
      const pkgParts = pkgName.split('/');
      out.push(path.join(root, 'resources', 'app', 'node_modules', ...pkgParts));
    }
  }
  return dedupe(out);
}

function normalizeSdkModule(rawModule) {
  if (!rawModule) return null;
  if (rawModule.default && typeof rawModule.default === 'object') {
    return { ...rawModule.default, ...rawModule };
  }
  return rawModule;
}

function loadWindsurfSdkModule() {
  if (_sdkLoadTried) return _sdkModule;
  _sdkLoadTried = true;

  const errors = [];
  for (const candidate of resolveWindsurfSdkModuleCandidates()) {
    try {
      const loaded = normalizeSdkModule(require(candidate));
      if (!loaded || typeof loaded !== 'object') {
        errors.push(`invalid exports: ${candidate}`);
        continue;
      }

      const hasFetchLike = typeof loaded.fetch === 'function'
        || typeof loaded.request === 'function'
        || typeof loaded.createClient === 'function'
        || typeof loaded.ZmqClient === 'function'
        || typeof loaded.WindsurfClient === 'function';
      if (!hasFetchLike) {
        errors.push(`unsupported exports: ${candidate}`);
        continue;
      }

      _sdkModule = loaded;
      _sdkLoadError = null;
      return _sdkModule;
    } catch (err) {
      errors.push(`${candidate}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  _sdkModule = null;
  _sdkLoadError = errors.join(' | ');
  return null;
}

function resolveWindsurfSdkEndpoints(tokenData = null) {
  const endpoints = [
    ...parseList(process.env.WINDSURF_SDK_ENDPOINTS || process.env.WINDSURF_SDK_ENDPOINT || ''),
    tokenData?.sdkEndpoint || '',
    tokenData?.socketEndpoint || '',
  ];

  // Windows 上 ZMQ 的 IPC transport 不可用（Rust panic 无法被 JS catch 捕获）
  if (process.platform !== 'win32') {
    endpoints.push('ipc:///tmp/windsurf.sock');
  }

  const resolved = dedupe(endpoints.map(v => String(v || '').trim()).filter(Boolean));

  if (process.platform === 'win32') {
    return resolved.filter(ep => !ep.startsWith('ipc://'));
  }

  return resolved;
}

function createWindsurfSdkClientForEndpoint(sdk, endpoint) {
  const creators = [
    () => (typeof sdk.ZmqClient === 'function' ? new sdk.ZmqClient(endpoint) : null),
    () => (typeof sdk.WindsurfClient === 'function' ? new sdk.WindsurfClient(endpoint) : null),
    () => (typeof sdk.CodeiumClient === 'function' ? new sdk.CodeiumClient(endpoint) : null),
    () => (typeof sdk.createClient === 'function' ? sdk.createClient(endpoint) : null),
    () => (typeof sdk.createClient === 'function' ? sdk.createClient({ endpoint }) : null),
  ];
  for (const create of creators) {
    try {
      const client = create();
      if (client) return client;
    } catch {
      // try next creator
    }
  }
  return null;
}

function getWindsurfSdkClient(tokenData = null) {
  const sdk = loadWindsurfSdkModule();
  if (!sdk) return null;

  const endpoints = resolveWindsurfSdkEndpoints(tokenData);
  if (_sdkClient && _sdkClientEndpoint && endpoints.includes(_sdkClientEndpoint)) {
    return { sdk, client: _sdkClient, endpoint: _sdkClientEndpoint };
  }

  for (const endpoint of endpoints) {
    const client = createWindsurfSdkClientForEndpoint(sdk, endpoint);
    if (!client) continue;
    _sdkClient = client;
    _sdkClientEndpoint = endpoint;
    return { sdk, client, endpoint };
  }

  if (typeof sdk.fetch === 'function' || typeof sdk.request === 'function') {
    return { sdk, client: null, endpoint: '' };
  }
  return null;
}

function getHeaderValue(headers, key) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(key) || headers.get(String(key || '').toLowerCase()) || '');
  const direct = headers[key] ?? headers[String(key || '').toLowerCase()];
  if (Array.isArray(direct)) return direct.join(', ');
  return String(direct || '');
}

function getResponseStatusCode(res) {
  return Number(res?.status || res?.statusCode || 0);
}

async function readSdkResponseText(res) {
  if (!res) return '';
  if (typeof res.text === 'function') {
    try { return await res.text(); } catch { /* ignore */ }
  }
  if (res.body) {
    try { return await readWebReadableAsText(res.body); } catch { /* ignore */ }
  }
  if (typeof res.data === 'string') return res.data;
  if (Buffer.isBuffer(res.data)) return res.data.toString('utf8');
  return '';
}

async function trySdkFetch(sdk, client, url, requestOptions) {
  const attempts = [];
  if (typeof sdk.fetch === 'function') {
    attempts.push(() => sdk.fetch(client, url, requestOptions));
    attempts.push(() => sdk.fetch(url, { ...requestOptions, client }));
    attempts.push(() => sdk.fetch(url, requestOptions));
  }
  if (typeof sdk.request === 'function') {
    attempts.push(() => sdk.request(client, url, requestOptions));
    attempts.push(() => sdk.request(url, { ...requestOptions, client }));
    attempts.push(() => sdk.request(url, requestOptions));
  }
  if (client && typeof client.fetch === 'function') {
    attempts.push(() => client.fetch(url, requestOptions));
  }
  if (client && typeof client.request === 'function') {
    attempts.push(() => client.request(url, requestOptions));
  }

  let lastErr = null;
  for (const run of attempts) {
    try {
      const res = await run();
      if (res) return res;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('windsurf sdk does not expose a usable fetch interface');
}

async function callWindsurfBySdk(tokenData, prompt, model, options = {}) {
  const sdkCtx = getWindsurfSdkClient(tokenData);
  if (!sdkCtx) {
    return buildFailure(
      _sdkLoadError ? `Windsurf SDK unavailable: ${_sdkLoadError}` : 'Windsurf SDK unavailable',
      { adapter: 'windsurf', provider: 'Windsurf', model, errorType: 'unavailable', attempts: [{ provider: 'Windsurf(SDK)', success: false, error: 'sdk_unavailable' }] }
    );
  }

  const { sdk, client, endpoint: sdkEndpoint } = sdkCtx;
  const openaiTools = anthropicToOpenAI(options.tools);
  const useStream = !openaiTools && (options.stream === true || typeof options.onChunk === 'function');
  let messages = buildWindsurfMessages(prompt, options);
  if (openaiTools) messages = convertMessagesAnthropicToOpenAI(messages, true);
  const payload = { model, messages, stream: useStream };
  if (openaiTools) payload.tools = openaiTools;

  const attempts = [];
  for (const endpoint of resolveWindsurfChatEndpoints(tokenData)) {
    try {
      const res = await trySdkFetch(sdk, client, endpoint, {
        method: 'POST',
        headers: sanitizeOutgoingHeaders({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.accessToken}`,
          'x-api-key': tokenData.accessToken,
        }),
        body: JSON.stringify(payload),
      });

      const statusCode = getResponseStatusCode(res);
      if (statusCode === 401 || statusCode === 403) {
        return buildFailure(
          `Windsurf SDK auth failed (${statusCode})`,
          { adapter: 'windsurf', provider: 'Windsurf', errorType: 'auth', statusCode, attempts: mergeAttempts(attempts, [{ provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`, success: false, error: `auth failed (${statusCode})`, statusCode }]) }
        );
      }

      const contentType = String(getHeaderValue(res.headers, 'content-type') || '').toLowerCase();
      if (useStream || contentType.includes('text/event-stream')) {
        let content = '';
        if (res.body) {
          content = (await readWebReadableAsSse(res.body, options.onChunk)).trim();
        } else {
          const bodyText = await readSdkResponseText(res);
          content = consumeSseText(bodyText, options.onChunk).trim();
        }
        if (content) {
          return buildSuccess(content, {
            adapter: 'windsurf', provider: `Windsurf SDK (${model})`, model,
            attempts: mergeAttempts(attempts, [{ provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`, success: true }]),
          });
        }
        attempts.push({ provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`, success: false, error: `empty stream from ${endpoint}` });
        continue;
      }

      const bodyText = await readSdkResponseText(res);
      let json = null;
      try { json = JSON.parse(bodyText); } catch { json = null; }
      const text = extractMessageText(json || {}).trim();
      const sdkChoice = json?.choices?.[0];
      const sdkToolUseBlocks = sdkChoice ? openAIToolCallsToAnthropic(sdkChoice) : [];
      if (text || sdkToolUseBlocks.length > 0) {
        return buildSuccess(text, {
          adapter: 'windsurf', provider: `Windsurf SDK (${model})`, model,
          toolUseBlocks: sdkToolUseBlocks,
          stopReason: sdkToolUseBlocks.length > 0 ? undefined : (sdkChoice?.finish_reason || undefined),
          attempts: mergeAttempts(attempts, [{ provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`, success: true }]),
        });
      }

      attempts.push({
        provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`,
        success: false,
        error: json?.error?.message || `invalid response (${statusCode})`,
        statusCode,
      });
    } catch (err) {
      attempts.push({ provider: `Windsurf(SDK:${sdkEndpoint || 'default'})`, success: false, error: err?.message || String(err) });
    }
  }

  return buildFailure(
    attempts[attempts.length - 1]?.error || 'Windsurf SDK request failed',
    { adapter: 'windsurf', provider: 'Windsurf', errorType: 'network', attempts }
  );
}

function callWindsurfByHttp(tokenData, prompt, model, options = {}) {
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
  // Disable streaming when tools are present (tool_calls require non-streaming parsing)
  const useStream = !hasTools && (options.stream === true || typeof options.onChunk === 'function');

  // Pre-flatten content blocks (Windsurf doesn't support content arrays)
  let _flattenWS;
  try { _flattenWS = require('../../../services/contentBlockUtils').flattenContent; } catch { _flattenWS = (c) => String(c || ''); }
  const flatOpts = { ...options, model, stream: useStream };
  if (Array.isArray(flatOpts.messages)) {
    flatOpts.messages = flatOpts.messages.map(m => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : _flattenWS(m.content),
    }));
  }

  const { body: payload } = _openaiHandler.buildRequestBody(prompt, flatOpts);
  const endpoints = resolveWindsurfChatEndpoints(tokenData);
  const attempts = [];

  const runOne = (index) => {
    if (index >= endpoints.length) {
      return Promise.resolve(buildFailure(
        attempts[attempts.length - 1]?.error || 'Windsurf HTTP request failed',
        { adapter: 'windsurf', provider: 'Windsurf', errorType: 'network', attempts }
      ));
    }

    const endpoint = endpoints[index];
    return jsonRequest(endpoint, {
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'x-api-key': tokenData.accessToken,
      },
      body: payload,
    }).then(async (res) => {
      const statusCode = Number(res.status || 0);
      if (statusCode === 401 || statusCode === 403) {
        return buildFailure(
          `Windsurf auth failed (${statusCode})`,
          { adapter: 'windsurf', provider: 'Windsurf', errorType: 'auth', statusCode, attempts: mergeAttempts(attempts, [{ provider: 'Windsurf(HTTP)', success: false, error: `auth failed (${statusCode})`, statusCode }]) }
        );
      }
      if (statusCode < 200 || statusCode >= 300) {
        attempts.push({ provider: 'Windsurf(HTTP)', success: false, error: `HTTP ${statusCode}`, statusCode });
        return runOne(index + 1);
      }

      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const streamLike = useStream || contentType.includes('text/event-stream');
      const dataText = String(res.raw || '');

      if (streamLike) {
        const streamedText = consumeSseText(dataText, options.onChunk).trim();
        if (streamedText) {
          return buildSuccess(streamedText, {
            adapter: 'windsurf', provider: `Windsurf (${model})`, model,
            attempts: mergeAttempts(attempts, [{ provider: 'Windsurf(HTTP)', success: true }]),
          });
        }
      }

      const json = res.data || {};
      const parsed = _openaiHandler.parseJsonResponse(json);
      if (parsed.content || parsed.toolUseBlocks.length > 0) {
        return buildSuccess(parsed.content, {
          adapter: 'windsurf', provider: `Windsurf (${model})`, model: parsed.model || model,
          toolUseBlocks: parsed.toolUseBlocks,
          stopReason: parsed.toolUseBlocks.length > 0 ? undefined : (parsed.stopReason || undefined),
          attempts: mergeAttempts(attempts, [{ provider: 'Windsurf(HTTP)', success: true }]),
        });
      }

      const errorText = json.error?.message || `invalid response (${statusCode})`;
      attempts.push({ provider: 'Windsurf(HTTP)', success: false, error: errorText, statusCode });
      return runOne(index + 1);
    }).catch(async (err) => {
      attempts.push({ provider: 'Windsurf(HTTP)', success: false, error: err?.message || String(err) });
      return runOne(index + 1);
    });
  };

  return runOne(0);
}

async function generate(prompt, options = {}) {
  const selected = await selectToken({ allowExpired: true });
  if (selected.token && selected.token.accessToken) {
    _token = selected.token;
    _available = true;
    _tokenMgr.persistObservedToken(_token);
  }
  if (!_token || !_token.accessToken) {
    return buildFailure('Windsurf token not found', {
      adapter: 'windsurf', provider: 'Windsurf',
      attempts: [{ provider: 'Windsurf', success: false, error: 'No token' }],
    });
  }

  if (isTokenExpired(_token)) {
    return buildFailure('Windsurf token expired — please re-login in Windsurf IDE', {
      adapter: 'windsurf', provider: 'Windsurf', errorType: 'auth',
      attempts: [{ provider: 'Windsurf', success: false, error: 'token expired' }],
    });
  }
  if (!isLikelyCredentialToken(_token.accessToken)) {
    return {
      success: false,
      content: 'Windsurf token invalid — please refresh account pool/import data',
      provider: 'Windsurf',
      adapter: 'windsurf',
      errorType: 'auth',
      attempts: [{ provider: 'Windsurf', success: false, error: 'invalid token shape' }],
    };
  }

  const defaultModel = (_models.find(m => m.isDefault) || _models[0] || {}).id || MODELS.ide;
  const model = options.model || defaultModel;

  const sdkMode = resolveWindsurfSdkMode();
  let sdkResult = null;
  if (sdkMode !== 'off') {
    sdkResult = await callWindsurfBySdk(_token, prompt, model, options);
    if (sdkResult.success) return sdkResult;
    if (sdkMode === 'force') return sdkResult;
  }

  let result = await callWindsurfByHttp(_token, prompt, model, options);
  if (result.success) return result;

  if (result.errorType === 'auth' && selected.fallback && selected.fallback.accessToken && !isTokenExpired(selected.fallback)) {
    _token = selected.fallback;
    _tokenMgr.persistObservedToken(_token);
    const retry = await callWindsurfByHttp(_token, prompt, model, options);
    if (retry.success) {
      retry.attempts = mergeAttempts(sdkResult?.attempts, result.attempts, retry.attempts);
      return retry;
    }
    return {
      ...retry,
      attempts: mergeAttempts(sdkResult?.attempts, result.attempts, retry.attempts),
    };
  }

  if (sdkResult) {
    result.attempts = mergeAttempts(sdkResult.attempts, result.attempts);
  }
  return result;
}

function getStatus() {
  detect(true);
  const modelCount = _models.length || KNOWN_MODELS.length;
  const sdk = loadWindsurfSdkModule();
  let detail = '';
  if (_available) {
    detail = `Token 有效 (${modelCount} 个模型)`;
  } else if (_installPath) {
    detail = '检测到 Windsurf 已安装，但未检测到登录 token — 请先在 Windsurf IDE 登录';
  } else {
    detail = '未检测到 Windsurf 安装或 token';
  }
  return {
    name: 'Windsurf IDE',
    type: 'windsurf',
    available: _available,
    detail,
    tokenPath: _token?.path || '',
    tokenSource: _token?.source || '',
    sdk: {
      available: !!sdk,
      endpoint: _sdkClientEndpoint || '',
      error: sdk ? '' : (_sdkLoadError || ''),
      mode: resolveWindsurfSdkMode(),
    },
    officialModels: {
      hit: !!_lastDiscoveryMeta.officialHit,
      endpoint: _lastDiscoveryMeta.officialEndpoint || '',
      officialCount: _lastDiscoveryMeta.officialCount || 0,
      localCount: _lastDiscoveryMeta.localCount || 0,
      mergedCount: _lastDiscoveryMeta.mergedCount || modelCount,
      error: _lastDiscoveryMeta.error || '',
      at: _lastDiscoveryMeta.at || 0,
      mode: _lastDiscoveryMeta.mode || 'http',
    },
  };
}

function destroy() {
  _available = null;
  _token = null;
  _models = [];
  _installPath = null;
  _modelsFetchedAt = 0;
  _lastDiscoveryMeta = {
    at: 0,
    officialHit: false,
    officialEndpoint: '',
    officialCount: 0,
    localCount: 0,
    mergedCount: 0,
    error: '',
    mode: 'http',
  };
  try {
    if (_sdkClient && typeof _sdkClient.close === 'function') {
      _sdkClient.close();
    }
  } catch {
    // ignore sdk close errors
  }
  _sdkClient = null;
  _sdkClientEndpoint = '';
  _sdkLoadTried = false;
  _sdkModule = null;
  _sdkLoadError = null;
}

/**
 * Build an OpenAI-compatible relay profile from current Windsurf login state.
 * Used by `proxy windsurf-switch` to expose Windsurf models via local proxy.
 */
async function getRelayProfile(options = {}) {
  const selected = await selectToken({ allowExpired: false });
  if (!selected.token || !selected.token.accessToken) {
    throw new Error('Windsurf token not found. Please login in Windsurf IDE first.');
  }
  _token = selected.token;
  _available = true;
  _tokenMgr.persistObservedToken(_token);

  if (isTokenExpired(_token)) {
    throw new Error('Windsurf token expired. Please re-login in Windsurf IDE.');
  }

  const models = await listModels();
  const modelIds = (Array.isArray(models) ? models : [])
    .map(m => normalizeModelId(m?.id || ''))
    .filter(Boolean);
  if (modelIds.length === 0) {
    throw new Error('No Windsurf models discovered from current account.');
  }

  const defaultModel = normalizeModelId(
    options.defaultModel
    || options.model
    || (models.find(m => m && m.isDefault) || {}).id
    || modelIds[0]
  ) || modelIds[0];

  const endpointOverride = toRelayEndpointBase(options.endpoint || options.baseUrl || options.base || '');
  const endpointFromToken = toRelayEndpointBase(_token.endpoint || '');
  const endpointFromChat = toRelayEndpointBase(resolveWindsurfChatEndpoints(_token)[0] || '');
  const endpoint = endpointOverride
    || endpointFromToken
    || endpointFromChat
    || 'https://api.codeium.com/windsurf/v1';

  const modelMap = {};
  for (const id of modelIds) modelMap[id] = id;

  return {
    id: String(options.id || 'windsurf-auto').trim() || 'windsurf-auto',
    name: String(options.name || 'Windsurf Auto').trim() || 'Windsurf Auto',
    endpoint,
    key: String(options.key || '').trim() || _token.accessToken,
    models: modelIds,
    modelMap,
    defaultModel,
    source: _token.source || '',
    path: _token.path || '',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { detect, detectAsync, listModels, generate, getStatus, destroy, getRelayProfile };
