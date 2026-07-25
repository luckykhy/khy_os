/**
 * OAuth Manager — unified token lifecycle for AI providers.
 *
 * Supports:
 * - Kiro: AWS OIDC / Google OAuth PKCE → refreshToken flow
 * - Codex: OpenAI Device Code → grant_type=refresh_token
 * - Gemini: Google OAuth2 → refresh_token endpoint
 * - Qwen: Device Code → re-authorization (no refresh)
 *
 * Tokens are stored in ~/.khyquant/oauth_tokens.json (file mode 0o600).
 * The storage path can be overridden with the OAUTH_TOKENS_PATH env var
 * (mirrors GATEWAY_PLUGINS_DIR in pluginChain) so each service/container can
 * point at its own data volume and tests can target a temp file.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const TOKEN_PATH = process.env.OAUTH_TOKENS_PATH
  ? path.resolve(process.env.OAUTH_TOKENS_PATH.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), '.khyquant', 'oauth_tokens.json');
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

let _tokens = null;
let _providers = {};
let _refreshTimers = {};

// ── Provider Configurations ──

const PROVIDER_CONFIGS = {
  kiro: {
    name: 'Kiro',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
    scopes: ['openid', 'profile', 'email'],
    supportsRefresh: true,
  },
  codex: {
    name: 'Codex',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    revokeEndpoint: null,
    scopes: ['openid', 'offline_access'],
    supportsRefresh: true,
  },
  gemini: {
    name: 'Gemini',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
    scopes: ['https://www.googleapis.com/auth/generative-language'],
    supportsRefresh: true,
  },
  qwen: {
    name: 'Qwen',
    tokenEndpoint: null,
    revokeEndpoint: null,
    scopes: [],
    supportsRefresh: false,
  },
};

function maskCredential(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 6) return `${raw.slice(0, 2)}****`;
  return `${raw.slice(0, 4)}...${raw.slice(-2)}`;
}

// ── Token Storage ──

function loadTokens() {
  if (_tokens) return _tokens;
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      _tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    } else {
      _tokens = {};
    }
  } catch {
    _tokens = {};
  }
  return _tokens;
}

function saveTokens() {
  const dir = path.dirname(TOKEN_PATH);
  fs.mkdirSync(dir, { recursive: true });
  // Create with 0o600, then explicitly chmod so an already-existing file is
  // also tightened (writeFileSync mode only applies on creation). The chmod is
  // best-effort: it is a no-op / throws on Windows NTFS, which we swallow.
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(_tokens, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch { /* non-fatal: unsupported FS/OS */ }
}

// ── HTTP Helper ──

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const postData = typeof body === 'string' ? body : new URLSearchParams(body).toString();

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ── Core Operations ──

/**
 * Register a provider's OAuth configuration.
 * @param {string} provider - Provider key (kiro, codex, gemini, qwen)
 * @param {object} config - { clientId, clientSecret, refreshToken, accessToken, expiresAt }
 */
function registerProvider(provider, config) {
  const tokens = loadTokens();
  const existing = tokens[provider] || {};
  const normalizeText = (value, fallback = '') => {
    if (value === undefined) return fallback;
    return String(value || '').trim();
  };
  const normalizeTs = (value, fallback = 0) => {
    if (value === undefined || value === null || value === '') return fallback;
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0) return Math.floor(num);
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return fallback;
  };

  tokens[provider] = {
    clientId: normalizeText(config.clientId, normalizeText(existing.clientId, '')),
    clientSecret: normalizeText(config.clientSecret, normalizeText(existing.clientSecret, '')),
    refreshToken: normalizeText(config.refreshToken, normalizeText(existing.refreshToken, '')),
    accessToken: normalizeText(config.accessToken, normalizeText(existing.accessToken, '')),
    expiresAt: normalizeTs(config.expiresAt, normalizeTs(existing.expiresAt, 0)),
    lastRefresh: normalizeTs(config.lastRefresh, normalizeTs(existing.lastRefresh, 0)),
    error: null,
  };
  _tokens = tokens;
  saveTokens();

  // Schedule auto-refresh
  scheduleRefresh(provider);
}

/**
 * Get a valid access token for a provider (refreshing if needed).
 * @param {string} provider
 * @returns {Promise<string|null>} Access token or null if unavailable
 */
async function getToken(provider) {
  const tokens = loadTokens();
  const entry = tokens[provider];
  if (!entry) return null;

  // Check if token is still valid
  if (entry.accessToken && entry.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return entry.accessToken;
  }

  // Attempt refresh
  const refreshed = await refreshToken(provider);
  if (refreshed) return refreshed;

  // Return existing token even if potentially expired (let caller handle 401)
  return entry.accessToken || null;
}

/**
 * Refresh a provider's access token.
 * @param {string} provider
 * @returns {Promise<string|null>} New access token or null
 */
async function refreshToken(provider) {
  const tokens = loadTokens();
  const entry = tokens[provider];
  if (!entry || !entry.refreshToken) return null;

  const providerConfig = PROVIDER_CONFIGS[provider];
  if (!providerConfig || !providerConfig.supportsRefresh || !providerConfig.tokenEndpoint) {
    return null;
  }

  try {
    const body = {
      grant_type: 'refresh_token',
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
    };
    if (entry.clientSecret) body.client_secret = entry.clientSecret;

    const response = await httpPost(providerConfig.tokenEndpoint, body);

    if (response.status === 200 && response.data.access_token) {
      entry.accessToken = response.data.access_token;
      entry.expiresAt = Date.now() + (response.data.expires_in || 3600) * 1000;
      entry.lastRefresh = Date.now();
      entry.error = null;

      // Update refresh token if rotated
      if (response.data.refresh_token) {
        entry.refreshToken = response.data.refresh_token;
      }

      _tokens = tokens;
      saveTokens();
      scheduleRefresh(provider);

      return entry.accessToken;
    } else {
      entry.error = `Refresh failed: ${response.status} ${JSON.stringify(response.data).slice(0, 100)}`;
      _tokens = tokens;
      saveTokens();
      return null;
    }
  } catch (err) {
    entry.error = `Refresh error: ${err.message}`;
    _tokens = tokens;
    saveTokens();
    return null;
  }
}

/**
 * Revoke a provider's tokens.
 */
async function revokeToken(provider) {
  const tokens = loadTokens();
  const entry = tokens[provider];
  if (!entry) return;

  const providerConfig = PROVIDER_CONFIGS[provider];
  if (providerConfig?.revokeEndpoint && entry.accessToken) {
    try {
      await httpPost(providerConfig.revokeEndpoint, { token: entry.accessToken });
    } catch { /* best-effort revocation */ }
  }

  // Clear stored tokens
  delete tokens[provider];
  _tokens = tokens;
  saveTokens();

  // Cancel refresh timer
  if (_refreshTimers[provider]) {
    clearTimeout(_refreshTimers[provider]);
    delete _refreshTimers[provider];
  }
}

/**
 * Get token status for a provider.
 */
function getTokenStatus(provider) {
  const tokens = loadTokens();
  const entry = tokens[provider];
  const providerConfig = PROVIDER_CONFIGS[provider] || null;
  const providerName = providerConfig?.name || provider;
  if (!entry) {
    return {
      registered: false,
      valid: false,
      expiresIn: 0,
      lastRefresh: 0,
      error: null,
      hasRefreshToken: false,
      hasClientId: false,
      hasClientSecret: false,
      hasAccessToken: false,
      clientIdMasked: '',
      provider: providerName,
      supportsRefresh: !!providerConfig?.supportsRefresh,
    };
  }

  const now = Date.now();
  return {
    registered: true,
    valid: !!(entry.accessToken && entry.expiresAt > now),
    expiresIn: Math.max(0, Math.round((entry.expiresAt - now) / 1000)),
    lastRefresh: entry.lastRefresh,
    error: entry.error,
    hasRefreshToken: !!entry.refreshToken,
    hasClientId: !!entry.clientId,
    hasClientSecret: !!entry.clientSecret,
    hasAccessToken: !!entry.accessToken,
    clientIdMasked: maskCredential(entry.clientId || ''),
    provider: providerName,
    supportsRefresh: !!providerConfig?.supportsRefresh,
  };
}

/**
 * Get status for all registered providers.
 */
function getAllStatus() {
  const tokens = loadTokens();
  const result = {};
  for (const provider of Object.keys(PROVIDER_CONFIGS)) {
    result[provider] = getTokenStatus(provider);
  }
  for (const provider of Object.keys(tokens)) {
    if (!result[provider]) {
      result[provider] = getTokenStatus(provider);
    }
  }
  return result;
}

function getKnownProviders() {
  return Object.entries(PROVIDER_CONFIGS).reduce((acc, [key, config]) => {
    acc[key] = {
      key,
      name: config.name,
      supportsRefresh: !!config.supportsRefresh,
      scopes: Array.isArray(config.scopes) ? [...config.scopes] : [],
      tokenEndpoint: config.tokenEndpoint || null,
      revokeEndpoint: config.revokeEndpoint || null,
    };
    return acc;
  }, {});
}

/**
 * Refresh all tokens that are about to expire.
 */
async function refreshAll() {
  const tokens = loadTokens();
  const results = {};
  for (const provider of Object.keys(tokens)) {
    const entry = tokens[provider];
    if (entry.refreshToken && entry.expiresAt < Date.now() + REFRESH_BUFFER_MS) {
      results[provider] = await refreshToken(provider);
    } else {
      results[provider] = entry.accessToken || null;
    }
  }
  return results;
}

// ── Auto-Refresh Scheduling ──

function scheduleRefresh(provider) {
  if (_refreshTimers[provider]) {
    clearTimeout(_refreshTimers[provider]);
  }

  const tokens = loadTokens();
  const entry = tokens[provider];
  if (!entry || !entry.refreshToken || !entry.expiresAt) return;

  const refreshAt = entry.expiresAt - REFRESH_BUFFER_MS;
  const delay = Math.max(0, refreshAt - Date.now());

  if (delay > 0 && delay < 24 * 60 * 60 * 1000) { // Max 24h timer
    _refreshTimers[provider] = setTimeout(async () => {
      await refreshToken(provider);
    }, delay);
    // Prevent timer from keeping process alive
    if (_refreshTimers[provider].unref) _refreshTimers[provider].unref();
  }
}

/**
 * Initialize — load tokens and schedule refreshes.
 */
function init() {
  const tokens = loadTokens();
  for (const provider of Object.keys(tokens)) {
    scheduleRefresh(provider);
  }
}

module.exports = {
  getToken,
  registerProvider,
  revokeToken,
  getTokenStatus,
  getAllStatus,
  refreshToken,
  refreshAll,
  getKnownProviders,
  init,
  PROVIDER_CONFIGS,
};
