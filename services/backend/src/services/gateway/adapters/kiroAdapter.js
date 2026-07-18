/**
 * Kiro Adapter — connect to Kiro IDE's AI models via AWS CodeWhisperer.
 *
 * Reads Kiro's auth token from ~/.aws/sso/cache/kiro-auth-token.json,
 * auto-refreshes expired tokens (Social/IdC), and calls the Q Developer
 * streaming API for chat completions.
 *
 * Token logic ported from kiro-proxy (token-reader.js + q-client.js).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');
// Model-name SSOT: the "which baseline model is default" comparison flows from
// constants/models.js so switching the default tier model edits one place.
const { PRIMARY: MODELS } = require('../../../constants/models');
const {
  extractAnthropicImages,
} = require('./_anthropicFormat');
const { toAnthropicImageBlocks } = require('./_imageCompat');
const {
  buildKiroUserAgent,
  buildKiroHeaders,
  applyJitter,
  resetSession: resetFingerprintSession,
  resetAll: resetFingerprintAll,
  resetForAccount: resetFingerprintForAccount,
} = require('./_fingerprint');
const {
  normalizeToken, isLikelyCredentialToken,
  countsTowardAvailability,
} = require('./_ideTokenMixin');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { createProtocolHandler } = require('./_protocolPipeline');
const {
  getCWModule,
  resetCWModuleCache,
  repairToolUsePairing: _repairToolUsePairing,
  parseCWStreamEvents,
} = require('./_cwStreamParser');

const _cwHandler = createProtocolHandler({ protocol: 'codewhisperer', adapterName: 'kiro' });

// Proxy change listener registered at module bottom (after state variables are declared)

const KIRO_DEBUG = String(process.env.KIRO_DEBUG || '').toLowerCase() === 'true';
function debugLog(...args) { if (KIRO_DEBUG) console.log('[kiro:debug]', ...args); }

/**
 * Emit a user-visible status message.
 * Uses process event so the REPL (repl.js / liteRepl.js) can display it
 * through its rich TUI renderer instead of raw console.warn which gets
 * buried by the spinner.
 */
function _emitStatus(text) {
  console.warn(text); // fallback for non-REPL consumers (logs, tests, proxy)
  try { process.emit('khy:adapter:status', text); } catch { /* best effort */ }
}

/**
 * Emit the current active account email so the HUD can display it.
 */
function _emitAccountEmail(email) {
  if (!email) return;
  try { process.emit('khy:adapter:account-email', email); } catch { /* best effort */ }
}
const KIRO_LOGIN_URL = process.env.KIRO_LOGIN_URL || 'https://kiro.dev';
const KIRO_AUTO_OPEN_LOGIN = !/^(0|false|off)$/i.test(String(process.env.KIRO_AUTO_OPEN_LOGIN || '1').trim());
const KIRO_LOGIN_COOLDOWN_MS = Math.max(5_000, Number(process.env.KIRO_LOGIN_COOLDOWN_MS || 60_000) || 60_000);

// ── Token paths — multi-path scanning ───────────────────────────────────
const KIRO_TOKEN_FILE = 'kiro-auth-token.json';

const SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min pre-refresh buffer
// Proactive token warming (P2): how often the background warmer checks whether the
// cached token has entered the pre-expiry buffer and should be refreshed ahead of
// the next request. Min 30s; default 2 min.
const KIRO_WARM_CHECK_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.KIRO_WARM_CHECK_INTERVAL_MS || 120_000) || 120_000
);

/**
 * Return all candidate SSO cache directories.
 * On Windows, os.homedir() may differ from %USERPROFILE% when running as a
 * service or from a different user context, so we probe multiple roots.
 */
function _getSsoCacheDirs() {
  const seen = new Set();
  const dirs = [];
  const add = (d) => { const n = path.normalize(d); if (!seen.has(n)) { seen.add(n); dirs.push(n); } };
  add(path.join(os.homedir(), '.aws', 'sso', 'cache'));
  if (process.platform === 'win32') {
    const up = process.env.USERPROFILE || '';
    const hp = process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : '';
    if (up) add(path.join(up, '.aws', 'sso', 'cache'));
    if (hp) add(path.join(hp, '.aws', 'sso', 'cache'));
  }
  return dirs;
}

/**
 * Return all candidate Kiro profile.json paths (multi-platform).
 */
function _getKiroProfilePaths() {
  const seen = new Set();
  const paths = [];
  const add = (p) => { const n = path.normalize(p); if (!seen.has(n)) { seen.add(n); paths.push(n); } };
  const gs = (...segs) => path.join(...segs, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json');

  if (process.platform === 'darwin') {
    add(gs(os.homedir(), 'Library', 'Application Support'));
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    add(gs(xdg));
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    if (appData) add(gs(appData));
    if (localAppData) add(gs(localAppData));
    // Fallback: os.homedir()\AppData\Roaming (in case %APPDATA% is unset)
    add(gs(os.homedir(), 'AppData', 'Roaming'));
  }
  return paths;
}

/**
 * Return all candidate paths where Kiro auth token might exist.
 * Covers Linux, macOS, and Windows (%APPDATA%, %LOCALAPPDATA%, %USERPROFILE%,
 * %HOMEDRIVE%%HOMEPATH%).
 * Highest priority: KIRO_TOKEN_PATH env var override.
 */
function getKiroTokenCandidatePaths() {
  const seen = new Set();
  const paths = [];
  const add = (p) => {
    const norm = path.normalize(p);
    if (!seen.has(norm)) { seen.add(norm); paths.push(norm); }
  };

  // 1. Explicit env override (highest priority)
  if (process.env.KIRO_TOKEN_PATH) add(process.env.KIRO_TOKEN_PATH);

  // 2. All SSO cache dirs (handles os.homedir() vs %USERPROFILE% mismatch)
  for (const dir of _getSsoCacheDirs()) {
    add(path.join(dir, KIRO_TOKEN_FILE));
  }

  // 3. Windows extra roots: %APPDATA%\aws\..., %LOCALAPPDATA%\aws\...
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    if (appData) add(path.join(appData, 'aws', 'sso', 'cache', KIRO_TOKEN_FILE));
    if (localAppData) add(path.join(localAppData, 'aws', 'sso', 'cache', KIRO_TOKEN_FILE));
    // Kiro IDE auth storage on Windows
    if (appData) add(path.join(appData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
    if (localAppData) add(path.join(localAppData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }

  // 4. XDG config on Linux
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    add(path.join(xdg, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }

  // 5. macOS Application Support
  if (process.platform === 'darwin') {
    add(path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'auth.json'));
  }

  return paths;
}

// ── Region → endpoint ────────────────────────────────────────────────────
const REGION_ENDPOINTS = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-west-1': 'https://q.eu-west-1.amazonaws.com',
  'ap-southeast-1': 'https://q.ap-southeast-1.amazonaws.com',
  'ap-northeast-1': 'https://q.ap-northeast-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com',
  'ap-south-1': 'https://q.ap-south-1.amazonaws.com',
  'ca-central-1': 'https://q.ca-central-1.amazonaws.com',
};
const REGION_ENDPOINTS_CN = {
  'cn-north-1': 'https://q.cn-north-1.amazonaws.com.cn',
  'cn-northwest-1': 'https://q.cn-northwest-1.amazonaws.com.cn',
};
const DEFAULT_REGION = 'us-east-1';
const KIRO_VERSION = process.env.KIRO_VERSION || '0.11.107';
const TIMEOUT_MS = 120_000;
const ACCOUNT_POOL_TYPE = 'kiro';

// ── abort 透传门控(root cause A)─────────────────────────────────────────────
// KHY_KIRO_ABORT 默认 on:generate 把 options.abortSignal 透传给 AWS SDK client.send、
// 内部 120s race 与 parseCWStreamEvents。关 → 逐字节回退今日「kiro 不响应 abort」行为。绝不抛。
function _isKiroAbortEnabled() {
  try {
    return require('../../flagRegistry').isFlagEnabled('KHY_KIRO_ABORT', process.env);
  } catch {
    const raw = process.env && process.env.KHY_KIRO_ABORT;
    if (raw === undefined || raw === null) return true;
    const v = String(raw).trim().toLowerCase();
    return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
  }
}

// ── Hardcoded baseline models ────────────────────────────────────────────
// Kiro IDE hardcodes these in its model picker. We use them as fallback
// when ListAvailableModels API is unreachable (GFW, token expired, etc.).
// This ensures the adapter always shows models even without network.
const KIRO_BASELINE_MODELS = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'ultra', credit: '1.3x', region: 'overseas' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', tier: 'ultra', credit: '1.3x', region: 'overseas' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'high', credit: '1.3x', region: 'overseas' },
  { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', tier: 'high', credit: '1.3x', region: 'overseas' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', tier: 'ultra', credit: '1.3x', region: 'overseas' },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', tier: 'medium', credit: '0.4x', region: 'overseas' },
  { id: 'claude-haiku-4-5-latest', name: 'Claude Haiku 4.5', tier: 'medium', credit: '0.4x', region: 'overseas' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', tier: 'high', credit: '1.3x', region: 'overseas' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', tier: 'high', credit: '1.3x', region: 'overseas' },
  { id: 'amazon-nova-pro', name: 'Amazon Nova Pro', tier: 'high', credit: '1.0x', region: 'overseas' },
  { id: 'amazon-nova-micro', name: 'Amazon Nova Micro', tier: 'low', credit: '0.2x', region: 'overseas' },
];
// Claude models visible in Kiro IDE's model picker but often missing from
// the ListAvailableModels API response. Kiro IDE hardcodes these; we inject
// them so users can select Claude through the Kiro adapter. If the Q Developer
// API rejects a model ID at generate() time, it fails gracefully.
// Model IDs use dot notation (e.g. "claude-sonnet-4.6") matching Q Developer
// format — different from Anthropic's "claude-sonnet-4-6" dash format.
// Source: kiro-proxy q-client.js + Kiro IDE v0.11 model picker
const KIRO_INJECTED_CLAUDE_MODELS = KIRO_BASELINE_MODELS.filter(m => m.id.startsWith('claude-'));
const KIRO_INJECT_CLAUDE = !/^(0|false|off)$/i.test(
  String(process.env.KIRO_INJECT_CLAUDE_MODELS || '1').trim()
);

// ── Kiro Proxy support ──────────────────────────────────────────────────
// When set, adapter will try kiro-proxy first for model listing and chat.
// e.g. KIRO_PROXY_URL=http://localhost:3456
const KIRO_PROXY_URL = (process.env.KIRO_PROXY_URL || '').replace(/\/+$/, '');

// ── In-memory state ──────────────────────────────────────────────────────
let _cachedToken = null;
let _cachedTokenSignature = '';
let _cachedAccountIdentity = '';
let _lastTokenProbeMs = 0;
let _refreshPromise = null;
let _refreshBackoffUntil = 0; // Backoff after failed refresh attempts
let _available = null;
let _models = [];
let _modelsFetchedAt = 0;
const MODEL_CACHE_TTL = parseInt(process.env.KIRO_MODEL_CACHE_MS || '300000', 10); // 5min
let _installDetected = false;
let _sdkClient = null; // cached SDK client
let _sdkClientToken = null; // token the cached client was created with
let _lastLoginPromptAt = 0;
let _forcePoolNext = false; // set after ban/cooldown switch to force pool token on next getAccessToken()
let _pendingPersist = null; // deferred persist: only save to pool after a successful generate()
let _tokenWatchers = []; // fs.watch handles for instant token change detection
let _tokenWatchDebounce = null;
let _warmTimer = null; // proactive pre-expiry token refresh interval (P2)
let _lastWarmAt = 0;   // last successful proactive warm (for getStatus health hint)
let _lastActiveUseMs = 0; // last real generate() through kiro — gates user-visible noise & IDE auto-open
// Channel lifecycle flag, driven by the gateway (activate/deactivate). When the
// user switches to another channel, the gateway deprecates this one: background
// computation (the token file watcher) is released and the adapter's internal
// state anomalies are demoted to the background debug log instead of bubbling to
// the UI. null/true = active (default, e.g. adapter used standalone), false =
// explicitly deprecated by the gateway.
let _channelActive = true;

// User-visible status lines ("token 自动刷新", "检测到磁盘 token 变化") and Kiro IDE
// auto-open should only fire when the user is actually using Kiro (a recent
// generate()), NOT from the passive background model-refresh timer or the disk
// watcher when another provider is selected. Otherwise an idle, merely-installed
// Kiro floods the HUD and even pops the IDE open. Token caches still update
// silently in the idle case — only the noise is suppressed.
const KIRO_ACTIVE_WINDOW_MS = Math.max(60_000, Number(process.env.KIRO_ACTIVE_WINDOW_MS || 300_000) || 300_000);
function _kiroRecentlyActive() {
  return _lastActiveUseMs > 0 && (Date.now() - _lastActiveUseMs) < KIRO_ACTIVE_WINDOW_MS;
}
// Emit a status line only when Kiro was recently used; otherwise demote to debug log.
function _emitActiveStatus(text) {
  if (_kiroRecentlyActive()) _emitStatus(text);
  else debugLog(`(suppressed — kiro idle) ${text}`);
}

// Has the user EXPLICITLY switched away from Kiro (so it is a deprecated channel)?
// Used to gate WHERE internal anomalies (token refresh failure, login required)
// surface, and whether deliberate side-effects (IDE spawn) are allowed:
//   - explicitly deprecated → private problem: background debug log only, no IDE
//   - active OR auto/idle    → behave exactly as before (user-visible, side-effects ok)
//
// "Deprecated" means an explicit signal, never a mere absence of recent use:
//   (a) the gateway pushed deactivation via setChannelActive(false), or
//   (b) the live preferred-adapter env names a DIFFERENT real channel (not kiro/auto).
// Auto mode (no preference) is NOT deprecation — a deliberate foreground login
// request there must still open the IDE, matching long-standing behavior. Conflating
// "idle" with "deprecated" would wrongly mute auto-mode anomalies (regression).
function _isDeprecatedChannel() {
  if (_channelActive === false) return true;
  const pref = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
  if (pref && pref !== 'auto' && pref !== 'kiro') return true;
  return false;
}

// Surface an internal anomaly (refresh failure / login required) UNLESS Kiro is a
// deprecated channel; in that case it is the old channel's private problem and must
// not escalate to the UI main console — demote to the background debug log. The
// active channel and auto mode keep their original ERROR/WARN visibility (the hard
// constraint: never mute the active channel's critical logs).
function _emitChannelWarn(text) {
  if (_isDeprecatedChannel()) debugLog(`(suppressed — kiro deprecated channel) ${text}`);
  else console.warn(text);
}

// ── Pip-install upgrade: force token refresh ──────────────────────────────
// _bootstrap.py writes .khy_force_token_refresh when detecting a version
// upgrade. On module load, consume the marker and clear all cached state
// so the user gets a fresh token/user-ID cycle after `pip install --upgrade`.
try {
  const _backendDir = path.resolve(__dirname, '..', '..', '..', '..');
  const _refreshMarker = path.join(_backendDir, '.khy_force_token_refresh');
  if (fs.existsSync(_refreshMarker)) {
    _cachedToken = null;
    _cachedTokenSignature = '';
    _cachedAccountIdentity = '';
    _lastTokenProbeMs = 0;
    _sdkClient = null;
    _sdkClientToken = null;
    _forcePoolNext = false;
    try { fs.unlinkSync(_refreshMarker); } catch { /* best effort */ }
    debugLog('Force token refresh marker consumed (pip upgrade detected)');
  }
} catch { /* best effort — non-critical */ }

// ── HTTP proxy support (delegated to _proxyTunnel.js) ───────────────────
// Supports HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / KIRO_HTTP_PROXY for
// users behind Clash, V2Ray, or corporate proxies (common in China).

const { requestJson: _tunnelRequestJson, collectProxyCandidates } = require('./_proxyTunnel');

const KIRO_DISCOVERY_REQUIRE_PROXY = /^(1|true|yes|on)$/i.test(
  String(
    process.env.KIRO_DISCOVERY_REQUIRE_PROXY
    || process.env.KIRO_REQUIRE_PROXY_FOR_DISCOVERY
    || '0'
  ).trim()
);

const _kiroProxyOptions = {
  namespace: 'kiro',
  envKeys: ['KIRO_HTTP_PROXY', 'kiro_http_proxy'],
  autoEnabled: !/^(0|false|off)$/i.test(String(process.env.KIRO_AUTO_PROXY || '1').trim()),
  retryMs: Math.max(1000, Number(process.env.KIRO_PROXY_RETRY_MS || 60_000) || 60_000),
  routeMode: String(process.env.KIRO_PROXY_ROUTE_MODE || process.env.GATEWAY_PROXY_ROUTE_MODE || 'auto').trim().toLowerCase(),
};

/**
 * Thin wrapper over _proxyTunnel.requestJson that auto-injects Kiro headers.
 * Drop-in replacement for the old self-contained jsonRequest.
 */
function jsonRequest(url, { method = 'GET', body, headers = {}, timeout = 15000, requireProxy = false } = {}) {
  const reqHeaders = sanitizeOutgoingHeaders(buildKiroHeaders({ 'Content-Type': 'application/json', ...headers }));
  return _tunnelRequestJson(url, { method, body, headers: reqHeaders, timeout }, {
    ..._kiroProxyOptions,
    requireProxy,
  });
}

/**
 * Resolve proxy candidates for Kiro SDK agent injection.
 */
function resolveHttpProxyCandidates(targetUrl, options = {}) {
  return collectProxyCandidates({
    ..._kiroProxyOptions,
    requireProxy: options.requireProxy,
  });
}

// Quick helper: is there any route to overseas AWS endpoints?
// True if KIRO_PROXY_URL is set, or HTTPS_PROXY/Clash is available.
let _hasOverseasRoute = null; // cached; reset on refresh()
function hasOverseasRoute() {
  if (_hasOverseasRoute !== null) return _hasOverseasRoute;
  if (KIRO_PROXY_URL) { _hasOverseasRoute = true; return true; }
  const candidates = resolveHttpProxyCandidates('https://q.us-east-1.amazonaws.com');
  _hasOverseasRoute = candidates.length > 0;
  return _hasOverseasRoute;
}

// ── Token reading ────────────────────────────────────────────────────────

// hasTokenShape is replaced by isLikelyCredentialToken from _ideTokenMixin
const hasTokenShape = isLikelyCredentialToken;

function buildTokenSignature(tokenData = null) {
  if (!tokenData || !hasTokenShape(tokenData.accessToken)) return '';
  const payload = [
    normalizeToken(tokenData.accessToken),
    normalizeToken(tokenData.refreshToken),
    String(tokenData.expiresAt || ''),
    String(tokenData.profileArn || ''),
    String(tokenData.region || ''),
    String(tokenData.clientIdHash || ''),
    String(tokenData._sourcePath || ''),
    String(tokenData.email || ''),
  ].join('|');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

/**
 * Identity-only signature — changes only when the *account* changes,
 * NOT when the same account's token is refreshed/renewed.
 */
function buildAccountIdentity(tokenData = null) {
  if (!tokenData) return '';
  const parts = [
    String(tokenData.email || ''),
    String(tokenData.profileArn || ''),
    String(tokenData.accountId || ''),
    String(tokenData._sourcePath || ''),
  ].join('|');
  return crypto.createHash('sha1').update(parts).digest('hex');
}

function assignCachedToken(tokenData = null) {
  if (!tokenData || !hasTokenShape(tokenData.accessToken)) return null;
  const enriched = enrichWithProfile(tokenData);
  const nextSignature = buildTokenSignature(enriched);
  const nextIdentity = buildAccountIdentity(enriched);
  const tokenChanged = !!(
    _cachedTokenSignature
    && nextSignature
    && _cachedTokenSignature !== nextSignature
  );
  const accountChanged = !!(
    _cachedAccountIdentity
    && nextIdentity
    && _cachedAccountIdentity !== nextIdentity
  );
  _cachedToken = enriched;
  _cachedTokenSignature = nextSignature;
  _cachedAccountIdentity = nextIdentity;
  if (accountChanged) {
    // Account truly switched: invalidate model+SDK cache.
    _models = [];
    _modelsFetchedAt = 0;
    _sdkClient = null;
    _sdkClientToken = null;
    // Reset fingerprint to a deterministic identity bound to the new account's
    // email — mirrors nirvana's approach so the same account always presents
    // the same device fingerprint, reducing ban risk from device mismatch.
    resetFingerprintForAccount(enriched.email);
  } else if (tokenChanged) {
    // Same account, token refreshed — SDK client needs new bearer token
    _sdkClient = null;
    _sdkClientToken = null;
  }
  // Defer pool persistence until a successful interaction verifies the token.
  // This prevents invalid/expired tokens from polluting the account pool.
  _pendingPersist = { token: _cachedToken, activate: tokenChanged };
  // Push email to HUD status bar
  _emitAccountEmail(_cachedToken.email);
  return _cachedToken;
}

function firstNonEmpty(values = []) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

/**
 * Decode JWT payload without verification (extract claims only).
 * Returns null on any failure.
 */
function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch { return null; }
}

function extractKiroTokenPayload(raw = {}, sourcePath = '') {
  if (!raw || typeof raw !== 'object') return null;

  const nested = [
    raw,
    raw.auth,
    raw.session,
    raw.credentials,
    raw.kiroAuth,
    raw.tokenData,
  ].filter(v => v && typeof v === 'object');

  for (const node of nested) {
    const accessToken = firstNonEmpty([
      node.accessToken,
      node.access_token,
      node.authToken,
      node.idToken,
      node.token,
      node.userJwt,
    ]);
    if (!hasTokenShape(accessToken)) continue;

    // Extract email from token file fields or JWT payload
    const jwtClaims = decodeJwtPayload(accessToken);
    const email = firstNonEmpty([
      node.email, raw.email,
      node._email, raw._email,       // nirvana writes _email
      node.userEmail, raw.userEmail,
      jwtClaims?.email,
      jwtClaims?.unique_name,
      jwtClaims?.preferred_username,
    ]) || null;

    return {
      ...raw,
      ...node,
      accessToken: normalizeToken(accessToken),
      refreshToken: firstNonEmpty([node.refreshToken, node.refresh_token, raw.refreshToken, raw.refresh_token]) || null,
      expiresAt: firstNonEmpty([node.expiresAt, node.expireAt, raw.expiresAt, raw.expireAt]) || null,
      authMethod: firstNonEmpty([node.authMethod, raw.authMethod]) || null,
      provider: firstNonEmpty([node.provider, raw.provider]) || null,
      profileArn: firstNonEmpty([node.profileArn, raw.profileArn]) || null,
      region: firstNonEmpty([node.region, raw.region]) || null,
      clientIdHash: firstNonEmpty([node.clientIdHash, raw.clientIdHash]) || null,
      email,
      _sourcePath: sourcePath || raw._sourcePath || '',
    };
  }
  return null;
}

/**
 * Read Kiro token by scanning all candidate paths.
 * Returns the first valid token found (with _sourcePath annotation).
 */
function readKiroToken() {
  const candidatePaths = getKiroTokenCandidatePaths();
  debugLog('Token candidate paths:', candidatePaths);

  for (const tokenPath of candidatePaths) {
    try {
      if (!fs.existsSync(tokenPath)) {
        debugLog(`  ✗ not found: ${tokenPath}`);
        continue;
      }
      const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const data = extractKiroTokenPayload(raw, tokenPath);
      if (data?.accessToken) {
        debugLog(`  ✓ token found: ${tokenPath}`);
        return data;
      }
      debugLog(`  ✗ no accessToken: ${tokenPath}`);
    } catch (err) {
      debugLog(`  ✗ parse error: ${tokenPath} — ${err.message}`);
    }
  }
  debugLog('  ✗ no valid token in any candidate path');
  return null;
}

function writeKiroToken(tokenData) {
  // Write to the first writable SSO cache dir (handles Windows path mismatch)
  for (const dir of _getSsoCacheDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, KIRO_TOKEN_FILE), JSON.stringify(tokenData, null, 2));
      return;
    } catch { /* try next */ }
  }
}

function readKiroProfile() {
  for (const p of _getKiroProfilePaths()) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* skip */ }
  }
  return null;
}

function readClientRegistration(clientIdHash) {
  if (!clientIdHash) return null;
  // Scan all SSO cache dirs (handles os.homedir vs %USERPROFILE% mismatch)
  for (const dir of _getSsoCacheDirs()) {
    const filePath = path.join(dir, `${clientIdHash}.json`);
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch { /* skip */ }
  }
  return null;
}

function isTokenExpired(tokenData) {
  if (!tokenData?.expiresAt) return true;
  return new Date(tokenData.expiresAt).getTime() < Date.now() + REFRESH_BUFFER_MS;
}

function enrichWithProfile(tokenData) {
  // If token already has profileArn from its own payload, mark as trusted
  if (tokenData.profileArn) {
    if (!tokenData._profileArnSource) tokenData._profileArnSource = 'token';
    return tokenData;
  }
  // Inject from profile.json cache — mark as untrusted (may be stale)
  const profile = readKiroProfile();
  if (profile?.arn) {
    tokenData.profileArn = profile.arn;
    tokenData._profileArnSource = 'profile_cache';
    debugLog(`enrichWithProfile: injected profileArn from profile.json cache (${profile.arn})`);
  }
  return tokenData;
}

function toPoolTokenShape(poolToken = null) {
  if (!poolToken || !hasTokenShape(poolToken.accessToken)) return null;
  const authData = poolToken.authData || {};
  return {
    accessToken: normalizeToken(poolToken.accessToken),
    refreshToken: poolToken.refreshToken ? String(poolToken.refreshToken).trim() : null,
    expiresAt: authData.expiresAt || poolToken.expiresAt || null,
    authMethod: authData.authMethod || null,
    provider: authData.provider || null,
    profileArn: authData.profileArn || null,
    region: authData.region || null,
    clientIdHash: authData.clientIdHash || null,
    _sourcePath: poolToken.sourcePath || '',
  };
}

async function getPoolActiveToken() {
  try {
    const pool = require('../../accountPool');
    await pool.init();
    const token = await pool.getActiveToken(ACCOUNT_POOL_TYPE);
    return toPoolTokenShape(token);
  } catch {
    return null;
  }
}

function persistObservedToken(tokenData = null, { activate = false } = {}) {
  if (!tokenData || !tokenData.accessToken) return;
  Promise.resolve().then(async () => {
    try {
      const pool = require('../../accountPool');
      await pool.init();
      // Only persist profileArn to pool if it came from the token itself,
      // not from profile.json cache (which may be stale and cause 403).
      const trustedProfileArn = tokenData._profileArnSource === 'profile_cache'
        ? null
        : (tokenData.profileArn || null);
      const upserted = await pool.saveObservedToken(ACCOUNT_POOL_TYPE, {
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken || null,
        email: tokenData.email || null,
        sourcePath: tokenData._sourcePath || path.join(_getSsoCacheDirs()[0], KIRO_TOKEN_FILE),
        label: trustedProfileArn ? `kiro:${trustedProfileArn}` : (tokenData.email || 'kiro'),
        authData: {
          authMethod: tokenData.authMethod || null,
          provider: tokenData.provider || null,
          profileArn: trustedProfileArn,
          region: tokenData.region || null,
          clientIdHash: tokenData.clientIdHash || null,
          expiresAt: tokenData.expiresAt || null,
        },
      }, { activateIfNone: true });
      // If caller flagged activate (e.g. user re-logged in Kiro IDE with a new account),
      // set this record as the active account so pool stays in sync with disk.
      if (activate && upserted?.id) {
        await pool.setActiveAccount(ACCOUNT_POOL_TYPE, upserted.id);
        debugLog(`persistObservedToken: activated account #${upserted.id} in pool`);
      }
      await pool.autoImportObservedCredentials(ACCOUNT_POOL_TYPE);
    } catch { /* ignore */ }
  });
}

function resolveKiroLaunchCandidate() {
  let installPath = null;
  try {
    const { findInstallation } = require('./ideDetector');
    installPath = findInstallation('kiro');
  } catch {
    installPath = null;
  }
  if (!installPath) return null;
  try {
    if (fs.existsSync(installPath) && fs.statSync(installPath).isFile()) {
      return installPath;
    }
  } catch { /* ignore */ }

  if (process.platform === 'win32') {
    const candidates = [
      path.join(installPath, 'Kiro.exe'),
      path.join(installPath, 'kiro.exe'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
  } else if (process.platform === 'darwin') {
    if (installPath.endsWith('.app')) return installPath;
    const appCandidate = `${installPath}.app`;
    try {
      if (fs.existsSync(appCandidate)) return appCandidate;
    } catch { /* ignore */ }
  } else {
    const candidates = [
      path.join(installPath, 'kiro'),
      path.join(installPath, 'Kiro'),
      path.join(installPath, 'bin', 'kiro'),
      path.join(installPath, 'kiro.AppImage'),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch { /* ignore */ }
    }
  }
  return installPath;
}

function maybeOpenKiroLogin(reason = '', options = {}) {
  const autoOpenLogin = options.autoOpenLogin === true;
  // Login auto-open is already gated by the caller: only the foreground chat
  // path (getAccessToken with autoOpenLogin:true) reaches here with the flag set;
  // passive paths (background model refresh, disk watch, detect) never pass it.
  // So the explicit autoOpenLogin + env check is sufficient — no extra idle gate
  // (which would wrongly block a deliberate "login to Kiro" request). The #2
  // noise fix lives in _emitActiveStatus, which suppresses the chatty STATUS
  // emits when Kiro has not been used recently.
  if (!autoOpenLogin || !KIRO_AUTO_OPEN_LOGIN) return false;

  // A deprecated/inactive channel must never spawn the IDE or prompt for login:
  // the user has switched away, so any "login required" is the old channel's
  // private state, not an actionable foreground event. Gate the side-effect at
  // the source (not just the log) so a background model-refresh that flows
  // through listModels({autoOpenLogin:true}) cannot pop the IDE for an idle Kiro.
  if (_isDeprecatedChannel()) {
    debugLog(`(suppressed — kiro deprecated channel) maybeOpenKiroLogin(${reason})`);
    return false;
  }

  const now = Date.now();
  if (now - _lastLoginPromptAt < KIRO_LOGIN_COOLDOWN_MS) return false;
  _lastLoginPromptAt = now;

  try {
    const { openDefault, spawnGuiApp } = require('../../../tools/platformUtils');
    const candidate = resolveKiroLaunchCandidate();
    if (candidate) {
      if (process.platform === 'darwin' && candidate.endsWith('.app')) openDefault(candidate);
      else spawnGuiApp(candidate);
      _emitChannelWarn(`[kiroAdapter] Kiro login required (${reason || 'no token'}), opened Kiro IDE for login`);
      return true;
    }
    openDefault(KIRO_LOGIN_URL);
    _emitChannelWarn(`[kiroAdapter] Kiro login required (${reason || 'no token'}), opened ${KIRO_LOGIN_URL}`);
    return true;
  } catch (err) {
    debugLog(`failed to open Kiro login entry: ${err.message}`);
    return false;
  }
}

// ── Token refresh ────────────────────────────────────────────────────────

async function refreshSocialToken(tokenData) {
  const res = await jsonRequest(SOCIAL_REFRESH_URL, {
    method: 'POST',
    body: { refreshToken: tokenData.refreshToken },
    timeout: 15000,
  });
  if (res.status !== 200) throw new Error(`Social token refresh failed (${res.status})`);
  const data = res.data;
  const expiresAt = new Date(Date.now() + (data.expiresIn || 3600) * 1000).toISOString();
  return {
    ...tokenData,
    accessToken: data.accessToken,
    ...(data.refreshToken && { refreshToken: data.refreshToken }),
    ...(data.profileArn && { profileArn: data.profileArn }),
    expiresAt,
  };
}

async function refreshIdCToken(tokenData) {
  const clientReg = readClientRegistration(tokenData.clientIdHash);
  if (!clientReg?.clientId || !clientReg?.clientSecret) {
    throw new Error('IdC refresh failed: no valid client registration. Please re-login in Kiro.');
  }
  const region = tokenData.region || 'us-east-1';
  const endpoint = `https://oidc.${region}.amazonaws.com/token`;

  // AWS OIDC uses both camelCase and snake_case depending on SDK version;
  // send both so the endpoint accepts whichever format it expects.
  const body = {
    clientId: clientReg.clientId,
    clientSecret: clientReg.clientSecret,
    grantType: 'refresh_token',
    grant_type: 'refresh_token',
    refreshToken: tokenData.refreshToken,
    refresh_token: tokenData.refreshToken,
  };

  const res = await jsonRequest(endpoint, {
    method: 'POST',
    body,
    timeout: 15000,
  });
  if (res.status !== 200) {
    const detail = (() => {
      if (res.data == null) return '';
      if (typeof res.data === 'string') return res.data.slice(0, 300);
      try { return JSON.stringify(res.data).slice(0, 300); } catch { return ''; }
    })();
    debugLog(`IdC refresh failed (${res.status}): ${detail}`);
    throw new Error(`IdC token refresh failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const data = res.data;
  const expiresAt = new Date(Date.now() + (data.expiresIn || data.expires_in || 3600) * 1000).toISOString();
  return {
    ...tokenData,
    accessToken: data.accessToken || data.access_token,
    ...(data.refreshToken || data.refresh_token ? { refreshToken: data.refreshToken || data.refresh_token } : {}),
    expiresAt,
  };
}

async function refreshToken(tokenData) {
  const method = tokenData.authMethod;
  if (method === 'social' || method === 'Social') return refreshSocialToken(tokenData);
  if (method === 'IdC' || method === 'idc') return refreshIdCToken(tokenData);
  throw new Error(`Unknown auth method: ${method}`);
}

/**
 * Get a valid access token (memory → disk → refresh).
 */
async function getAccessToken(options = {}) {
  // Probe local token periodically (every 30s) instead of every call,
  // to detect account switches without excessive disk I/O.
  const now = Date.now();
  const PROBE_INTERVAL_MS = 30000;
  let localToken;
  if (!_cachedToken || !_lastTokenProbeMs || (now - _lastTokenProbeMs) >= PROBE_INTERVAL_MS) {
    localToken = readKiroToken();
    _lastTokenProbeMs = now;
  }
  const localTokenSignature = localToken ? buildTokenSignature(localToken) : null;

  if (_cachedToken && !isTokenExpired(_cachedToken)) {
    // Detect local disk token change (Kiro IDE re-login)
    if (localTokenSignature && localTokenSignature !== _cachedTokenSignature) {
      const localIdentity = buildAccountIdentity(localToken);
      const isAccountSwitch = _cachedAccountIdentity && localIdentity && _cachedAccountIdentity !== localIdentity;
      if (isAccountSwitch) {
        _emitActiveStatus(`[kiroAdapter] 检测到已切换账号${localToken.email ? `（${localToken.email}）` : ''}，token 自动刷新。`);
      } else {
        debugLog('Detected Kiro token refresh on disk (same account) — updating cache');
      }
      return assignCachedToken(localToken);
    }
    // Detect pool active-account change (manual switch via UI/nirvana).
    // Only check during probe windows (every 30s) to avoid excessive DB queries.
    if (localToken) { // localToken is non-null only during probe windows
      const poolToken = await getPoolActiveToken();
      if (poolToken?.accessToken && hasTokenShape(poolToken.accessToken)) {
        const cachedNorm = normalizeToken(_cachedToken.accessToken);
        const poolNorm = normalizeToken(poolToken.accessToken);
        if (cachedNorm !== poolNorm) {
          _emitActiveStatus(`[kiroAdapter] 检测到账号池切换（手动/nirvana），已切换到账号 #${poolToken.accountId || ''}（${poolToken.email || poolToken.label || 'kiro'}），token 已刷新。`);
          debugLog('Detected pool active-account switch (manual/nirvana) — switching to pool token');
          return assignCachedToken(poolToken);
        }
      }
    }
    return _cachedToken;
  }

  const poolToken = await getPoolActiveToken();
  const poolValid = !!(poolToken?.accessToken && hasTokenShape(poolToken.accessToken));
  const localValid = !!(localToken?.accessToken && hasTokenShape(localToken.accessToken));

  // Smart token selection:
  //  - _forcePoolNext (ban/cooldown just switched): always pool, even if expired
  //    (the refresh flow below will attempt IdC refresh with the new account's refreshToken).
  //  - Pool has a DIFFERENT token than local: pool was switched (ban/nirvana/manual),
  //    prefer pool even if expired — local is the old/banned account.
  //  - Same account: prefer local (fresher disk copy, avoids stale pool authData).
  let tokenData = null;
  const sameAccount = poolValid && localValid
    && normalizeToken(poolToken.accessToken) === normalizeToken(localToken.accessToken);

  if (_forcePoolNext && poolValid) {
    // Force pool after ban/cooldown switch — allow expired tokens through to refresh
    tokenData = poolToken;
    _forcePoolNext = false;
    debugLog(`getAccessToken: using pool token (forced after ban/cooldown switch, expired=${isTokenExpired(poolToken)})`);
  } else if (poolValid && localValid && !sameAccount) {
    // Pool was switched to a different account → trust pool even if expired
    tokenData = poolToken;
    debugLog(`getAccessToken: using pool token (different account — pool was switched, expired=${isTokenExpired(poolToken)})`);
  } else if (localValid && !isTokenExpired(localToken)) {
    tokenData = localToken;
    debugLog('getAccessToken: using local token (same account, fresher disk copy)');
  } else if (poolValid && !isTokenExpired(poolToken)) {
    tokenData = poolToken;
    debugLog('getAccessToken: using pool token (local expired or missing)');
  } else if (localValid) {
    tokenData = localToken;
    debugLog('getAccessToken: using local token (both expired, prefer local for refresh)');
  } else if (poolValid) {
    tokenData = poolToken;
    debugLog('getAccessToken: using pool token (no local token)');
  }
  const fallbackToken = tokenData === poolToken ? localToken : poolToken;

  if (!tokenData?.accessToken || !hasTokenShape(tokenData.accessToken)) {
    maybeOpenKiroLogin('token_not_found', options);
    throw new Error('No Kiro token found. Please login in Kiro IDE first.');
  }

  if (!isTokenExpired(tokenData)) {
    return assignCachedToken(tokenData);
  }

  // If token is only in the pre-refresh buffer (not truly expired), and we're
  // in a refresh backoff period, just use the existing token.
  const isTrulyExpired = !tokenData.expiresAt || new Date(tokenData.expiresAt).getTime() < Date.now();
  if (!isTrulyExpired && Date.now() < _refreshBackoffUntil) {
    debugLog('Token near expiry but in refresh backoff period — using existing token');
    return assignCachedToken(tokenData);
  }

  if (!tokenData.refreshToken) {
    maybeOpenKiroLogin('token_expired_no_refresh', options);
    throw new Error('Kiro token expired, no refreshToken. Please re-login in Kiro.');
  }

  // Deduplicate concurrent refreshes
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const newToken = await refreshToken(tokenData);
      const enriched = enrichWithProfile(newToken);
      writeKiroToken(enriched);
      return assignCachedToken(enriched);
    } catch (err) {
      // Set refresh backoff to avoid hammering on every request (60s cooldown)
      _refreshBackoffUntil = Date.now() + 60_000;
      // If old token not fully expired (just within buffer), use it
      if (tokenData.expiresAt && new Date(tokenData.expiresAt) > new Date()) {
        _emitChannelWarn(`[kiroAdapter] Token refresh failed (${err.message}), using existing token until ${tokenData.expiresAt}`);
        return assignCachedToken(tokenData);
      }
      if (fallbackToken?.accessToken && hasTokenShape(fallbackToken.accessToken) && !isTokenExpired(fallbackToken)) {
        _emitChannelWarn('[kiroAdapter] Token refresh failed, falling back to alternate token source');
        return assignCachedToken(fallbackToken);
      }
      maybeOpenKiroLogin('token_refresh_failed', options);
      throw err;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

// ── Region helpers ───────────────────────────────────────────────────────

function regionFromArn(arn) {
  if (!arn) return null;
  const parts = arn.split(':');
  return parts.length >= 4 ? parts[3] : null;
}

function endpointForRegion(region) {
  if (REGION_ENDPOINTS[region]) return REGION_ENDPOINTS[region];
  if (REGION_ENDPOINTS_CN[region]) return REGION_ENDPOINTS_CN[region];
  if (/^cn-/i.test(String(region || ''))) return `https://q.${region}.amazonaws.com.cn`;
  return `https://q.${region}.amazonaws.com`;
}

// buildUserAgent is now delegated to _fingerprint.js (buildKiroUserAgent)
// which uses a rotating device ID instead of real os.hostname().

// ── Model listing (HTTP, no SDK) ─────────────────────────────────────────

/**
 * Fetch models via kiro-proxy's /v1/models endpoint.
 * Returns same shape as fetchModelsDirect: { models, defaultModel }.
 */
async function fetchModelsViaProxy() {
  if (!KIRO_PROXY_URL) return null;
  try {
    const url = `${KIRO_PROXY_URL}/v1/models`;
    const res = await jsonRequest(url, { timeout: 12000 });
    if (res.status !== 200 || !res.data) return null;
    const data = res.data;
    const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    if (rawModels.length === 0) return null;
    const models = rawModels.map(m => ({
      modelId: m.id || m.modelId || '',
      modelName: m.name || m.modelName || m.id || '',
      description: m.description || '',
    })).filter(m => m.modelId);
    const defaultModel = rawModels.find(m => m.is_default) ? { modelId: rawModels.find(m => m.is_default).id } : null;
    return { models, defaultModel };
  } catch {
    return null;
  }
}

/**
 * Fetch models directly from AWS Q Developer ListAvailableModels API.
 * @param {object} tokenData
 * @param {object} [options]
 * @param {boolean} [options.omitProfileArn] - If true, do NOT include profileArn
 *   in the request. Used as fallback when a stale/mismatched profileArn causes 403.
 */
async function fetchModelsDirect(tokenData, options = {}) {
  await applyJitter(); // anti-fingerprint timing jitter
  const effectiveArn = options.omitProfileArn ? null : (tokenData.profileArn || null);
  const arnRegion = regionFromArn(effectiveArn);
  const region = arnRegion || DEFAULT_REGION;
  const endpoint = endpointForRegion(region);

  const params = new URLSearchParams({ origin: 'AI_EDITOR' });
  if (effectiveArn) params.set('profileArn', effectiveArn);

  const headers = {
    'Authorization': `Bearer ${tokenData.accessToken}`,
    'User-Agent': buildKiroUserAgent(),
    'x-amzn-codewhisperer-optout': 'true',
  };
  if (tokenData.authMethod === 'external_idp') headers['TokenType'] = 'EXTERNAL_IDP';
  if (tokenData.provider === 'Internal') headers['redirect-for-internal'] = 'true';

  const allModels = [];
  let defaultModel = null;
  let nextToken;

  do {
    if (nextToken) params.set('nextToken', nextToken);
    const url = `${endpoint}/ListAvailableModels?${params}`;
    const res = await jsonRequest(url, {
      headers,
      timeout: 15000,
      requireProxy: KIRO_DISCOVERY_REQUIRE_PROXY,
    });
    if (res.status !== 200) throw new Error(`ListAvailableModels failed (${res.status})`);
    allModels.push(...(res.data.models || []));
    if (res.data.defaultModel && !defaultModel) defaultModel = res.data.defaultModel;
    nextToken = res.data.nextToken;
  } while (nextToken);

  return { models: allModels, defaultModel };
}

/**
 * Fetch models: try kiro-proxy first (if configured), then direct API.
 * @param {object} tokenData
 * @param {object} [options] - forwarded to fetchModelsDirect
 */
async function fetchModels(tokenData, options = {}) {
  // Try kiro-proxy first (works even without local token on Windows)
  const proxyResult = await fetchModelsViaProxy();
  if (proxyResult && proxyResult.models.length > 0) return proxyResult;

  // Fall back to direct AWS API call
  return fetchModelsDirect(tokenData, options);
}

// ── SDK-based chat (shared CW module from _cwStreamParser.js) ──────────────

// ── Anthropic → CodeWhisperer format helpers (from _anthropicFormat.js) ──

/**
 * Build an HTTPS agent that tunnels through a proxy (if configured).
 * Uses the built-in http.Agent + CONNECT tunnel approach.
 */
function buildProxyHttpsAgent() {
  const candidates = resolveHttpProxyCandidates('https://q.amazonaws.com');
  const proxyUrl = candidates[0] || '';
  if (!proxyUrl) return undefined;
  try {
    // Try to use https-proxy-agent if available (most reliable)
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    // Package not installed — no SDK proxy support
    return undefined;
  }
}

async function createSDKClient(tokenData) {
  // Reuse cached client if token hasn't changed
  if (_sdkClient && _sdkClientToken === tokenData.accessToken) return _sdkClient;

  const { CodeWhispererStreaming } = await getCWModule();
  const arnRegion = regionFromArn(tokenData.profileArn);
  const finalRegion = arnRegion || DEFAULT_REGION;
  const finalEndpoint = endpointForRegion(finalRegion);

  const clientOpts = {
    region: finalRegion,
    endpoint: finalEndpoint,
    token: { token: tokenData.accessToken },
    customUserAgent: buildKiroUserAgent(),
  };

  // Inject proxy agent for SDK HTTP requests if configured
  const proxyAgent = buildProxyHttpsAgent();
  if (proxyAgent) {
    try {
      const { NodeHttpHandler } = await import('@smithy/node-http-handler');
      clientOpts.requestHandler = new NodeHttpHandler({ httpsAgent: proxyAgent });
    } catch {
      // @smithy/node-http-handler not available, SDK will use default handler
    }
  }

  const client = new CodeWhispererStreaming(clientOpts);

  // Add required headers via middleware + strip IP-identifying headers
  // (matches kiro-proxy: separate middleware per header for proper stacking)
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = sanitizeOutgoingHeaders(buildKiroHeaders({
        ...args.request.headers,
        'x-amzn-codewhisperer-optout': 'true',
      }));
      return next(args);
    },
    { step: 'build', name: 'optOutHeader' }
  );
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers = {
        ...args.request.headers,
        'x-amzn-kiro-agent-mode': 'vibe',
      };
      return next(args);
    },
    { step: 'build', name: 'agentModeHeader' }
  );
  if (tokenData.authMethod === 'external_idp') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, TokenType: 'EXTERNAL_IDP' };
        return next(args);
      },
      { step: 'build', name: 'tokenTypeHeader' }
    );
  }
  if (tokenData.provider === 'Internal') {
    client.middlewareStack.add(
      (next) => async (args) => {
        args.request.headers = { ...args.request.headers, 'redirect-for-internal': 'true' };
        return next(args);
      },
      { step: 'build', name: 'redirectForInternal' }
    );
  }

  _sdkClient = client;
  _sdkClientToken = tokenData.accessToken;
  return client;
}

// ── Adapter interface ────────────────────────────────────────────────────

/**
 * Detect if Kiro auth token exists.
 * Also checks for Kiro installation via ideDetector and kiro-proxy availability.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _installDetected = false;

  // Kiro-proxy configured — optimistic available
  if (KIRO_PROXY_URL) {
    _available = true;
    return true;
  }

  // Check token first
  const tokenData = readKiroToken();
  if (tokenData?.accessToken) {
    _available = true;
    return true;
  }

  // Fallback: check if Kiro is installed (token may appear after login)
  // 仅标记 _installDetected 供 listModels() 显示基线模型，
  // 但不标记 _available — 没有有效 token+profileArn 无法发送请求
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    const installed = findInstallation('kiro') || findDataPath('kiro');
    _installDetected = !!installed;
  } catch {
    _installDetected = false;
  }

  _available = false;

  // Background: try pool for token (async, non-blocking).
  // Strict availability: an imported/pool token alone must NOT mark Kiro
  // "available" — that requires a local install AND the opt-in flag
  // KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS. The token is still cached for
  // routing/generate regardless.
  if (!_available) {
    getPoolActiveToken().then(poolToken => {
      if (poolToken?.accessToken && hasTokenShape(poolToken.accessToken)) {
        _cachedToken = poolToken;
        if (_installDetected && countsTowardAvailability(poolToken)) {
          debugLog('Pool token found in background check — marking available (imported-creds flag on + Kiro installed)');
          _available = true;
        } else {
          debugLog('Pool token cached for routing, but not counted toward availability (strict mode)');
        }
      }
    }).catch(() => {});
  }

  return _available;
}

/**
 * Async detection with token validation.
 * If KIRO_PROXY_URL is set, validate proxy health instead of local token.
 * Falls back to disk-based token check if getAccessToken() fails (e.g.
 * accountPool not ready during early init, or refresh returning 400).
 */
async function detectAsync() {
  if (KIRO_PROXY_URL) {
    try {
      const res = await jsonRequest(`${KIRO_PROXY_URL}/health`, { timeout: 8000 });
      _available = res.status === 200 && res.data?.status !== 'error';
      return _available;
    } catch {
      // Proxy unreachable, fall through to local token check
    }
  }
  try {
    const tokenData = await getAccessToken({ autoOpenLogin: false });
    _available = !!(tokenData?.accessToken);
    return _available;
  } catch (err) {
    debugLog(`detectAsync getAccessToken failed: ${err.message}, falling back to file check`);
    // Fallback: disk token that is structurally valid
    // Even if expired, mark available if refreshToken exists — generation
    // will attempt refresh on demand. This prevents init-timeout false negatives
    // when AWS refresh endpoint is slow (common behind GFW).
    try {
      const localToken = readKiroToken();
      if (localToken?.accessToken && hasTokenShape(localToken.accessToken)) {
        const hasRefresh = !!(localToken.refreshToken);
        const reallyExpired = localToken.expiresAt
          ? new Date(localToken.expiresAt) < new Date()
          : false;
        if (!reallyExpired || hasRefresh) {
          assignCachedToken(localToken);
          _available = true;
          return true;
        }
        debugLog('detectAsync: disk token expired and no refreshToken');
      }
    } catch { /* ignore */ }

    // 最终 fallback：Kiro 已安装 → 仅标记 _installDetected 供 listModels()
    // 但不标记 _available — 没有有效 token 无法发送请求
    try {
      const { findInstallation, findDataPath } = require('./ideDetector');
      const installed = findInstallation('kiro') || findDataPath('kiro');
      if (installed) {
        debugLog('detectAsync: Kiro installed but no valid token — not marking available');
        _installDetected = true;
      }
    } catch { /* ideDetector not available */ }

    _available = false;
    return false;
  }
}

/**
 * List available Kiro models.
 * Tries kiro-proxy first (if configured), then direct API.
 */
async function listModels() {
  // Return cache if fresh
  if (_models.length > 0 && (Date.now() - _modelsFetchedAt) < MODEL_CACHE_TTL) {
    return _models;
  }

  let tokenData = null;
  try {
    tokenData = await getAccessToken({ autoOpenLogin: true });
  } catch (err) {
    debugLog(`listModels: getAccessToken failed: ${err.message}`);
    if (!KIRO_PROXY_URL) {
      if (_installDetected) {
        const proxyAvailable = hasOverseasRoute();
        _models = KIRO_BASELINE_MODELS.map(m => {
          const needsProxy = m.region === 'overseas';
          const reachable = !needsProxy || proxyAvailable;
          return {
            id: m.id,
            name: `${m.name} (${m.credit})`,
            provider: 'kiro',
            description: reachable
              ? `Baseline — ${m.tier} tier. 请先在 Kiro IDE 登录以发现全部模型。`
              : `Baseline — ${m.tier} tier（需代理/VPN）。请先在 Kiro IDE 登录。`,
            isDefault: m.id === MODELS.sonnet,
            discoverySource: 'baseline',
            _reachable: reachable,
          };
        });
        _modelsFetchedAt = Date.now();
        return _models;
      }
      throw new Error('No Kiro token found. Please login in Kiro IDE first.');
    }
  }

  // Enrich with profileArn from Kiro profile cache if missing
  if (tokenData && !tokenData.profileArn) {
    tokenData = enrichWithProfile(tokenData);
    if (!tokenData.profileArn) {
      debugLog('listModels: WARNING — profileArn is missing, ListAvailableModels may return empty/limited results');
    }
  }

  const profileArnSource = tokenData?._profileArnSource || 'unknown';
  debugLog(`listModels: token source=${tokenData?._sourcePath ? 'local' : 'pool'}, profileArn source=${profileArnSource}, arn=${tokenData?.profileArn || 'none'}`);

  let fetched;
  try {
    fetched = await fetchModels(tokenData || {});
    debugLog(`listModels: fetched ${fetched?.models?.length || 0} models from API`);
  } catch (err) {
    const is403 = /403|401|forbidden|AccessDeniedException/i.test(err.message || '');
    const isSuspended = /suspended|banned|locked|deactivated|revoked|terminated/i.test(err.message || '');

    // If the account is permanently suspended/banned, ban it and retry with fresh token
    if (isSuspended && tokenData) {
      debugLog('listModels: account suspended/banned — triggering ban + fresh retry');
      _cachedToken = null;
      _cachedTokenSignature = '';
      _cachedAccountIdentity = '';
      _lastTokenProbeMs = 0;
      try {
        const pool = require('../../accountPool');
        const result = await pool.banActiveAccount(ACCOUNT_POOL_TYPE);
        if (result?.switched) {
          _forcePoolNext = true;
          _emitStatus(`[kiroAdapter] 账号已封禁 (#${result.bannedId})，已切换到账号 #${result.nextId}（${result.nextEmail || result.label || 'kiro'}），正在刷新模型列表...`);
          _emitAccountEmail(result.nextEmail);
        } else if (result) {
          _emitStatus(`[kiroAdapter] 账号已封禁 (#${result.bannedId})，尝试重新读取本地凭证...`);
        }
      } catch (poolErr) {
        debugLog(`listModels: ban failed: ${poolErr.message}`);
      }
      // Always retry: re-read disk (nirvana) + pool for fresh token
      try {
        const newToken = await getAccessToken({ autoOpenLogin: false });
        if (newToken?.accessToken) {
          const enriched = enrichWithProfile(newToken);
          fetched = await fetchModels(enriched);
          if (fetched?.models?.length) {
            _emitStatus(`[kiroAdapter] token 已刷新${newToken.email ? `（${newToken.email}）` : ''}，已获取 ${fetched.models.length} 个模型。`);
          }
          debugLog(`listModels: post-ban retry fetched ${fetched?.models?.length || 0} models`);
        }
      } catch (retryErr) {
        debugLog(`listModels: post-ban retry failed: ${retryErr.message}`);
        fetched = null;
      }
    }

    if (is403 && tokenData && !fetched) {
      // ── Retry strategy depends on profileArn source ────────────────
      //
      // If profileArn came from profile.json cache (not from the token
      // itself), it may be stale/mismatched.  Try without profileArn first
      // before the heavier forceRefresh path.
      if (profileArnSource === 'profile_cache' && tokenData.profileArn) {
        debugLog('listModels: 403 with profile_cache profileArn — retrying WITHOUT profileArn');
        try {
          fetched = await fetchModels(tokenData, { omitProfileArn: true });
          debugLog(`listModels: no-profileArn fallback fetched ${fetched?.models?.length || 0} models`);
        } catch (noArnErr) {
          debugLog(`listModels: no-profileArn fallback also failed: ${noArnErr.message}`);
          fetched = null;
        }
      }

      // If still no result, try forceRefresh + retry (may get a new token
      // that carries its own profileArn, or the refreshed token may work).
      if (!fetched || !fetched.models || fetched.models.length === 0) {
        debugLog('listModels: attempting forceRefresh + retry');
        const refreshResult = await forceRefresh();
        if (refreshResult.success) {
          try {
            tokenData = refreshResult.tokenData;
            if (tokenData && !tokenData.profileArn) tokenData = enrichWithProfile(tokenData);
            fetched = await fetchModels(tokenData || {});
            debugLog(`listModels: forceRefresh retry fetched ${fetched?.models?.length || 0} models`);
          } catch (retryErr) {
            debugLog(`listModels: forceRefresh retry failed: ${retryErr.message}`);
            // Last resort: if the refreshed profileArn is also from cache, try without it
            if (tokenData?._profileArnSource === 'profile_cache' && tokenData.profileArn) {
              try {
                fetched = await fetchModels(tokenData, { omitProfileArn: true });
                debugLog(`listModels: forceRefresh no-arn fallback fetched ${fetched?.models?.length || 0}`);
              } catch {
                fetched = null;
              }
            } else {
              fetched = null;
            }
          }
        } else {
          debugLog(`listModels: forceRefresh failed: ${refreshResult.error}`);
          fetched = null;
        }
      }
    } else {
      if (KIRO_DISCOVERY_REQUIRE_PROXY) {
        const reason = err?.message || 'unknown error';
        throw new Error(`Kiro 完整模型发现需要代理，请先开启 Clash/VPN 后重试 (${reason})`);
      }
      // In proxyless environments this is expected — use debugLog instead of warn
      debugLog(`listModels: ListAvailableModels failed (expected without proxy): ${err.message}`);
      fetched = null;
    }
  }

  // Fallback to baseline models if API failed
  if (!fetched || !fetched.models || fetched.models.length === 0) {
    const proxyAvailable = hasOverseasRoute();
    debugLog(`listModels: API unavailable, falling back to baseline models (proxy=${proxyAvailable})`);
    _models = KIRO_BASELINE_MODELS.map(m => {
      const needsProxy = m.region === 'overseas';
      const reachable = !needsProxy || proxyAvailable;
      return {
        id: m.id,
        name: `${m.name} (${m.credit})`,
        provider: 'kiro',
        description: reachable
          ? `Baseline — ${m.tier} tier`
          : `Baseline — ${m.tier} tier（需代理/VPN）`,
        isDefault: m.id === MODELS.sonnet,
        discoverySource: 'baseline',
        _reachable: reachable,
      };
    });
    _modelsFetchedAt = Date.now();
    return _models;
  }

  const { models, defaultModel } = fetched;
  _models = models.map(m => ({
    id: m.modelId,
    name: m.modelName || m.modelId,
    provider: 'kiro',
    description: m.description || '',
    isDefault: defaultModel?.modelId === m.modelId,
    discoverySource: KIRO_PROXY_URL ? 'proxy' : 'remote',
  }));

  // Inject Claude models that Kiro IDE shows but ListAvailableModels omits.
  if (KIRO_INJECT_CLAUDE) {
    const existingIds = new Set(_models.map(m => m.id.toLowerCase().replace(/[.-]/g, '')));
    for (const cm of KIRO_INJECTED_CLAUDE_MODELS) {
      const normalizedId = cm.id.toLowerCase().replace(/[.-]/g, '');
      if (existingIds.has(normalizedId)) continue;
      _models.push({
        id: cm.id,
        name: `${cm.name} (${cm.credit})`,
        provider: 'kiro',
        description: `Injected — ${cm.tier} tier. Kiro IDE shows this model but API may not list it.`,
        isDefault: false,
        discoverySource: 'injected',
      });
    }
  }
  _modelsFetchedAt = Date.now();

  // Deduplicate: normalize dot/dash variants (claude-sonnet-4.6 vs claude-sonnet-4-6)
  const seen = new Set();
  _models = _models.filter(m => {
    const key = m.id.toLowerCase().replace(/[.-]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return _models;
}

/**
 * Generate via kiro-proxy (Anthropic-compatible /v1/messages endpoint).
 */
async function generateViaProxy(prompt, options = {}) {
  if (!KIRO_PROXY_URL) return null;
  let messages = (options.messages && options.messages.length > 0)
    ? options.messages
    : [{ role: 'user', content: prompt }];

  // Attach images to messages (OpenAI vision format)
  if (Array.isArray(options.images) && options.images.length > 0) {
    try {
      const { attachImagesToOpenAIMessages } = require('./_imageCompat');
      messages = attachImagesToOpenAIMessages(messages, options.images);
    } catch { /* _imageCompat not available */ }
  }

  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;

  // When tools are present, use Anthropic /v1/messages format (tools support)
  if (hasTools) {
    const url = `${KIRO_PROXY_URL}/v1/messages`;
    const body = {
      model: options.model || undefined,
      messages,
      tools: options.tools,
      max_tokens: options.maxTokens || 8192,
      stream: false,
    };
    if (options.system) body.system = options.system;
    try {
      const res = await jsonRequest(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' },
        timeout: TIMEOUT_MS,
      });
      if (res.status !== 200 || !res.data) return null;
      const data = res.data;
      const textParts = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
      const toolBlocks = (data.content || []).filter(b => b.type === 'tool_use');
      const model = data.model || options.model || 'kiro-proxy';
      return buildSuccess(textParts.join('').trim(), {
        adapter: 'kiro',
        provider: `Kiro Proxy (${model})`,
        model,
        toolUseBlocks: toolBlocks.length > 0 ? toolBlocks : undefined,
        stopReason: data.stop_reason || (toolBlocks.length > 0 ? 'tool_use' : 'end_turn'),
        attempts: [{ provider: 'Kiro(proxy)', success: true }],
      });
    } catch {
      return null;
    }
  }

  // No tools — use OpenAI /v1/chat/completions (simpler)
  const url = `${KIRO_PROXY_URL}/v1/chat/completions`;
  const body = {
    model: options.model || undefined,
    messages,
    stream: false,
  };
  try {
    const res = await jsonRequest(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    });
    if (res.status !== 200 || !res.data) return null;
    const text = res.data?.choices?.[0]?.message?.content || '';
    if (!text) return null;
    const model = res.data?.model || options.model || 'kiro-proxy';
    return buildSuccess(text.trim(), {
      adapter: 'kiro',
      provider: `Kiro Proxy (${model})`,
      model,
      attempts: [{ provider: 'Kiro(proxy)', success: true }],
    });
  } catch {
    return null;
  }
}

/**
 * Generate a response using Kiro's Q Developer API.
 * Includes timeout protection and full event handling.
 * Falls back to kiro-proxy if SDK unavailable.
 * When images are present and proxy is unavailable, signals _visionFallback
 * so the gateway can route to a vision-capable adapter.
 */
async function generate(prompt, options = {}) {
  _lastActiveUseMs = Date.now(); // mark Kiro as actively used — unlocks status lines & IDE auto-open
  const hasVisionInput = Array.isArray(options.images) && options.images.length > 0;

  // Try kiro-proxy first when configured (proxy supports images via OpenAI vision format)
  if (KIRO_PROXY_URL) {
    const proxyResult = await generateViaProxy(prompt, options);
    if (proxyResult) return proxyResult;
  }

  let tokenData = null;
  try {
    // applyJitter removed here — already called in fetchModelsDirect()
    tokenData = await getAccessToken({ autoOpenLogin: true });
    if (!tokenData?.profileArn) {
      throw new Error('Kiro profileArn 缺失 — 请先在 Kiro IDE 中完成登录并授权 Q Developer profile');
    }
    debugLog(`generate: profileArn source=${tokenData._profileArnSource || 'token'}, arn=${tokenData.profileArn}`);
    const client = await createSDKClient(tokenData);
    const { GenerateAssistantResponseCommand } = await getCWModule();

    // Build conversationState via shared CW protocol handler
    const { conversationState } = _cwHandler.buildRequestBody(prompt, {
      ...options,
      model: options.model,
      system: options.system,
      tools: options.tools,
    });

    // 注入 options.images（如果 rawMessages 中没有内联图像）
    if (hasVisionInput && conversationState.currentMessage?.userInputMessage) {
      const existingImages = conversationState.currentMessage.userInputMessage.images;
      if (!existingImages || existingImages.length === 0) {
        // options.images → Anthropic blocks → CodeWhisperer {format, source:{bytes}}
        const anthropicBlocks = toAnthropicImageBlocks(options.images);
        const cwImages = extractAnthropicImages(anthropicBlocks);
        if (cwImages.length > 0) {
          conversationState.currentMessage.userInputMessage.images = cwImages;
        }
      }
    }

    debugLog('generate() rawMessages:', options.rawMessages?.length || 0,
      'tools:', options.tools?.length || 0,
      'cwTools in currentMessage:', conversationState.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0,
      'toolResults in currentMessage:', conversationState.currentMessage?.userInputMessage?.userInputMessageContext?.toolResults?.length || 0,
      'historyLen:', conversationState.history?.length || 0);

    const command = new GenerateAssistantResponseCommand({
      conversationState,
      profileArn: tokenData.profileArn,
    });

    // abort 透传(root cause A):门开时把 options.abortSignal 交给 SDK client.send(撤回在途
    // HTTP 请求、释放 socket),并给内部 120s race 补一条「signal abort 时立即 reject」的臂,
    // 让 UI 的 Esc/Ctrl-C 不必死等 TIMEOUT_MS。门关 → sendConfig 为空、无 abort 臂,逐字节回退。
    const _kiroAbortOn = _isKiroAbortEnabled();
    const _kiroSignal = _kiroAbortOn ? (options.abortSignal || undefined) : undefined;
    const sendConfig = _kiroSignal ? { abortSignal: _kiroSignal } : undefined;

    // Wrap in timeout to prevent indefinite hangs
    let _abortArm = null;
    const _raceArms = [
      client.send(command, sendConfig),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Kiro request timeout (${TIMEOUT_MS / 1000}s)`)), TIMEOUT_MS)
      ),
    ];
    if (_kiroSignal) {
      try {
        const { createAbortRejectionArm } = require('../abortRaceArm');
        _abortArm = createAbortRejectionArm(_kiroSignal, 'kiro request aborted');
        _raceArms.push(_abortArm.promise);
      } catch { _abortArm = null; }
    }
    const sendWithTimeout = Promise.race(_raceArms);

    let response;
    try {
      response = await sendWithTimeout;
    } finally {
      if (_abortArm) { try { _abortArm.cleanup(); } catch { /* ignore */ } }
    }
    if (!response.generateAssistantResponseResponse) {
      throw new Error('Empty response from Q Developer');
    }

    // Parse streaming response via shared CW stream parser
    const onChunk = options.onChunk || (() => {});
    let content, modelId, tokenUsage, toolUseBlocks;

    try {
      const streamResult = await parseCWStreamEvents(
        response.generateAssistantResponseResponse,
        onChunk,
        {
          // Opt into stale-stream teardown (single-sourced in streamStallPolicy,
          // same wiring the SSE parsers use). CW serves Claude models → 'claude'
          // threshold. A mid-stream stall now tears the iterator down → partial
          // salvage or retry/failover, instead of hanging to TIMEOUT_MS.
          enableStaleDetection: true,
          signal: _kiroSignal,
          staleOptions: {
            provider: 'claude',
            onStale: (elapsed) => {
              try { onChunk({ type: 'status', text: `Stream stale: no data for ${Math.round(elapsed / 1000)}s` }); } catch { /* ignore */ }
            },
          },
        },
      );
      content = streamResult.content;
      modelId = streamResult.modelId;
      tokenUsage = streamResult.tokenUsage;
      toolUseBlocks = streamResult.toolUseBlocks;
    } catch (streamErr) {
      // If stream interrupted but we have partial content, return what we got
      if (content && content.trim() || (toolUseBlocks && toolUseBlocks.length > 0)) {
        // Partial success still verifies the token is valid
        if (_pendingPersist) {
          persistObservedToken(_pendingPersist.token, { activate: _pendingPersist.activate });
          _pendingPersist = null;
        }
        const modelDisplay = modelId || options.model || 'default';
        const hasToolUse = toolUseBlocks && toolUseBlocks.length > 0;
        return buildSuccess((content || '').trim(), {
          adapter: 'kiro',
          provider: `Kiro (${modelDisplay})`,
          model: modelDisplay,
          toolUseBlocks: hasToolUse ? toolUseBlocks : undefined,
          stopReason: hasToolUse ? 'tool_use' : 'end_turn',
          tokenUsage: tokenUsage || undefined,
        });
      }
      throw streamErr;
    }

    const modelDisplay = modelId || options.model || 'default';
    const hasToolUse = toolUseBlocks.length > 0;

    // Token verified by successful interaction — persist to account pool now
    if (_pendingPersist) {
      persistObservedToken(_pendingPersist.token, { activate: _pendingPersist.activate });
      _pendingPersist = null;
    }

    return buildSuccess(content.trim(), {
      adapter: 'kiro',
      provider: `Kiro (${modelDisplay})`,
      model: modelDisplay,
      toolUseBlocks: hasToolUse ? toolUseBlocks : undefined,
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
      tokenUsage: tokenUsage || undefined,
      attempts: [{ provider: 'Kiro', success: true }],
    });
  } catch (err) {
    // Classify auth errors
    const isAuthErr = err.message?.includes('401') || err.message?.includes('403')
      || err.message?.includes('expired') || err.message?.includes('suspended')
      || err.message?.includes('AccessDeniedException');

    if (isAuthErr) {
      const isPermanent = /suspended|banned|locked|deactivated|revoked|invalid.?key|terminated/i
        .test(err.message || '');

      if (isPermanent) {
        // Permanent: ban immediately, then always retry once.
        // The retry re-reads from disk (nirvana/manual switch) AND pool (auto switch).
        _sdkClient = null;
        _sdkClientToken = null;
        _cachedToken = null;
        _cachedTokenSignature = '';
        _cachedAccountIdentity = '';
        _lastTokenProbeMs = 0; // force fresh disk read on next getAccessToken()
        try {
          const pool = require('../../accountPool');
          const result = await pool.banActiveAccount(ACCOUNT_POOL_TYPE);
          if (result?.switched) {
            _forcePoolNext = true;
            _emitStatus(`[kiroAdapter] 账号已封禁 (#${result.bannedId})，已自动切换到池中账号 #${result.nextId}（${result.nextEmail || result.label || 'kiro'}），正在重试...`);
            _emitAccountEmail(result.nextEmail);
          } else if (result) {
            _emitStatus(`[kiroAdapter] 账号已封禁 (#${result.bannedId})，池中无其他可用账号，尝试重新读取本地凭证...`);
          }
        } catch (poolErr) {
          debugLog(`Failed to ban account: ${poolErr.message}`);
        }
        // Always retry once: even without pool switch, the local disk token
        // may have been updated by nirvana/Kiro IDE re-login.
        if (!options._banRetried) {
          debugLog('Retrying request after permanent ban (re-reading disk + pool)');
          try {
            return await generate(prompt, { ...options, _banRetried: true });
          } catch (retryErr) {
            debugLog(`Retry after ban failed: ${retryErr.message}`);
            // Fall through to error reporting
          }
        }
      } else if (!options._authRetried) {
        // Recoverable: try forceRefresh + one retry
        debugLog('Recoverable auth error — attempting forceRefresh + retry');
        const refreshResult = await forceRefresh();

        if (refreshResult.success) {
          try {
            return await generate(prompt, { ...options, _authRetried: true });
          } catch (retryErr) {
            debugLog(`Retry after forceRefresh failed: ${retryErr.message}`);
          }
        }

        // Refresh failed or retry failed — cooldown (not permanent ban)
        _cachedToken = null;
        _cachedTokenSignature = '';
        _cachedAccountIdentity = '';
        _lastTokenProbeMs = 0;
        try {
          const pool = require('../../accountPool');
          const result = await pool.cooldownAccount(ACCOUNT_POOL_TYPE, 60000);
          if (result?.switched) {
            _forcePoolNext = true;
            _emitStatus(`[kiroAdapter] 账号 #${result.cooldownId} 认证失败，已自动切换到账号 #${result.nextId}（${result.nextEmail || result.label || 'kiro'}），正在重试...`);
            _emitAccountEmail(result.nextEmail);
          } else if (result) {
            _emitStatus(`[kiroAdapter] 账号 #${result.cooldownId} 认证失败，尝试重新读取本地凭证...`);
          }
        } catch (poolErr) {
          debugLog(`Failed to cooldown account: ${poolErr.message}`);
        }
        // Always retry once: re-read disk + pool for fresh token
        if (!options._cooldownRetried) {
          debugLog('Retrying request after cooldown (re-reading disk + pool)');
          try {
            return await generate(prompt, { ...options, _cooldownRetried: true });
          } catch (retryErr) {
            debugLog(`Retry after cooldown-switch failed: ${retryErr.message}`);
          }
        }
      }
    }

    // Enhance error message with actionable context
    let errorMsg = err.message;
    const is403orTimeout = /403|401|forbidden|AccessDeniedException|timeout|ECONNREFUSED|ENOTFOUND/i.test(errorMsg);
    if (is403orTimeout && tokenData?._profileArnSource === 'profile_cache') {
      errorMsg += ' — profileArn 来自本地缓存(profile.json)，可能已过期。请在 Kiro IDE 重新登录以刷新 profile。';
    } else if (is403orTimeout && !hasOverseasRoute()) {
      errorMsg += ' — 未检测到代理，AWS 端点在国内网络不可达。请配置 HTTPS_PROXY 或 KIRO_PROXY_URL 后重试。';
    }

    return buildFailure(errorMsg, {
      adapter: 'kiro',
      provider: 'Kiro',
      attempts: [{ provider: 'Kiro', success: false, error: errorMsg }],
    });
  }
}

/**
 * Get adapter status.
 */
function getStatus() {
  // Force a fresh synchronous recompute so a stale module-level `_available`
  // (e.g. a background pool token from a prior session, or a removed install)
  // cannot report a false "available".
  detect(true);
  let detail = '';
  if (_available) {
    const proxyAvailable = hasOverseasRoute();
    detail = (KIRO_PROXY_URL ? `Proxy: ${KIRO_PROXY_URL}` : 'Token 有效') + (_models.length ? ` (${_models.length} 个模型)` : '');
    if (!proxyAvailable) {
      const baselineCount = _models.filter(m => m.discoverySource === 'baseline').length;
      detail += baselineCount > 0
        ? `（无代理，${baselineCount} 个基线模型，海外模型需配置 HTTPS_PROXY）`
        : '（无代理，海外模型不可用 — 请配置 HTTPS_PROXY 或 KIRO_PROXY_URL）';
    }
  } else if (_installDetected) {
    detail = '检测到 Kiro 已安装，但未检测到登录 token — 请先在 Kiro IDE 登录';
    if (!KIRO_PROXY_URL) {
      detail += ' 或设置 KIRO_PROXY_URL';
    }
  } else {
    detail = '未检测到 Kiro token — 请先登录 Kiro IDE 或设置 KIRO_PROXY_URL';
  }
  return {
    name: 'Kiro IDE',
    type: 'kiro',
    available: _available,
    proxyUrl: KIRO_PROXY_URL || null,
    detail,
    refreshModels: listModels,
    // P2: surface token-freshness hints so a health-aware router can deprioritize a
    // Kiro whose token is in (or past) the pre-expiry buffer before it 401s.
    tokenExpiresAt: _cachedToken?.expiresAt || null,
    tokenNearExpiry: _cachedToken ? isTokenExpired(_cachedToken) : null,
    lastWarmAt: _lastWarmAt || null,
  };
}

/**
 * Manual refresh — clears all cached state after account switch,
 * environment cleanup, or machine code update.
 * Call this from CLI `khy gateway refresh kiro` or after account change.
 */
function manualRefresh() {
  debugLog('Manual refresh triggered — clearing all cached state');
  _cachedToken = null;
  _cachedTokenSignature = '';
  _cachedAccountIdentity = '';
  _available = null;
  _installDetected = false;
  _models = [];
  _sdkClient = null;
  _sdkClientToken = null;
  _refreshPromise = null;
  _lastLoginPromptAt = 0;
  _forcePoolNext = false;
  _hasOverseasRoute = null; // re-detect proxy availability
  resetFingerprintSession(); // new session → new UA version
}

/**
 * Force-refresh: clear ALL cached state and acquire a fresh token.
 * Called on recoverable 403 errors (token expired) before retrying.
 * @returns {{ success: boolean, tokenData?: object, error?: string }}
 */
async function forceRefresh() {
  debugLog('forceRefresh() — clearing cache and forcing token re-acquisition');
  _sdkClient = null;
  _sdkClientToken = null;
  _cachedToken = null;
  _cachedTokenSignature = '';
  _cachedAccountIdentity = '';
  _lastTokenProbeMs = 0;
  _refreshPromise = null;
  _refreshBackoffUntil = 0;

  try {
    const tokenData = await getAccessToken({ autoOpenLogin: false });
    return { success: true, tokenData };
  } catch (err) {
    debugLog(`forceRefresh failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Instant token file change detection ────────────────────────────────
// Instead of relying solely on 30s polling, watch the token file's parent
// directory for changes. When nirvana or Kiro IDE writes a new token,
// the watcher triggers within milliseconds, debounced to 300ms.

function startTokenFileWatch() {
  stopTokenFileWatch();
  const paths = getKiroTokenCandidatePaths();
  const watchedDirs = new Set();

  for (const tokenPath of paths) {
    try {
      const dir = path.dirname(tokenPath);
      const base = path.basename(tokenPath);
      if (watchedDirs.has(dir)) continue;
      if (!fs.existsSync(dir)) continue;
      watchedDirs.add(dir);

      const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (filename && filename !== base) return;
        // Debounce: nirvana writes multiple files in quick succession
        if (_tokenWatchDebounce) clearTimeout(_tokenWatchDebounce);
        _tokenWatchDebounce = setTimeout(() => {
          _tokenWatchDebounce = null;
          _lastTokenProbeMs = 0; // force immediate probe on next getAccessToken()
          // Eagerly read + compare
          try {
            const fresh = readKiroToken();
            if (fresh) {
              const freshSig = buildTokenSignature(fresh);
              if (_cachedTokenSignature && freshSig !== _cachedTokenSignature) {
                _emitActiveStatus(`[kiroAdapter] 检测到磁盘 token 变化${fresh.email ? `（${fresh.email}）` : ''}，即时刷新。`);
                assignCachedToken(fresh);
              }
            }
          } catch { /* best effort */ }
        }, 300);
      });
      watcher.unref?.();
      watcher.on('error', () => {}); // ignore watch errors
      _tokenWatchers.push(watcher);
    } catch { /* dir doesn't exist or no permission, skip */ }
  }
}

function stopTokenFileWatch() {
  for (const w of _tokenWatchers) try { w.close(); } catch {}
  _tokenWatchers = [];
  if (_tokenWatchDebounce) { clearTimeout(_tokenWatchDebounce); _tokenWatchDebounce = null; }
}

// ── Proactive token warming (P2 IDE-channel stability) ──
// Mirrors Trae's startTokenRefresher. Kiro previously only refreshed lazily on the
// request path, so a token that lapsed mid-session surfaced as a "not authorized"
// stall on the user's next message (the live failure). The warmer refreshes shortly
// before expiry while the channel is active and in recent use, keeping the next
// request's token hot. It pops NO IDE (getAccessToken is called without
// autoOpenLogin) and never keeps the event loop alive (unref'd interval).
// Pure gating predicate (extracted for deterministic testing). Returns true only
// when a proactive refresh is both safe and useful.
function _shouldWarmToken(tok, ctx = {}) {
  if (ctx.channelActive === false) return false;        // never warm a deprecated channel
  if (!ctx.recentlyActive) return false;                // only warm a channel in active use
  if (ctx.refreshing || ctx.now < ctx.backoffUntil) return false; // in flight / backing off
  if (!tok || !tok.refreshToken || !tok.expiresAt) return false;  // nothing to pre-refresh
  // Inside the pre-expiry buffer? (mirrors isTokenExpired's buffer semantics)
  return new Date(tok.expiresAt).getTime() < ctx.now + REFRESH_BUFFER_MS;
}

async function _warmTokenTick() {
  const ok = _shouldWarmToken(_cachedToken, {
    channelActive: _channelActive,
    recentlyActive: _kiroRecentlyActive(),
    refreshing: !!_refreshPromise,
    backoffUntil: _refreshBackoffUntil,
    now: Date.now(),
  });
  if (!ok) return;
  try {
    await getAccessToken();                             // dedup'd refresh; no autoOpenLogin → no IDE pop
    _lastWarmAt = Date.now();
    debugLog('proactive token warm: refreshed Kiro token ahead of expiry');
  } catch (err) {
    debugLog(`proactive token warm failed (best effort): ${err.message}`);
  }
}

function startTokenWarmer() {
  if (_warmTimer) return;
  _warmTimer = setInterval(() => { _warmTokenTick().catch(() => {}); }, KIRO_WARM_CHECK_INTERVAL_MS);
  _warmTimer.unref?.(); // never keep the event loop alive for warming alone
}

function stopTokenWarmer() {
  if (_warmTimer) { clearInterval(_warmTimer); _warmTimer = null; }
}

// Start watching on module load (best effort)
try { startTokenFileWatch(); } catch { /* ignore */ }
// Start the proactive token warmer on module load (best effort). It no-ops while
// Kiro is idle (gated on recent active use) and is unref'd, so it is harmless until
// the channel is actually used.
try { startTokenWarmer(); } catch { /* ignore */ }

/**
 * Channel lifecycle hook — called by the gateway when this adapter is selected
 * as (or removed from) the active channel.
 *
 * Goal: when the user switches away to another channel, this one must stop all
 * non-essential background work (zombie behavior) and stop escalating its
 * internal anomalies to the UI.
 *
 *   active === false  → deprecate: release the token-file watcher (no more
 *                       disk-watch-triggered refresh churn) and route anomalies
 *                       to the background debug log only.
 *   active === true   → reactivate: resume instant token-change detection.
 *
 * Idempotent and side-effect-light: watcher start/stop is cheap and guarded.
 * The 30s passive availability probe is gateway-driven (detect cache TTL) and is
 * left intact — it is essential for showing accurate channel status and must not
 * be killed (hard constraint: never disable a still-relevant background task).
 */
function setChannelActive(active) {
  const next = active !== false;
  if (next === _channelActive) return;
  _channelActive = next;
  if (next) {
    try { startTokenFileWatch(); } catch { /* best effort */ }
    try { startTokenWarmer(); } catch { /* best effort */ }
    debugLog('channel reactivated — token file watch resumed');
  } else {
    // Deprecated channel: stop the disk watcher so a background file change can
    // no longer trigger token re-reads / refresh attempts for an unused channel.
    try { stopTokenFileWatch(); } catch { /* best effort */ }
    try { stopTokenWarmer(); } catch { /* best effort */ }
    debugLog('channel deprecated — token file watch released, anomalies demoted to debug log');
  }
}

function destroy() {
  stopTokenFileWatch();
  stopTokenWarmer();
  _cachedToken = null;
  _cachedTokenSignature = '';
  _cachedAccountIdentity = '';
  _available = null;
  _installDetected = false;
  _models = [];
  resetCWModuleCache();
  _sdkClient = null;
  _sdkClientToken = null;
  _lastLoginPromptAt = 0;
  _forcePoolNext = false;
  _pendingPersist = null;
  _lastTokenProbeMs = 0;
  _refreshPromise = null;
  _refreshBackoffUntil = 0;
  _modelsFetchedAt = 0;
  resetFingerprintSession();
}

// ── Proxy change listener (registered after state vars are declared) ────
try {
  const { proxyEvents } = require('../../proxyConfigService');
  proxyEvents.on('proxy-changed', () => {
    _models = [];
    _modelsFetchedAt = 0;
    _refreshBackoffUntil = 0;
  });
} catch { /* proxyConfigService may not be loaded yet */ }

module.exports = {
  detect, detectAsync, listModels, generate, getStatus, destroy,
  getAccessToken, createSDKClient, getCWModule,
  manualRefresh, forceRefresh, getKiroTokenCandidatePaths,
  setChannelActive,
  // P2 proactive token warming — pure gating predicate + lifecycle controls (tested).
  _shouldWarmToken, startTokenWarmer, stopTokenWarmer,
};
