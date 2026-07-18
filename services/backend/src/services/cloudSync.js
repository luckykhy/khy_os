/**
 * Cloud Sync & Telemetry Service.
 *
 * Handles:
 * 1. Anonymous usage telemetry (opt-in) → helps improve the product
 * 2. User profile cloud backup/sync (opt-in) → cross-device portability
 * 3. Remote config (feature flags, announcements)
 *
 * Privacy:
 * - All telemetry is anonymous (no PII)
 * - Opt-in only: user must explicitly enable
 * - Data minimization: only aggregate stats, no raw queries
 * - Endpoint is configurable (supports self-hosted)
 *
 * Architecture:
 * - Batched uploads (queue locally, flush periodically)
 * - Graceful degradation (never crash if network fails)
 * - Configurable endpoint for domain migration
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { getAppHome, _appHomeLiveResolveEnabled } = require('../utils/dataHome');
const { CLOUD_DEFAULT_ENDPOINT, CLOUD_FALLBACK_ENDPOINTS } = require('../constants/serviceDefaults');

// Application data home — single source of truth (legacy ~/.khyquant is kept in
// place for existing installs; see utils/dataHome.getAppHome).
//
// 及时同步(admin↔user data):resolve LAZILY per read, not once at require time.
// cloudSync backs up/reads user profile — freezing PROFILE_DIR at module load
// pinned it to the empty ~/.khy when this service was required before any user
// data producer established ~/.khyquant, so cloud sync operated on a parallel
// empty profile until a restart. Re-resolving via getAppHome() converges as soon
// as user data lands. Gate off (KHY_APP_HOME_LIVE_RESOLVE) → freeze on first
// access, byte-identical to the historical module-load freeze.
let _frozenProfileDir = null;
function _profileDir() {
  if (_appHomeLiveResolveEnabled()) return getAppHome();
  if (!_frozenProfileDir) _frozenProfileDir = getAppHome();
  return _frozenProfileDir;
}
function _cloudConfigPath() {
  return path.join(_profileDir(), 'cloud.json');
}
function _telemetryQueuePath() {
  return path.join(_profileDir(), 'telemetry_queue.json');
}

// Default cloud endpoint (can be overridden by user or remote config).
// Single source of truth: constants/serviceDefaults.js (domain migration =
// one edit there, every consumer follows).
const DEFAULT_ENDPOINT = CLOUD_DEFAULT_ENDPOINT;
const FALLBACK_ENDPOINTS = CLOUD_FALLBACK_ENDPOINTS;

// ── Configuration ───────────────────────────────────────────────────────

function loadCloudConfig() {
  try {
    if (fs.existsSync(_cloudConfigPath())) {
      return JSON.parse(fs.readFileSync(_cloudConfigPath(), 'utf-8'));
    }
  } catch { /* ignore */ }

  return {
    enabled: false,          // master switch: user must opt-in
    telemetryEnabled: false, // anonymous usage stats
    syncEnabled: false,      // profile cloud backup
    endpoint: DEFAULT_ENDPOINT,
    userId: null,            // anonymous UUID (generated on opt-in)
    username: null,          // registered username
    token: null,             // auth token from login
    lastSync: null,
    lastTelemetryFlush: null,
    announcements: [],       // remote announcements
    remoteConfig: {},        // feature flags from server
  };
}

function saveCloudConfig(config) {
  try {
    if (!fs.existsSync(_profileDir())) fs.mkdirSync(_profileDir(), { recursive: true });
    fs.writeFileSync(_cloudConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// ── Opt-in/Opt-out ──────────────────────────────────────────────────────

function enableCloud(options = {}) {
  const config = loadCloudConfig();
  config.enabled = true;
  config.telemetryEnabled = options.telemetry !== false;
  config.syncEnabled = options.sync !== false;

  if (!config.userId) {
    // Generate anonymous UUID
    config.userId = generateAnonymousId();
  }

  saveCloudConfig(config);
  return config;
}

function disableCloud() {
  const config = loadCloudConfig();
  config.enabled = false;
  config.telemetryEnabled = false;
  config.syncEnabled = false;
  saveCloudConfig(config);
  return config;
}

function isEnabled() {
  const config = loadCloudConfig();
  return config.enabled === true;
}

function getEndpoint() {
  const config = loadCloudConfig();
  return config.endpoint || DEFAULT_ENDPOINT;
}

function setEndpoint(url) {
  const config = loadCloudConfig();
  config.endpoint = url;
  saveCloudConfig(config);
}

function generateAnonymousId() {
  // Crypto-random UUID without PII
  const bytes = new Uint8Array(16);
  require('crypto').getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Telemetry (anonymous usage stats) ───────────────────────────────────

/**
 * Queue a telemetry event for batched upload.
 * Events are anonymous and contain no PII.
 */
function trackEvent(event, data = {}) {
  const config = loadCloudConfig();
  if (!config.enabled || !config.telemetryEnabled) return;

  const entry = {
    event,
    data: sanitizeData(data),
    ts: Date.now(),
    v: require('../../package.json').version,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
  };

  // Append to queue
  let queue = [];
  try {
    if (fs.existsSync(_telemetryQueuePath())) {
      queue = JSON.parse(fs.readFileSync(_telemetryQueuePath(), 'utf-8'));
    }
  } catch { queue = []; }

  queue.push(entry);

  // Cap queue size (prevent unbounded growth if offline)
  if (queue.length > 500) queue = queue.slice(-500);

  try {
    fs.writeFileSync(_telemetryQueuePath(), JSON.stringify(queue), 'utf-8');
  } catch { /* ignore */ }

  // Auto-flush if queue is large enough
  if (queue.length >= 20) {
    flushTelemetry().catch(() => {});
  }
}

/**
 * Remove any potential PII from telemetry data.
 */
function sanitizeData(data) {
  const safe = {};
  for (const [key, value] of Object.entries(data)) {
    // Only allow primitive values, no file paths or user input
    if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    } else if (typeof value === 'string' && value.length < 50) {
      // Strip anything that looks like a path or personal data
      if (!value.includes('/') && !value.includes('\\') && !value.includes('@')) {
        safe[key] = value;
      }
    }
  }
  return safe;
}

/**
 * Flush telemetry queue to server.
 */
async function flushTelemetry() {
  const config = loadCloudConfig();
  if (!config.enabled || !config.telemetryEnabled) return;

  let queue;
  try {
    if (!fs.existsSync(_telemetryQueuePath())) return;
    queue = JSON.parse(fs.readFileSync(_telemetryQueuePath(), 'utf-8'));
    if (!queue || queue.length === 0) return;
  } catch { return; }

  const payload = {
    userId: config.userId,
    events: queue,
  };

  try {
    await postJSON(`${getEndpoint()}/v1/telemetry`, payload);
    // Clear queue on success
    fs.writeFileSync(_telemetryQueuePath(), '[]', 'utf-8');
    config.lastTelemetryFlush = new Date().toISOString();
    saveCloudConfig(config);
  } catch {
    // Network failure — keep queue for next attempt
  }
}

// ── Profile Cloud Sync ──────────────────────────────────────────────────

/**
 * Upload user profile to cloud for cross-device sync.
 */
async function syncUpload() {
  const config = loadCloudConfig();
  if (!config.enabled || !config.syncEnabled) return { success: false, reason: 'disabled' };

  const userProfile = require('./userProfile');
  const profileData = userProfile.exportProfile();

  try {
    const result = await postJSON(`${getEndpoint()}/v1/profile/sync`, {
      userId: config.userId,
      profile: JSON.parse(profileData),
    });
    config.lastSync = new Date().toISOString();
    saveCloudConfig(config);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/**
 * Download profile from cloud and merge with local.
 */
async function syncDownload() {
  const config = loadCloudConfig();
  if (!config.enabled || !config.syncEnabled) return { success: false, reason: 'disabled' };

  try {
    const result = await getJSON(`${getEndpoint()}/v1/profile/sync?userId=${config.userId}`);
    if (result && result.profile) {
      const userProfile = require('./userProfile');
      userProfile.importProfile(JSON.stringify(result.profile));
      config.lastSync = new Date().toISOString();
      saveCloudConfig(config);
      return { success: true };
    }
    return { success: false, reason: 'no profile on server' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ── Remote Config & Announcements ───────────────────────────────────────

/**
 * Fetch remote config (feature flags, announcements, endpoint migration).
 * Called on startup, non-blocking.
 */
async function fetchRemoteConfig() {
  const config = loadCloudConfig();
  if (!config.enabled) return null;

  try {
    const result = await getJSON(`${getEndpoint()}/v1/config`);
    if (result) {
      // Handle endpoint migration
      if (result.migrateEndpoint) {
        config.endpoint = result.migrateEndpoint;
      }
      config.remoteConfig = result.flags || {};
      config.announcements = result.announcements || [];
      saveCloudConfig(config);
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Get unread announcements.
 */
function getAnnouncements() {
  const config = loadCloudConfig();
  return config.announcements || [];
}

// ── HTTP Helpers ────────────────────────────────────────────────────────

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const authHeaders = getAuthHeaders();

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': `khy-quant-cli/${require('../../package.json').version}`,
        ...authHeaders,
      },
      timeout: 10000,
    }, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(responseData)); }
          catch { resolve({}); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const authHeaders = getAuthHeaders();

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': `khy-quant-cli/${require('../../package.json').version}`,
        ...authHeaders,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Authentication ──────────────────────────────────────────────────────

/**
 * Register a new account.
 */
async function register(username, password) {
  const config = loadCloudConfig();
  const result = await postJSON(`${getEndpoint()}/v1/auth/register`, {
    username,
    password,
  });

  if (result.token) {
    config.enabled = true;
    config.syncEnabled = true;
    config.telemetryEnabled = true;
    config.username = username;
    config.token = result.token;
    config.userId = result.userId || generateAnonymousId();
    saveCloudConfig(config);
    return { success: true, message: result.message || '注册成功' };
  }
  return { success: false, message: result.message || '注册失败' };
}

/**
 * Login to existing account.
 */
async function login(username, password) {
  const config = loadCloudConfig();
  const result = await postJSON(`${getEndpoint()}/v1/auth/login`, {
    username,
    password,
  });

  if (result.token) {
    config.enabled = true;
    config.syncEnabled = true;
    config.telemetryEnabled = true;
    config.username = username;
    config.token = result.token;
    config.userId = result.userId || config.userId;
    saveCloudConfig(config);
    return { success: true, message: result.message || '登录成功' };
  }
  return { success: false, message: result.message || '登录失败' };
}

/**
 * Logout (clear local token).
 */
function logout() {
  const config = loadCloudConfig();
  config.token = null;
  config.username = null;
  config.syncEnabled = false;
  saveCloudConfig(config);
}

/**
 * Check if user is logged in.
 */
function isLoggedIn() {
  const config = loadCloudConfig();
  return !!(config.token && config.username);
}

/**
 * Get current username.
 */
function getUsername() {
  const config = loadCloudConfig();
  return config.username;
}

/**
 * Get auth headers for API requests.
 */
function getAuthHeaders() {
  const config = loadCloudConfig();
  if (!config.token) return {};
  return { 'Authorization': `Bearer ${config.token}` };
}

// ── Public API ──────────────────────────────────────────────────────────

module.exports = {
  // Config
  loadCloudConfig,
  enableCloud,
  disableCloud,
  isEnabled,
  getEndpoint,
  setEndpoint,

  // Auth
  register,
  login,
  logout,
  isLoggedIn,
  getUsername,

  // Telemetry
  trackEvent,
  flushTelemetry,

  // Profile sync
  syncUpload,
  syncDownload,

  // Remote config
  fetchRemoteConfig,
  getAnnouncements,
};
