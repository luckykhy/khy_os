/**
 * AI Management Backend Server
 *
 * Standalone HTTP + WebSocket server on a separate port (default 9090).
 * Acts as a "web branch" of the CLI — same AI gateway, adapters, tools,
 * security, and token tracking, but accessible over REST and WS.
 *
 * Pattern: raw http.createServer (like proxyServer.js), no Express dependency.
 * Exports: { start, stop, isRunning, getPort }
 */
const http = require('http');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getDataHome } = require('../utils/dataHome');
const { hashApiKey } = require('@khy/shared/utils/apiKeyHash');
const { parseApiKeyEntries } = require('./apiKeyFormat');
const { OLLAMA_HOST: _OLLAMA_HOST_DEFAULT } = require('../constants/serviceDefaults');
// Model-name SSOT: ollama default model flows from constants/models.js
// (env OLLAMA_MODEL still overrides first).
const { PRIMARY: MODELS } = require('../constants/models');
const { resolveAnthropicBaseUrl } = require('../utils/proxyBaseUrl');

// ── Module state ──────────────────────────────────────────────
let _server = null;
let _wss = null;
const _sessions = new Map();
let _startTime = 0;
let _port = 0;
let _heartbeatTimer = null;
let _autoImportLastAt = 0;
let _autoImportSummary = null;
let _lastGatewayAssetsSnapshot = null;

const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min idle timeout
const AUTH_TIMEOUT_MS = 30 * 1000;       // 30s to authenticate
const GC_INTERVAL_MS = 30 * 1000;        // 30s heartbeat / GC sweep
const MAX_BODY_BYTES = 1 * 1024 * 1024;  // 1 MB body limit
const KHY_DIR = getDataHome();
const CONVO_DIR = path.join(KHY_DIR, 'conversations');
const ACCOUNT_CB_FILE = path.join(KHY_DIR, 'account_pool_circuit_breaker.json');
const AUTO_IMPORT_INTERVAL_MS = Math.max(
  15000,
  parseInt(process.env.AI_GATEWAY_AUTO_IMPORT_INTERVAL_MS || '60000', 10) || 60000
);
const AUTO_IMPORT_ACCOUNT_PROVIDERS = ['kiro', 'cursor', 'trae', 'windsurf', 'warp', 'nirvana'];
const DEFAULT_ACCOUNT_CIRCUIT_BREAKER = Object.freeze({
  enabled: false,
  backoffSteps: [60, 300, 1800, 7200],
});
const DEFAULT_PLUGIN_TEMPLATE = `/**
 * Gateway Plugin Template
 * Hooks: onBeforeRequest, onAfterResponse, onError, onStream
 */
module.exports = {
  name: 'my-plugin',
  priority: 100,
  enabled: true,
  hooks: {
    async onBeforeRequest(ctx, next) {
      return next(ctx);
    },
    async onAfterResponse(ctx, next) {
      return next(ctx);
    },
    async onError(ctx, next) {
      return next(ctx);
    },
    onStream(chunk) {
      return chunk;
    },
  },
};
`;

// In-memory rate limiter
const _rateLimits = new Map(); // ip -> { count, windowStart }

// ── Lazy module loaders ───────────────────────────────────────
let _gateway, _ai, _toolCalling, _security, _tokenUsage;
let _apiKeyPool, _accountPool, _aiMonitor, _oauthManager;
// Test-only seam: lets a unit test inject a fake account pool so route-dispatch
// can be asserted without mutating real local credential state. Null in prod.
let _accountPoolOverrideForTest = null;
let _pluginChain, _tlsSidecar, _protocolConverter, _concurrencySlots;
let _proxyServer, _customerRegistry, _modelRouter, _paymentGatewayService;
let _wfApp;
let _userGatewayApp;
let _adminApp;
let _gatewayBillingApp;
let _aiUploadApp;
let _marketplaceApp;
let _pluginsApp;
let _proxySubApp;
let _commandsApp;
let _frontendStaticDir = '';
let _frontendEntryPath = '/admin/ai-gateway';

function getGateway() { return (_gateway ??= require('./gateway/aiGateway')); }
function getAi() { return (_ai ??= require('../cli/ai')); }

// Per-turn correlation id for the chat transport handlers (SSE + WS). Threaded
// into the chat options so traceAuditService stamps every stage under it, and
// echoed on any terminal failsafe `error` event so the frontend can drill from
// the human-readable card down to the server-side staged timeline.
let _chatRequestSeq = 0;
function _genChatRequestId() {
  _chatRequestSeq = (_chatRequestSeq + 1) % 1e6;
  return `req_${Date.now().toString(36)}_${_chatRequestSeq.toString(36)}`;
}
function getToolCalling() { return (_toolCalling ??= require('./toolCalling')); }
function getSecurity() { return (_security ??= require('./securityGuardService')); }
function getTokenUsage() { return (_tokenUsage ??= require('./tokenUsageService')); }
function getApiKeyPool() { return (_apiKeyPool ??= require('./apiKeyPool')); }
function getAccountPool() { return _accountPoolOverrideForTest || (_accountPool ??= require('./accountPool')); }
function getAiMonitor() { return (_aiMonitor ??= require('./aiMonitor')); }
function getOauthManager() { return (_oauthManager ??= require('./gateway/oauthManager')); }
function getPluginChain() { return (_pluginChain ??= require('./gateway/pluginChain')); }
function getTlsSidecar() { return (_tlsSidecar ??= require('./gateway/tlsSidecar')); }
function getProtocolConverter() { return (_protocolConverter ??= require('./gateway/protocolConverter')); }
function getConcurrencySlots() { return (_concurrencySlots ??= require('./concurrencySlots')); }
function getProxyServer() { return (_proxyServer ??= require('./gateway/proxyServer')); }
function getCustomerRegistry() { return (_customerRegistry ??= require('./gateway/customerRegistry')); }
function getModelRouter() { return (_modelRouter ??= require('./gateway/modelRouter')); }
function getPaymentGatewayService() { return (_paymentGatewayService ??= require('./gateway/paymentGatewayService')); }

function getWorkflowApp() {
  if (_wfApp) return _wfApp;
  const express = require('express');
  const limit = String(process.env.KHY_WORKFLOW_BODY_LIMIT || '5mb').trim() || '5mb';
  const a = express();
  // Coze collection uploads (base64 of a 200+ workflow zip) dwarf a normal graph
  // save; give the import paths a larger, env-tunable limit BEFORE the general
  // parser, which then no-ops for them. Keeps the rest of the workflow API tight.
  const cozeLimit = String(process.env.KHY_COZE_UPLOAD_LIMIT || '64mb').trim() || '64mb';
  a.use('/api/workflow/import/coze', express.json({ limit: cozeLimit }));
  a.use(express.json({ limit }));
  // Reuse ai-backend's mature workflow router; its deps live in @khy/shared and resolve from here too.
  a.use('/api/workflow', require('../../../ai-backend/src/routes/workflow'));
  return (_wfApp = a);
}

// User-gateway namespace: per-user model config, custom providers, CC tokens.
// Reuses ai-backend's userGateway router (auth applied at router level: authenticateToken).
function getUserGatewayApp() {
  if (_userGatewayApp) return _userGatewayApp;
  const express = require('express');
  const limit = String(process.env.KHY_USER_GATEWAY_BODY_LIMIT || '2mb').trim() || '2mb';
  const a = express();
  a.use(express.json({ limit }));
  a.use('/api/user-gateway', require('../../../ai-backend/src/routes/userGateway'));
  return (_userGatewayApp = a);
}

// Plugin marketplace namespace: per-user, Coze-compatible OpenAPI tool catalog
// (browse / install / uninstall). Reuses ai-backend's marketplace router (auth at
// router level: authenticateToken). Without this the frontend Marketplace page
// 404s — the router was only mounted in ai-backend's standalone server, which does
// not serve the frontend on this daemon.
function getMarketplaceApp() {
  if (_marketplaceApp) return _marketplaceApp;
  const express = require('express');
  const limit = String(process.env.KHY_MARKETPLACE_BODY_LIMIT || '2mb').trim() || '2mb';
  const a = express();
  a.use(express.json({ limit }));
  a.use('/api/marketplace', require('../../../ai-backend/src/routes/marketplace'));
  return (_marketplaceApp = a);
}

// Installed-plugins namespace: per-user plugin instances + their executable tools
// (import / preview / auth / test). Distinct from /api/ai-gateway/plugins (the
// gateway plugin-chain). Reuses ai-backend's plugins router (auth at router level:
// authenticateToken). Imports of an OpenAPI spec can be larger than a normal body,
// so allow an env-tunable limit (matches the spirit of the workflow coze limit).
function getPluginsApp() {
  if (_pluginsApp) return _pluginsApp;
  const express = require('express');
  const limit = String(process.env.KHY_PLUGINS_BODY_LIMIT || '8mb').trim() || '8mb';
  const a = express();
  a.use(express.json({ limit }));
  a.use('/api/plugins', require('../../../ai-backend/src/routes/plugins'));
  return (_pluginsApp = a);
}

// Proxy-subscriptions namespace: import/manage upstream proxy subscription groups
// (SSRF-guarded, storage is file-based ~/.khyquant/proxy.json — no DB dep). Unlike the
// sibling ai-backend routers, proxySubscription does NOT self-authenticate: the monolith
// server.js applied authMiddleware at the mount point (server.js:533). We mirror that
// here — authenticateToken populates req.user, which the router's _ownerId(req) reads as
// req.user.id. Without this mount the daemon 404s /api/proxy-subscriptions (the route
// only ever existed on the monolith, which does not run on this khychat daemon).
function getProxySubscriptionApp() {
  if (_proxySubApp) return _proxySubApp;
  const express = require('express');
  const limit = String(process.env.KHY_PROXY_SUB_BODY_LIMIT || '2mb').trim() || '2mb';
  const a = express();
  a.use(express.json({ limit }));
  const { authenticateToken } = require('../../../ai-backend/src/middleware/auth');
  a.use('/api/proxy-subscriptions', authenticateToken, require('../routes/proxySubscription'));
  return (_proxySubApp = a);
}

// Command-catalog namespace: the read-only 「功能索引 / Feature Index」 reference the
// FeatureCatalog.vue page fetches (GET /api/commands). Data comes from the same SSOT as
// the TUI `/features` command (commandCatalog.buildCommandCatalog); the router is public,
// fail-soft (never 500), and self-contains its logic. Without this mount the daemon 404s
// /api/commands — the route only ever existed on the monolith server.js, which does not
// run on this khychat daemon — so the page shows "Not found / 功能索引暂时加载不出来".
function getCommandsApp() {
  if (_commandsApp) return _commandsApp;
  const express = require('express');
  const a = express();
  a.use(express.json({ limit: '256kb' }));
  a.use('/api/commands', require('../routes/commands'));
  return (_commandsApp = a);
}

// Admin namespace: agent dashboard and other admin-only operations.
// Reuses the monolith aiGatewayAdmin router (auth at router level: authenticateToken + requireAdmin).
function getAdminApp() {
  if (_adminApp) return _adminApp;
  const express = require('express');
  const limit = String(process.env.KHY_ADMIN_BODY_LIMIT || '5mb').trim() || '5mb';
  const a = express();
  a.use(express.json({ limit }));
  a.use('/api/ai-gateway-admin', require('../routes/aiGatewayAdmin'));
  return (_adminApp = a);
}

// AI-gateway billing namespace: usage, pricing, groups, rate-limits.
// The daemon's handleAiGatewayNamespace owns the operational ai-gateway routes; these
// billing reports live only in ai-backend's aiGatewayAdmin router, so mount that router
// under /api/ai-gateway and let Express 404 the paths the daemon already serves natively.
function getGatewayBillingApp() {
  if (_gatewayBillingApp) return _gatewayBillingApp;
  const express = require('express');
  const limit = String(process.env.KHY_GATEWAY_BILLING_BODY_LIMIT || '2mb').trim() || '2mb';
  const a = express();
  a.use(express.json({ limit }));
  a.use('/api/ai-gateway', require('../../../ai-backend/src/routes/aiGatewayAdmin'));
  return (_gatewayBillingApp = a);
}

// AI chat attachment namespace: multipart upload + download of images / video /
// audio / documents / archives the chat page lets users attach. multipart can't
// go through the raw 1 MB parseBody, so it lives in a lazy Express sub-app with
// multer (resolved from the repo-root node_modules). Auth mirrors the rest of
// the daemon (Bearer / X-API-Key via authenticateRequest). Uploaded files are
// committed to getDataDir('ai-uploads') and referenced from chat by opaque id.
function getAiUploadApp() {
  if (_aiUploadApp) return _aiUploadApp;
  const express = require('express');
  const multer = require('multer');
  const uploadStore = require('./aiUploadStore');

  const a = express();

  const expressAuth = async (req, res, next) => {
    try {
      const auth = await authenticateRequest(req);
      if (!auth.ok) {
        return res.status(401).json({ success: false, message: auth.error || 'Authentication required' });
      }
      req.authUser = auth.user || null;
      next();
    } catch (err) {
      res.status(500).json({ success: false, message: `Auth check failed: ${err.message}` });
    }
  };

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => cb(null, `khy-upload-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  });
  const upload = multer({ storage, limits: { fileSize: uploadStore.maxFileBytes(), files: 10 } });

  // Accept one or many files under field "file" (or "files").
  a.post('/api/ai/upload', expressAuth, (req, res) => {
    upload.any()(req, res, async (err) => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
          success: false,
          message: tooBig
            ? `文件超过上限（${uploadStore.humanSize(uploadStore.maxFileBytes())}）`
            : `上传失败：${err.message}`,
        });
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) {
        return res.status(400).json({ success: false, message: '未收到文件（字段名应为 file）' });
      }
      const attachments = [];
      for (const f of files) {
        try {
          // commitAndEnrich also extracts PDF/Office body text and transcribes
          // audio/video at upload time (fail-soft) so the model sees real content.
          const manifest = await uploadStore.commitAndEnrich({
            tempPath: f.path,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size: f.size,
          });
          attachments.push(uploadStore.toDescriptor(manifest));
        } catch (e) {
          try { require('fs').unlinkSync(f.path); } catch { /* ignore */ }
          return res.status(500).json({ success: false, message: `保存附件失败：${e.message}` });
        }
      }
      return res.json({ success: true, attachments });
    });
  });

  // Download / preview a committed attachment by id.
  a.get('/api/ai/upload/:id', expressAuth, (req, res) => {
    const manifest = uploadStore.getUpload(req.params.id);
    if (!manifest) return res.status(404).json({ success: false, message: '附件不存在或已过期' });
    res.setHeader('Content-Type', manifest.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(manifest.originalName)}`);
    require('fs').createReadStream(manifest.storedPath)
      .on('error', () => { if (!res.headersSent) res.status(500).end(); })
      .pipe(res);
  });

  return (_aiUploadApp = a);
}

// ── Utility functions ─────────────────────────────────────────

const STATIC_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
});

function normalizeWebPath(pathname = '/admin/ai-gateway') {
  const raw = String(pathname || '').trim();
  if (!raw) return '/admin/ai-gateway';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function configureFrontendStatic(options = {}) {
  const requestedDir = String(options?.distDir || '').trim();
  if (!requestedDir) {
    _frontendStaticDir = '';
    _frontendEntryPath = normalizeWebPath(options?.entryPath || '/admin/ai-gateway');
    return { enabled: false, reason: 'no-dist-dir' };
  }

  const resolved = path.resolve(requestedDir);
  const indexFile = path.join(resolved, 'index.html');
  if (!fs.existsSync(indexFile)) {
    _frontendStaticDir = '';
    _frontendEntryPath = normalizeWebPath(options?.entryPath || '/admin/ai-gateway');
    return { enabled: false, reason: `missing-index: ${indexFile}` };
  }

  _frontendStaticDir = resolved;
  _frontendEntryPath = normalizeWebPath(options?.entryPath || '/admin/ai-gateway');
  return { enabled: true, distDir: _frontendStaticDir, entryPath: _frontendEntryPath };
}

function _contentTypeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return STATIC_CONTENT_TYPES[ext] || 'application/octet-stream';
}

function _isWithinDir(rootDir, targetPath) {
  const normalizedRoot = path.resolve(rootDir);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function _sendStaticFile(req, res, absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return false;
    const body = fs.readFileSync(absPath);
    const headers = {
      'Content-Type': _contentTypeFor(absPath),
      'Content-Length': body.length,
    };
    if (path.basename(absPath) === 'index.html') {
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function _resolveStaticPath(distDir, relativePath) {
  const normalized = String(relativePath || '')
    .replace(/^\/+/, '')
    .replace(/\\/g, '/');
  const resolved = path.resolve(distDir, normalized);
  if (!_isWithinDir(distDir, resolved)) return null;
  return resolved;
}

function tryHandleFrontendStatic(req, res, pathname) {
  if (!_frontendStaticDir) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/') || pathname === '/ws') return false;

  const entry = _frontendEntryPath || '/admin/ai-gateway';
  if (pathname === '/') {
    res.writeHead(302, { Location: entry });
    res.end();
    return true;
  }

  // Vite build assets are usually absolute "/assets/*".
  if (pathname.startsWith('/assets/')) {
    const filePath = _resolveStaticPath(_frontendStaticDir, pathname);
    if (!filePath) return false;
    return _sendStaticFile(req, res, filePath);
  }

  // Vite copies public/vendor/* verbatim to dist/vendor/* (e.g. the MarkText/muya
  // WYSIWYG bundle khyos-muya.{css,js}). These are public static like /assets/* and
  // MUST be served pre-auth; otherwise they fall through to the auth gate and 401.
  // Miss → 404 (never fall through, which would surface a misleading 401).
  if (pathname.startsWith('/vendor/')) {
    const filePath = _resolveStaticPath(_frontendStaticDir, pathname);
    if (filePath && _sendStaticFile(req, res, filePath)) return true;
    sendError(res, 404, 'Not found');
    return true;
  }

  if (pathname === '/favicon.ico' || pathname === '/manifest.json' || pathname === '/robots.txt') {
    const filePath = _resolveStaticPath(_frontendStaticDir, pathname);
    if (!filePath || !_sendStaticFile(req, res, filePath)) {
      sendError(res, 404, 'Not found');
      return true;
    }
    return true;
  }

  if (pathname === entry || pathname === `${entry}/`) {
    const indexPath = path.join(_frontendStaticDir, 'index.html');
    if (_sendStaticFile(req, res, indexPath)) return true;
    sendError(res, 500, 'Frontend static index not found');
    return true;
  }

  if (pathname.startsWith(`${entry}/`)) {
    const innerPath = pathname.slice(entry.length + 1);
    const candidate = _resolveStaticPath(_frontendStaticDir, innerPath);
    if (candidate && _sendStaticFile(req, res, candidate)) return true;

    // SPA fallback
    const indexPath = path.join(_frontendStaticDir, 'index.html');
    if (_sendStaticFile(req, res, indexPath)) return true;
    sendError(res, 500, 'Frontend static index not found');
    return true;
  }

  return false;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function corsHeaders() {
  const origins = process.env.AI_MGMT_CORS_ORIGINS || '*';
  return {
    'Access-Control-Allow-Origin': origins,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { success: false, error: message });
}

// ── Gateway read-through cache ────────────────────────────────
// Read-heavy gateway GETs (the model catalog graph, the per-adapter model
// listing) rebuild expensive structures — the catalog can fan out remote model
// discovery, the model list fans out one listModels() round-trip per adapter.
// On a fresh page load every multi-pivot view requests these, so we serve them
// from Redis (with an in-process Map fallback when Redis is down — see
// cacheService) under a short TTL, and invalidate on any gateway mutation.
const _gatewayCache = require('./cacheService');
const _GATEWAY_CACHE_PREFIX = 'aigw:';

// Default on. Disable with KHY_GATEWAY_CACHE=0; tune freshness with
// KHY_GATEWAY_CACHE_TTL (seconds). Zero hardcoding — both are env-driven.
function gatewayCacheEnabled() {
  return String(process.env.KHY_GATEWAY_CACHE ?? '1') !== '0';
}

function gatewayCacheTtl() {
  const ttl = Number(process.env.KHY_GATEWAY_CACHE_TTL);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 60;
}

// Read-through: return the cached payload for `key`, else run `producer()`,
// store its result, and return it. Cache faults never break the request — on
// any error we fall through to a live produce.
async function cachedGatewayPayload(key, producer, ttl = gatewayCacheTtl()) {
  if (!gatewayCacheEnabled()) return producer();
  try {
    const hit = await _gatewayCache.get(key);
    if (hit != null) return hit;
  } catch { /* fall through to live produce */ }
  const value = await producer();
  // Only cache real payloads, never null/undefined (which would mask misses).
  if (value != null) {
    try { await _gatewayCache.set(key, value, ttl); } catch { /* best-effort */ }
  }
  return value;
}

// Overwrite a cache entry (used by ?live=1 catalog refresh to warm the default).
async function writeGatewayCache(key, value, ttl = gatewayCacheTtl()) {
  if (!gatewayCacheEnabled() || value == null) return;
  try { await _gatewayCache.set(key, value, ttl); } catch { /* best-effort */ }
}

// Drop every gateway read cache. Called after any mutation so the next read
// recomputes. Over-invalidation is cheap (one recompute) and keeps correctness
// trivial — no per-key bookkeeping across dozens of mutating handlers.
async function invalidateGatewayCache() {
  if (!gatewayCacheEnabled()) return;
  try { await _gatewayCache.clearByPrefix(_GATEWAY_CACHE_PREFIX); } catch { /* best-effort */ }
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || '127.0.0.1';
}

// Strip the IPv4-mapped-IPv6 prefix (Node reports `::ffff:10.0.0.5` for IPv4
// peers on a dual-stack socket) so range checks below see a plain IPv4 string.
function normalizeIp(ip) {
  const s = String(ip || '');
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function isLoopbackIp(ip) {
  const v = normalizeIp(ip);
  return v === '127.0.0.1' || v === '::1';
}

function isLocalIp(ip) {
  const v = normalizeIp(ip);
  return v === '127.0.0.1' || v === '::1'
    || v.startsWith('192.168.') || v.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(v);
}

function safeJsonParse(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeCircuitBreakerConfig(input = {}) {
  const src = (input && typeof input === 'object') ? input : {};
  const enabled = src.enabled === true;
  const backoffSteps = Array.isArray(src.backoffSteps)
    ? src.backoffSteps.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0)
    : [];
  return {
    enabled,
    backoffSteps: backoffSteps.length > 0
      ? [...new Set(backoffSteps)]
      : [...DEFAULT_ACCOUNT_CIRCUIT_BREAKER.backoffSteps],
  };
}

function readAccountCircuitBreakerConfig() {
  try {
    if (!fs.existsSync(ACCOUNT_CB_FILE)) {
      return { ...DEFAULT_ACCOUNT_CIRCUIT_BREAKER };
    }
    const parsed = safeJsonParse(fs.readFileSync(ACCOUNT_CB_FILE, 'utf-8'), DEFAULT_ACCOUNT_CIRCUIT_BREAKER);
    return normalizeCircuitBreakerConfig(parsed);
  } catch {
    return { ...DEFAULT_ACCOUNT_CIRCUIT_BREAKER };
  }
}

function saveAccountCircuitBreakerConfig(next = {}) {
  const normalized = normalizeCircuitBreakerConfig(next);
  fs.mkdirSync(path.dirname(ACCOUNT_CB_FILE), { recursive: true });
  const tmpPath = `${ACCOUNT_CB_FILE}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf-8');
  fs.renameSync(tmpPath, ACCOUNT_CB_FILE);
  return normalized;
}

function sanitizePluginName(raw) {
  return String(raw || '').trim().replace(/\.js$/i, '');
}

function getPluginFilePath(pluginName) {
  const normalized = sanitizePluginName(pluginName);
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error('invalid plugin name');
  }
  const chain = getPluginChain();
  return path.join(chain.getPluginsDir(), `${normalized}.js`);
}

// ── Authentication ────────────────────────────────────────────

/**
 * Authenticate an HTTP request or WebSocket token.
 * Dual-mode: Full (JWT + API Key via DB) or Lightweight (env token).
 * @param {string|null} bearerToken - Bearer token from Authorization header
 * @param {string|null} apiKey - X-API-Key header value
 * @param {{ clientIp?: string }} [opts] - request metadata for trusted-network bypass
 * @returns {Promise<{ ok: boolean, user?: object, method?: string, error?: string }>}
 */
async function authenticate(bearerToken, apiKey, opts = {}) {
  const clientIp = opts.clientIp || '';

  // Dev bypass
  if (process.env.AI_MGMT_SKIP_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    return { ok: true, user: { id: 0, role: 'admin' }, method: 'skip' };
  }

  // Lightweight mode: simple token comparison
  const envToken = process.env.AI_MGMT_AUTH_TOKEN;
  if (envToken) {
    if (bearerToken === envToken) return { ok: true, user: { id: 0, role: 'user' }, method: 'token' };
    if (apiKey === envToken) return { ok: true, user: { id: 0, role: 'user' }, method: 'token' };
    // If env token is set, only accept that token (don't fall through to DB)
    return { ok: false, error: 'Invalid token' };
  }

  // Full mode: JWT + API Key via Sequelize models
  if (process.env.JWT_SECRET) {
    try {
      const jwt = require('jsonwebtoken');
      const { User, ApiKey: ApiKeyModel } = require('../models');
      const { QueryTypes } = require('sequelize');

      async function findApiKeyUser(rawApiKey) {
        const keyHash = hashApiKey(rawApiKey);

        // Preferred path: modern key_hash contract.
        try {
          const record = await ApiKeyModel.findOne({
            where: { keyHash, isActive: true },
            include: [{ model: User, as: 'user' }],
          });
          if (record?.user) {
            return {
              user: record.user,
              touch: () => record.update({ lastUsedAt: new Date() }).catch(() => {}),
            };
          }
        } catch {
          // fallback path below
        }

        // Raw SQL compatibility for mixed/legacy table schemas.
        try {
          const { sequelize } = require('../models');
          const queryInterface = sequelize.getQueryInterface();
          const schema = await queryInterface.describeTable('api_keys');
          const whereParts = [];
          if (Object.prototype.hasOwnProperty.call(schema, 'key_hash')) whereParts.push('key_hash = :keyHash');
          // Legacy "key" column no longer queried — seed.js backfills key_hash.
          if (whereParts.length === 0) return null;
          const activeClause = Object.prototype.hasOwnProperty.call(schema, 'is_active') ? 'AND is_active = :isActive' : '';
          const rows = await sequelize.query(
            `SELECT id, user_id
               FROM api_keys
              WHERE (${whereParts.join(' OR ')})
                ${activeClause}
              ORDER BY id DESC
              LIMIT 1`,
            {
              replacements: {
                keyHash,
                isActive: true,
              },
              type: QueryTypes.SELECT,
            }
          );
          const row = rows[0];
          if (!row) return null;
          const userId = Number(row.user_id || row.userId || 0);
          if (!userId) return null;
          const user = await User.findByPk(userId);
          if (!user) return null;
          const touch = async () => {
            if (!Object.prototype.hasOwnProperty.call(schema, 'last_used_at')) return;
            try {
              await sequelize.query(
                'UPDATE api_keys SET last_used_at = :lastUsedAt WHERE id = :id',
                {
                  replacements: { lastUsedAt: new Date(), id: Number(row.id) || 0 },
                  type: QueryTypes.UPDATE,
                }
              );
            } catch {
              // best effort
            }
          };
          return { user, touch };
        } catch {
          return null;
        }
      }

      // Path A: JWT Bearer
      if (bearerToken) {
        try {
          const authSessionService = require('./authSessionService');
          const authResult = await authSessionService.authenticateAccessToken(bearerToken, { touch: false });
          if (!authResult?.ok || !authResult.user) {
            const errorMessage = authResult?.code === 'token_expired'
              ? 'Token expired'
              : (authResult?.code === 'user_inactive' ? 'Account disabled' : 'Invalid token');
            return { ok: false, error: errorMessage };
          }
          return { ok: true, user: authResult.user, method: authResult.legacy ? 'jwt-legacy' : 'jwt' };
        } catch { /* JWT invalid — fall through */ }
      }

      // Path B: X-API-Key
      if (apiKey) {
        const matched = await findApiKeyUser(apiKey);
        if (!matched?.user) return { ok: false, error: 'Invalid API key' };
        if (matched.user.status !== 'active') return { ok: false, error: 'Account disabled' };
        matched.touch?.();
        return { ok: true, user: matched.user, method: 'apiKey' };
      }
    } catch {
      // Models not available (CLI-only mode) — no auth possible
    }
  }

  // No auth mechanism configured (no AI_MGMT_AUTH_TOKEN, no JWT_SECRET).
  // Allow trusted-network access so the local UI — and a phone scanning the
  // `mobile` QR on the same LAN — works without first setting up auth.
  //   - Loopback is always trusted outside production (realizes the previously
  //     documented-but-unimplemented "dev localhost" behaviour).
  //   - Private-LAN peers are trusted only when AI_MGMT_ALLOW_LAN is opted in,
  //     since a phone reaches the server over the LAN, not loopback.
  // Whenever real auth (token/JWT) IS configured, the paths above already
  // enforced it and we never reach here — this bypass cannot weaken it.
  if (!process.env.AI_MGMT_AUTH_TOKEN && !process.env.JWT_SECRET) {
    const isProd = process.env.NODE_ENV === 'production';
    if (isLoopbackIp(clientIp) && !isProd) {
      return { ok: true, user: { id: 0, role: 'admin' }, method: 'local-dev' };
    }
    if (parseBooleanLike(process.env.AI_MGMT_ALLOW_LAN, false) && isLocalIp(clientIp)) {
      return { ok: true, user: { id: 0, role: 'user' }, method: 'lan' };
    }
  }

  return {
    ok: false,
    error: 'Authentication required (set AI_MGMT_AUTH_TOKEN or JWT_SECRET; for trusted-LAN phone access set AI_MGMT_ALLOW_LAN=true)',
  };
}

/**
 * Authenticate an HTTP request. Extracts credentials from headers.
 */
async function authenticateRequest(req, clientIp) {
  const bearerToken = req.headers.authorization?.split(' ')[1] || null;
  const apiKey = req.headers['x-api-key'] || null;
  return authenticate(bearerToken, apiKey, { clientIp: clientIp || getClientIp(req) });
}

function sanitizeAuthUser(user) {
  if (!user) return null;
  if (typeof user.toJSON === 'function') {
    const data = user.toJSON();
    if (data && typeof data === 'object') {
      delete data.password;
      delete data.securityAnswer;
      delete data.sendKey;
    }
    return data;
  }
  return {
    id: user.id ?? 0,
    username: user.username || 'user',
    email: user.email || '',
    role: user.role || 'user',
    status: user.status || 'active',
  };
}

function isManagerLikeUser(user) {
  return Number(user?.id || 0) === 0 || String(user?.role || '').trim().toLowerCase() === 'admin';
}

function requireManagerAccess(req, res) {
  const user = req?.authContext?.user || req?.user || null;
  if (isManagerLikeUser(user)) return user;
  sendJson(res, 403, { success: false, message: '需要管理员权限' });
  return null;
}

async function verifyAuthPassword(user, password) {
  if (!user || typeof user.comparePassword !== 'function') return false;
  let isValid = await user.comparePassword(password);

  // Compatibility bridge: allow historical default admin password without trailing dot.
  // 登记:'admin123' / 'admin123.' 为示范默认口令(首次登录默认账号 admin),非真实凭据。pragma: allowlist secret
  if (!isValid && String(user.username || '').toLowerCase() === 'admin' && password === 'admin123') { // pragma: allowlist secret
    const legacyMatched = await user.comparePassword('admin123.'); // pragma: allowlist secret
    if (legacyMatched) {
      isValid = true;
      try {
        await user.update({ password: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123' }); // pragma: allowlist secret
      } catch {
        // best effort password migration
      }
    }
  }
  return isValid;
}

function issueAuthJwt(userId) {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

async function handleAuthLogin(req, res) {
  const body = await parseBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    return sendJson(res, 400, { success: false, message: 'Username and password are required' });
  }

  const envToken = String(process.env.AI_MGMT_AUTH_TOKEN || '').trim();
  if (envToken) {
    if (password === envToken || username === envToken) {
      return sendJson(res, 200, {
        success: true,
        message: 'Login successful',
        data: {
          token: envToken,
          user: { id: 0, username: 'token-user', role: 'user', status: 'active' },
        },
      });
    }
    return sendJson(res, 401, { success: false, message: 'Invalid username or password' });
  }

  if (process.env.AI_MGMT_SKIP_AUTH === 'true' && process.env.NODE_ENV !== 'production') {
    const fakeToken = process.env.AI_MGMT_DEV_TOKEN || 'ai-mgmt-skip-auth';
    return sendJson(res, 200, {
      success: true,
      message: 'Login successful',
      data: {
        token: fakeToken,
        user: { id: 0, username: username || 'dev-admin', role: 'admin', status: 'active' },
      },
    });
  }

  // Built-in accounts (CLI-defined, no database required)
  try {
    const cliAuth = require('./cliAuthService');
    const builtinResult = await cliAuth.login(username, password);
    if (builtinResult.success && builtinResult.source === 'builtin') {
      const builtinToken = `builtin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return sendJson(res, 200, {
        success: true,
        message: 'Login successful',
        data: {
          token: builtinToken,
          user: { id: 0, username: builtinResult.username, role: builtinResult.role || 'user', status: 'active' },
        },
      });
    }
  } catch { /* cliAuthService not available, continue to DB login */ }

  if (!process.env.JWT_SECRET) {
    return sendJson(res, 500, {
      success: false,
      message: 'JWT_SECRET is not configured for username/password login',
    });
  }

  try {
    const { Op } = require('sequelize');
    const { User } = require('../models');
    const user = await User.findOne({
      where: {
        [Op.or]: [
          { username },
          { email: username },
        ],
      },
    });

    if (!user) {
      return sendJson(res, 401, { success: false, message: 'Invalid username or password' });
    }
    if (user.status !== 'active') {
      return sendJson(res, 403, { success: false, message: 'Account is not active' });
    }

    const isPasswordValid = await verifyAuthPassword(user, password);
    if (!isPasswordValid) {
      return sendJson(res, 401, { success: false, message: 'Invalid username or password' });
    }

    try {
      await user.update({ lastLoginAt: new Date() });
    } catch {
      // non-blocking
    }

    const authSessionService = require('./authSessionService');
    const authData = authSessionService.createAuthResponseData(
      user,
      await authSessionService.issueSessionForUser(user, req, { authMethod: 'password' })
    );
    return sendJson(res, 200, {
      success: true,
      message: 'Login successful',
      data: {
        ...authData,
        user: sanitizeAuthUser(user),
      },
    });
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      message: err?.message || 'Login failed',
    });
  }
}

async function handleAuthMe(req, res) {
  const auth = req.authContext || await authenticateRequest(req);
  if (!auth.ok) return sendJson(res, 401, { success: false, message: auth.error || 'Authentication required' });
  return sendJson(res, 200, {
    success: true,
    data: {
      user: sanitizeAuthUser(auth.user),
      method: auth.method || 'unknown',
    },
  });
}

// ── Rate Limiting ─────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = parseInt(process.env.AI_MGMT_RATE_LIMIT || '120', 10);

function checkRateLimit(ip) {
  if (isLocalIp(ip)) return { allowed: true, remaining: RATE_LIMIT_MAX };

  const now = Date.now();
  let entry = _rateLimits.get(ip);

  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    _rateLimits.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count };
}

// ── REST Route Handlers ───────────────────────────────────────

async function handleHealth(req, res) {
  const pkg = require('../../package.json');
  sendJson(res, 200, {
    success: true,
    data: {
      status: 'ok',
      uptime: process.uptime(),
      serverUptime: Date.now() - _startTime,
      port: _port,
      sessions: _sessions.size,
      version: pkg.version || '1.0.0',
    },
  });
}

async function handleStatus(req, res) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const adapters = gw.getStatus();
  const active = gw.getActiveAdapter();
  const effort = getAi().getEffort();
  const presets = getAi().getEffortPresets();

  sendJson(res, 200, {
    success: true,
    data: {
      adapters,
      active: active || null,
      activeProvider: getAi().getActiveProvider(),
      effort: { current: effort, presets },
    },
  });
}

// ── Web 聊天 REST 处理器(HTTP 聊天代理平面,已抽取为叶子 ./aiManagementChatHttp.js)──
// 本簇无模块态(聊天序号 _chatRequestSeq 的态留宿主,经注入的 _genChatRequestId 读写)。
// 反向边(_genChatRequestId/authenticateRequest/sendJson/parseBody/getAi/getSecurity)经 setChatHttpDeps 注入。
// routeRequest 分派的处理器 + WS 处理器复用的 _summarizeToolResultForStream 按**同名 re-import** 接回。
const {
  handleChatHttp, handleChatStreamHttp, handlePersonaHttp,
  _resolveChatAttachments, _isWebInlineImagePathEnabled, _summarizeToolResultForStream,
} = require('./aiManagementChatHttp');
require('./aiManagementChatHttp').setChatHttpDeps({
  _genChatRequestId, authenticateRequest, getAi, getSecurity, parseBody, sendJson,
});

async function handleListModels(req, res, adapterKey, searchParams) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  // Live connectivity probing (testAdapter) costs a real network round-trip per
  // adapter (up to GATEWAY_TEST_TIMEOUT_MS each) and dominates this endpoint's
  // latency. The web "可用模型" card lists models but never renders probe
  // health/latency, so probing is opt-in via ?probe=1. Default (no probe)
  // mirrors the fast CLI /model path: list models only and derive health from
  // the adapter's own availability flag (still honest — it comes from detect()).
  const wantProbe = !!(searchParams && parseBooleanLike(searchParams.get('probe'), false));

  if (adapterKey) {
    // Single adapter — fan out listing + (optional) probe together.
    try {
      const [rawModels, test] = await Promise.all([
        gw.listModels(adapterKey).catch(() => []),
        wantProbe ? gw.testAdapter(adapterKey).catch(() => null) : Promise.resolve(null),
      ]);
      const origin = gw.getAdapterOrigin(adapterKey);
      const models = curateModelList(adapterKey, rawModels, origin);
      sendJson(res, 200, {
        success: true,
        data: {
          adapter: adapterKey,
          kind: origin.kind,
          source: origin.source,
          health: test ? test.connectivity : null,
          models,
        },
      });
    } catch (err) {
      sendError(res, 404, `Adapter not found: ${adapterKey}`);
    }
    return;
  }

  // All adapters, default (no-probe) path: this fans out one listModels()
  // round-trip per enabled adapter, so serve it read-through from cache. The
  // probe variant reflects live connectivity health and is never cached.
  if (!wantProbe) {
    const data = await cachedGatewayPayload(
      `${_GATEWAY_CACHE_PREFIX}models:all`,
      () => listAllAdapterModels(gw, false),
    );
    sendJson(res, 200, { success: true, data });
    return;
  }

  const data = await listAllAdapterModels(gw, wantProbe);
  sendJson(res, 200, { success: true, data });
}

// Gather the per-adapter model listing (and optional live probe) across every
// enabled adapter, fanning the work out up front so total latency is bounded by
// the slowest single adapter rather than their sum.
async function listAllAdapterModels(gw, wantProbe) {
  // Fan out BOTH the model listing and the optional connectivity
  // probe across every enabled adapter in parallel. Previously listModels ran
  // sequentially inside the loop (total latency = sum over adapters); now each
  // adapter's work is launched up front and merely gathered in order, so the
  // total is bounded by the slowest single adapter, not their sum.
  const statuses = gw.getStatus();
  const work = new Map();
  for (const s of statuses) {
    if (!s.enabled) continue;
    work.set(s.type, {
      models: s.available ? gw.listModels(s.type).catch(() => []) : Promise.resolve([]),
      test: (wantProbe && s.available) ? gw.testAdapter(s.type).catch(() => null) : Promise.resolve(null),
    });
  }

  const results = [];
  for (const s of statuses) {
    if (!s.enabled) continue;
    const entry = work.get(s.type);
    const rawModels = (await entry.models) || [];
    const test = await entry.test;
    // With a probe, health reflects the live round-trip; without one it reflects
    // the adapter's own availability flag (green/red) — never faked as verified.
    const health = wantProbe
      ? (test?.connectivity?.success ? 'green' : (s.available ? 'yellow' : 'red'))
      : (s.available ? 'green' : 'red');
    const latencyMs = test?.connectivity?.latencyMs || null;

    const origin = gw.getAdapterOrigin(s.type);
    results.push({
      adapter: s.type,
      name: s.name,
      kind: origin.kind,
      source: origin.source,
      priority: s.priority,
      available: s.available,
      health,
      latencyMs,
      modelsHealth: test?.models || null,
      models: curateModelList(s.type, rawModels, origin),
    });
  }

  return results;
}

/**
 * Apply the user model-curation layer (modelCuration) on top of an adapter's
 * raw model list and project each model to the API shape, attaching:
 *  - kind-based connectionMode fallback + discoverySource passthrough
 *  - per-model verifyStatus from the verify cache (default 'unknown')
 *  - custom flag for user-added models
 * When KHY_MODEL_HIDE_FAILED is truthy, models whose verifyStatus is 'failed'
 * are dropped entirely (env-gated, default off — zero hardcoding).
 */
function curateModelList(adapterKey, rawModels, origin) {
  const modelCuration = require('./gateway/modelCuration');
  const hideFailed = parseBooleanLike(process.env.KHY_MODEL_HIDE_FAILED, false);
  const curated = modelCuration.applyOverrides(adapterKey, rawModels || []);
  const out = [];
  for (const m of curated) {
    const verifyStatus = modelCuration.getVerifyStatus(adapterKey, m.id);
    if (hideFailed && verifyStatus === 'failed') continue;
    out.push({
      id: m.id,
      name: m.name || m.id,
      isDefault: m.isDefault || false,
      provider: m.provider || null,
      connectionMode: m.connectionMode || (origin && origin.kind === 'local' ? 'local' : 'cloud'),
      discoverySource: m.discoverySource || null,
      custom: m.custom || false,
      verifyStatus,
    });
  }
  return out;
}

async function handleTestAdapter(req, res, adapterKey) {
  const gw = getGateway();
  if (!gw._initialized) await gw.init();

  const result = await gw.testAdapter(adapterKey);
  sendJson(res, 200, { success: true, data: result });
}

const _parseBoolean = require('../utils/parseBoolean');
function parseBooleanLike(value, fallback = false) {
  return _parseBoolean(value, fallback, { extended: false });
}

function parseEnvJsonObject(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    return fallback;
  }
  return fallback;
}

function parseInputJsonObject(fieldName, value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error(`${fieldName} must be a JSON object`);
    } catch {
      throw new Error(`${fieldName} must be a valid JSON object`);
    }
  }
  throw new Error(`${fieldName} must be a JSON object`);
}

async function handleGetConfig(req, res) {
  sendJson(res, 200, { success: true, data: getGatewayConfigSnapshot() });
}

function getGatewayConfigSnapshot() {
  const ai = getAi();
  return {
    preferredAdapter: process.env.GATEWAY_PREFERRED_ADAPTER || '',
    preferredModel: process.env.GATEWAY_PREFERRED_MODEL || '',
    effort: ai.getEffort(),
    effortPresets: ai.getEffortPresets(),
    cliEnabled: process.env.GATEWAY_CLI_ENABLED !== 'false',
    ollamaHost: _OLLAMA_HOST_DEFAULT,
    ollamaModel: process.env.OLLAMA_MODEL || MODELS.ollama,
    relayPort: process.env.GATEWAY_RELAY_PORT || '9099',
    modelRouteMap: parseEnvJsonObject(process.env.GATEWAY_MODEL_ROUTE_MAP, {}),
    modelRouteStrict: parseBooleanLike(process.env.GATEWAY_MODEL_ROUTE_STRICT, false),
    keySelectionStrategy: process.env.GATEWAY_KEY_SELECTION_STRATEGY || 'round-robin',
    keySelectionStrategyMap: parseEnvJsonObject(process.env.GATEWAY_KEY_SELECTION_STRATEGY_MAP, {}),
    apiPoolProvider: process.env.GATEWAY_API_POOL_PROVIDER || '',
    apiPoolProviderAliasMap: parseEnvJsonObject(process.env.GATEWAY_API_POOL_PROVIDER_ALIAS_MAP, {}),
    apiPoolServiceMap: parseEnvJsonObject(process.env.GATEWAY_API_POOL_SERVICE_MAP, {}),
    apiPoolDefaultModelMap: parseEnvJsonObject(process.env.GATEWAY_API_POOL_DEFAULT_MODEL_MAP, {}),
  };
}

function applyGatewayConfigPatch(body = {}) {
  const ALLOWED_KEYS = {
    GATEWAY_PREFERRED_ADAPTER: 'preferredAdapter',
    GATEWAY_PREFERRED_MODEL: 'preferredModel',
    OLLAMA_HOST: 'ollamaHost',
    OLLAMA_MODEL: 'ollamaModel',
    GATEWAY_CLI_ENABLED: 'cliEnabled',
    GATEWAY_RELAY_PORT: 'relayPort',
    GATEWAY_MODEL_ROUTE_STRICT: 'modelRouteStrict',
    GATEWAY_KEY_SELECTION_STRATEGY: 'keySelectionStrategy',
    GATEWAY_API_POOL_PROVIDER: 'apiPoolProvider',
    GATEWAY_MODEL_ROUTE_MAP: 'modelRouteMap',
    GATEWAY_KEY_SELECTION_STRATEGY_MAP: 'keySelectionStrategyMap',
    GATEWAY_API_POOL_PROVIDER_ALIAS_MAP: 'apiPoolProviderAliasMap',
    GATEWAY_API_POOL_SERVICE_MAP: 'apiPoolServiceMap',
    GATEWAY_API_POOL_DEFAULT_MODEL_MAP: 'apiPoolDefaultModelMap',
  };
  const envPath = path.resolve(__dirname, '../../.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf-8'); } catch { /* no .env */ }

  const updated = [];
  const JSON_BODY_KEYS = new Set([
    'modelRouteMap',
    'keySelectionStrategyMap',
    'apiPoolProviderAliasMap',
    'apiPoolServiceMap',
    'apiPoolDefaultModelMap',
  ]);
  const BOOLEAN_BODY_KEYS = new Set(['cliEnabled', 'modelRouteStrict']);

  for (const [envKey, bodyKey] of Object.entries(ALLOWED_KEYS)) {
    if (body[bodyKey] !== undefined) {
      let normalizedValue = body[bodyKey];
      if (JSON_BODY_KEYS.has(bodyKey)) {
        normalizedValue = parseInputJsonObject(bodyKey, body[bodyKey]);
      } else if (BOOLEAN_BODY_KEYS.has(bodyKey)) {
        normalizedValue = parseBooleanLike(body[bodyKey], false);
      }

      let value = '';
      if (JSON_BODY_KEYS.has(bodyKey)) {
        value = JSON.stringify(normalizedValue);
      } else if (BOOLEAN_BODY_KEYS.has(bodyKey)) {
        value = normalizedValue ? 'true' : 'false';
      } else {
        value = String(normalizedValue);
      }
      const regex = new RegExp(`^${envKey}=.*$`, 'm');
      const shouldUnset = (bodyKey === 'preferredAdapter' || bodyKey === 'preferredModel' || bodyKey === 'apiPoolProvider')
        && String(normalizedValue).trim() === '';
      if (shouldUnset) {
        envContent = envContent.replace(new RegExp(`^${envKey}=.*(?:\\r?\\n)?`, 'm'), '');
        delete process.env[envKey];
      } else {
        const line = `${envKey}=${value}`;
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, line);
        } else {
          envContent = envContent.trimEnd() + '\n' + line + '\n';
        }
        process.env[envKey] = value;
      }
      updated.push(bodyKey);
    }
  }

  // Handle effort separately (not an env var)
  if (body.effort) {
    if (getAi().setEffort(body.effort)) {
      updated.push('effort');
    }
  }

  // Atomic write: temp + rename
  if (updated.length > 0 && updated.some(k => k !== 'effort')) {
    const tmpPath = envPath + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, envContent, 'utf-8');
    fs.renameSync(tmpPath, envPath);
  }

  // DESIGN-ARCH-045: when the user switches channels through the web/daemon
  // config path, reconcile the channel lifecycle IMMEDIATELY — exactly as the
  // CLI path does (ai.js setActiveChannel). Writing GATEWAY_PREFERRED_ADAPTER
  // alone only takes effect at the next 30s background tick, leaving the
  // now-deprecated channel (e.g. Kiro) running its token-file watcher and
  // escalating "login required" warns to the UI during that window — the zombie
  // symptom. setActiveChannel is safe before init() and best-effort here.
  if (updated.includes('preferredAdapter')) {
    try {
      getGateway().setActiveChannel(process.env.GATEWAY_PREFERRED_ADAPTER || '');
    } catch { /* lifecycle reconcile is best-effort — must never break config save */ }
  }

  return { updated, config: getGatewayConfigSnapshot() };
}

async function handleUpdateConfig(req, res) {
  const body = await parseBody(req);
  const result = applyGatewayConfigPatch(body);
  sendJson(res, 200, { success: true, data: { updated: result.updated } });
}

async function handleListConversations(req, res) {
  const conversations = getAi().listConversations();
  sendJson(res, 200, { success: true, data: conversations });
}

async function handleGetConversation(req, res, file) {
  // Strict filename validation to prevent path traversal
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(file)) {
    return sendError(res, 400, 'Invalid conversation filename');
  }

  const filePath = path.join(CONVO_DIR, file);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    sendJson(res, 200, { success: true, data });
  } catch {
    sendError(res, 404, 'Conversation not found');
  }
}

async function handleDeleteConversation(req, res, file) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(file)) {
    return sendError(res, 400, 'Invalid conversation filename');
  }

  const filePath = path.join(CONVO_DIR, file);
  try {
    fs.unlinkSync(filePath);
    sendJson(res, 200, { success: true, data: { deleted: file } });
  } catch {
    sendError(res, 404, 'Conversation not found');
  }
}

// ── 每用户 REST 处理器:对话历史 + Prompt 库 + 用量/工具/安全(已抽取为叶子
//    ./aiManagementConversationsPrompts.js)────────────────────────────────────
// 全部可变态(_conversationStore/_promptStore/_promptTemplateCatalog)私有于叶子。反向边
// sendJson/sendError/parseBody/authenticateRequest/getSecurity/getTokenUsage/getToolCalling
// 经 setConversationsPromptsDeps 注入。routeRequest/handleAiGatewayNamespace/聊天处理器
// (maybeAutoCapturePrompt)按**同名 re-import** 接回,调用点字节不变。
const {
  handleListAiConversations, handleCreateAiConversation, handleGetAiConversation,
  handleUpdateAiConversation, handleDeleteAiConversation, handleAiContextStats,
  handleListBuiltinPrompts, handleListPrompts, handleCreatePrompt, handleGetPrompt,
  handleUpdatePrompt, handleDeletePrompt, handleUsePrompt, handleApprovePrompt,
  maybeAutoCapturePrompt,
  handleGetUsage, handleGetUsageHistory, handleListTools, handleExecuteTool, handleSecurityStats,
} = require('./aiManagementConversationsPrompts');
require('./aiManagementConversationsPrompts').setConversationsPromptsDeps({
  sendJson, sendError, parseBody, authenticateRequest, getSecurity, getTokenUsage, getToolCalling,
});

// ── 每用户编码项目工作区(REST 处理器,已抽取为叶子 ./aiManagementProjects.js)──
// 全部可变态(_projectStore)私有于叶子。反向边 sendJson/sendError/parseBody/authenticateRequest
// 经 setProjectsDeps 注入。routeRequest 直接分派的处理器按**同名 re-import** 接回。
// 对齐 Hermes v0.18.0 桌面 coding projects;对话经 Conversation.project_id 归属某项目。
const {
  handleListProjects, handleCreateProject, handleGetProject,
  handleUpdateProject, handleDeleteProject, handleArchiveProject,
} = require('./aiManagementProjects');
require('./aiManagementProjects').setProjectsDeps({
  sendJson, sendError, parseBody, authenticateRequest,
});

// ── 代理出站桥(REST 处理器,已抽取为叶子 ./aiManagementProxyEgress.js)──
// 把前端选中的订阅节点接到机器级真实出站(proxyConfigService.activateNode/deactivate/getStatus)。
// 反向边 sendJson/sendError/parseBody/authenticateRequest 经 setProxyEgressDeps 注入;全走已认证路径。
// 诚实边界:core-required 节点需本机 mihomo 内核(门 KHY_PROXY_CORE),缺失时透传 guidance 不谎报生效。
const {
  handleGetProxyEgressStatus, handleEnableProxyEgress, handleDisableProxyEgress,
} = require('./aiManagementProxyEgress');
require('./aiManagementProxyEgress').setProxyEgressDeps({
  sendJson, sendError, parseBody, authenticateRequest,
});

// ── AI 网关管理平面(REST 管理面处理器,已抽取为叶子 ./aiManagementGatewayAdmin.js)──
// 全部可变态(_autoImportLastAt/_autoImportSummary/_lastGatewayAssetsSnapshot)私有于叶子。
// 反向边(响应/认证/缓存/懒加载 getter/网关配置工具)经 setGatewayAdminDeps 注入。
// routeRequest 直接分派的处理器按**同名 re-import** 接回,调用点字节不变;
// handleAiGatewayNamespace 子分派器扇出的 ~75 处内部调用留在叶子内部。
const {
  handleAiGatewayNamespace, handleAttributionDetail, handlePublicPaymentWebhook,
  handleDependencyList, handleDependencyInstall,
  handleManageList, handleManageResource, handleManageInvoke,
} = require('./aiManagementGatewayAdmin');
require('./aiManagementGatewayAdmin').setGatewayAdminDeps({
  applyGatewayConfigPatch, authenticateRequest, cachedGatewayPayload, corsHeaders,
  invalidateGatewayCache, writeGatewayCache, parseBody, sendError, sendJson,
  requireManagerAccess, parseBooleanLike, getGatewayConfigSnapshot, handleListModels,
  readAccountCircuitBreakerConfig, saveAccountCircuitBreakerConfig, getPluginFilePath,
  sanitizePluginName, getAccountPool, getAiMonitor, getApiKeyPool, getConcurrencySlots,
  getCustomerRegistry, getGateway, getModelRouter, getOauthManager, getPaymentGatewayService,
  getPluginChain, getProtocolConverter, getProxyServer, getTlsSidecar,
});

// ── Route Dispatcher ──────────────────────────────────────────

async function routeRequest(req, res, pathname, searchParams) {
  const method = req.method;

  if (method === 'POST' && pathname === '/api/auth/login') return handleAuthLogin(req, res);
  if (method === 'GET' && pathname === '/api/auth/me') return handleAuthMe(req, res);

  // Admin namespace must be matched BEFORE the /api/ai-gateway namespace below,
  // otherwise the startsWith('/api/ai-gateway') check would swallow /api/ai-gateway-admin/*.
  // Delegate to the monolith aiGatewayAdmin router (carries authenticateToken + requireAdmin).
  if (pathname.startsWith('/api/ai-gateway-admin')) {
    return getAdminApp()(req, res);
  }

  // AI-gateway billing reports (usage / pricing / groups / rate-limits) live only in
  // ai-backend's router; route just those prefixes to it before the daemon-native namespace.
  if (
    pathname.startsWith('/api/ai-gateway/usage') ||
    pathname.startsWith('/api/ai-gateway/pricing') ||
    pathname.startsWith('/api/ai-gateway/groups') ||
    pathname.startsWith('/api/ai-gateway/rate-limits')
  ) {
    return getGatewayBillingApp()(req, res);
  }

  // User-gateway namespace: per-user model config, custom providers, CC tokens.
  if (pathname.startsWith('/api/user-gateway')) {
    return getUserGatewayApp()(req, res);
  }

  if (pathname.startsWith('/api/ai-gateway') || pathname.startsWith('/api/gateway')) {
    await handleAiGatewayNamespace(req, res, pathname, searchParams);
    return;
  }

  // Workflow namespace: delegate to ai-backend's Express router via a lazy sub-app.
  // Must run before any parseBody so the sub-app can consume the raw request stream.
  if (pathname.startsWith('/api/workflow')) {
    return getWorkflowApp()(req, res);
  }

  // Plugin marketplace (browse / install / uninstall). Reuses ai-backend's router.
  if (pathname.startsWith('/api/marketplace')) {
    return getMarketplaceApp()(req, res);
  }

  // Installed plugins + their tools (import / preview / auth / test). Distinct from
  // /api/ai-gateway/plugins (matched by handleAiGatewayNamespace above), so this
  // branch only ever sees the top-level /api/plugins family.
  if (pathname.startsWith('/api/plugins')) {
    return getPluginsApp()(req, res);
  }

  // Proxy-subscription import/management. Mirrors the monolith mount (server.js:533);
  // the sub-app applies authenticateToken itself so req.user.id is populated.
  if (pathname.startsWith('/api/proxy-subscriptions')) {
    return getProxySubscriptionApp()(req, res);
  }

  // Command catalog (「功能索引」reference). Public read-only, delegates to the local
  // commands router (same SSOT as the TUI `/features`). Without this the page 404s.
  if (pathname.startsWith('/api/commands')) {
    return getCommandsApp()(req, res);
  }

  // AI chat attachment upload/download (multipart). Must run before parseBody so
  // multer can read the raw multipart stream itself.
  if (pathname === '/api/ai/upload' || pathname.startsWith('/api/ai/upload/')) {
    return getAiUploadApp()(req, res);
  }

  // Static routes
  if (method === 'GET' && pathname === '/api/health') return handleHealth(req, res);
  if (method === 'GET' && pathname === '/api/status') return handleStatus(req, res);
  if (method === 'POST' && pathname === '/api/chat') return handleChatHttp(req, res);
  if (method === 'POST' && pathname === '/api/ai/chat/stream') return handleChatStreamHttp(req, res);
  if (method === 'POST' && pathname === '/api/ai/chat') return handleChatHttp(req, res);
  if (method === 'GET' && pathname === '/api/ai/persona') return handlePersonaHttp(req, res);
  if (method === 'GET' && pathname === '/api/models') return handleListModels(req, res, null, searchParams);
  if (method === 'GET' && pathname === '/api/config') return handleGetConfig(req, res);
  if (method === 'PUT' && pathname === '/api/config') return handleUpdateConfig(req, res);
  if (method === 'GET' && pathname === '/api/conversations') return handleListConversations(req, res);
  // Per-user AI chat history (multi-conversation, backend-persisted sidebar).
  if (method === 'GET' && pathname === '/api/ai/conversations') {
    return handleListAiConversations(req, res, {
      projectId: searchParams && searchParams.get('projectId'),
    });
  }
  if (method === 'POST' && pathname === '/api/ai/conversations') return handleCreateAiConversation(req, res);
  // Per-user coding projects (named multi-folder workspaces; Hermes-aligned).
  if (method === 'GET' && pathname === '/api/ai/projects') {
    return handleListProjects(req, res, {
      includeArchived: searchParams && searchParams.get('includeArchived'),
    });
  }
  if (method === 'POST' && pathname === '/api/ai/projects') return handleCreateProject(req, res);
  // 代理出站桥:选节点实际路由 + 启用/停用开关(全走已认证路径)。
  if (method === 'GET' && pathname === '/api/proxy-egress') return handleGetProxyEgressStatus(req, res);
  if (method === 'POST' && pathname === '/api/proxy-egress/enable') return handleEnableProxyEgress(req, res);
  if (method === 'POST' && pathname === '/api/proxy-egress/disable') return handleDisableProxyEgress(req, res);
  // Context-usage stats for the web chat indicator (stateless compute on posted transcript).
  if (method === 'POST' && pathname === '/api/ai/context-stats') return handleAiContextStats(req, res);
  // Per-user prompt library (manual saves + AI-discovered pending-review).
  if (method === 'GET' && pathname === '/api/ai/prompts') {
    return handleListPrompts(req, res, {
      status: searchParams && searchParams.get('status'),
      source: searchParams && searchParams.get('source'),
      q: searchParams && searchParams.get('q'),
    });
  }
  if (method === 'POST' && pathname === '/api/ai/prompts') return handleCreatePrompt(req, res);
  // NOTE: GET /api/ai/prompts/builtin is a PUBLIC route handled before the auth gate
  // (see the request handler in start()), so it is intentionally not re-dispatched here.
  if (method === 'GET' && pathname === '/api/usage') return handleGetUsage(req, res);
  if (method === 'GET' && pathname === '/api/usage/history') return handleGetUsageHistory(req, res, searchParams);
  if (method === 'GET' && pathname === '/api/tools') return handleListTools(req, res);
  if (method === 'GET' && pathname === '/api/security/stats') return handleSecurityStats(req, res);
  if (method === 'GET' && pathname === '/api/dependencies') return handleDependencyList(req, res);
  if (method === 'GET' && pathname === '/api/manage') return handleManageList(req, res);

  // Parameterized routes
  let match;

  match = pathname.match(/^\/api\/manage\/([a-z0-9-]+)\/([a-z0-9-]+)$/i);
  if (match && method === 'POST') return handleManageInvoke(req, res, match[1], match[2]);

  match = pathname.match(/^\/api\/manage\/([a-z0-9-]+)$/i);
  if (match && method === 'GET') return handleManageResource(req, res, match[1]);

  match = pathname.match(/^\/api\/dependencies\/([a-z0-9_-]+)\/install$/i);
  if (match && method === 'POST') return handleDependencyInstall(req, res, match[1]);

  match = pathname.match(/^\/api\/models\/([a-z_]+)$/);
  if (match && method === 'GET') return handleListModels(req, res, match[1], searchParams);

  match = pathname.match(/^\/api\/test\/([a-z_]+)$/);
  if (match && method === 'POST') return handleTestAdapter(req, res, match[1]);

  match = pathname.match(/^\/api\/ai\/conversations\/(.+)$/);
  if (match) {
    if (method === 'GET') return handleGetAiConversation(req, res, match[1]);
    if (method === 'PUT') return handleUpdateAiConversation(req, res, match[1]);
    if (method === 'DELETE') return handleDeleteAiConversation(req, res, match[1]);
  }

  // Project archive/restore sub-action — matched before the generic id route.
  match = pathname.match(/^\/api\/ai\/projects\/([^/]+)\/archive$/);
  if (match && method === 'POST') return handleArchiveProject(req, res, match[1]);

  match = pathname.match(/^\/api\/ai\/projects\/([^/]+)$/);
  if (match) {
    if (method === 'GET') return handleGetProject(req, res, match[1]);
    if (method === 'PUT') return handleUpdateProject(req, res, match[1]);
    if (method === 'DELETE') return handleDeleteProject(req, res, match[1]);
  }

  // Prompt sub-actions (use / approve) — matched before the generic id route.
  match = pathname.match(/^\/api\/ai\/prompts\/([^/]+)\/use$/);
  if (match && method === 'POST') return handleUsePrompt(req, res, match[1]);

  match = pathname.match(/^\/api\/ai\/prompts\/([^/]+)\/approve$/);
  if (match && method === 'POST') return handleApprovePrompt(req, res, match[1]);

  match = pathname.match(/^\/api\/ai\/prompts\/([^/]+)$/);
  if (match) {
    if (method === 'GET') return handleGetPrompt(req, res, match[1]);
    if (method === 'PUT') return handleUpdatePrompt(req, res, match[1]);
    if (method === 'DELETE') return handleDeletePrompt(req, res, match[1]);
  }

  match = pathname.match(/^\/api\/conversations\/(.+)$/);
  if (match) {
    if (method === 'GET') return handleGetConversation(req, res, match[1]);
    if (method === 'DELETE') return handleDeleteConversation(req, res, match[1]);
  }

  match = pathname.match(/^\/api\/tools\/([a-z_]+)$/);
  if (match && method === 'POST') return handleExecuteTool(req, res, match[1]);

  sendError(res, 404, 'Not found');
}

// ── WebSocket Handler ─────────────────────────────────────────

function wsSend(session, data) {
  try {
    const WebSocket = require('ws');
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(data));
    }
  } catch { /* ignore send errors */ }
}

function handleWsConnection(ws, req) {
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    ws,
    clientIp: req ? getClientIp(req) : '',
    authenticated: false,
    user: null,
    effort: 'high',
    isGenerating: false,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    // KHY OS kernel terminal bridge for this session (lazily created on
    // 'khyos_start'). One KhyOsRunner per session; torn down in cleanupSession.
    khyosRunner: null,
  };

  _sessions.set(sessionId, session);
  wsSend(session, { type: 'connected', sessionId });

  // Auth timeout
  const authTimer = setTimeout(() => {
    if (!session.authenticated) {
      wsSend(session, { type: 'auth_error', message: 'Auth timeout (30s)' });
      ws.close(4001, 'Auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', async (raw) => {
    session.lastActivity = Date.now();

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return wsSend(session, { type: 'error', message: 'Invalid JSON' });
    }

    if (!session.authenticated && msg.type !== 'auth' && msg.type !== 'ping') {
      return wsSend(session, { type: 'error', message: 'Not authenticated' });
    }

    try {
      switch (msg.type) {
        case 'auth':
          clearTimeout(authTimer);
          await handleWsAuth(session, msg);
          break;
        case 'chat':
          await handleWsChat(session, msg);
          break;
        case 'stop':
          handleWsStop(session);
          break;
        case 'ping':
          wsSend(session, { type: 'pong' });
          break;
        case 'set_effort':
          handleWsSetEffort(session, msg);
          break;
        case 'khyos_start':
          await handleKhyosStart(session, msg);
          break;
        case 'khyos_input':
          handleKhyosInput(session, msg);
          break;
        case 'khyos_stop':
          await handleKhyosStop(session);
          break;
        case 'khyos_desktop_start':
          await handleKhyosDesktopStart(session, msg);
          break;
        case 'khyos_desktop_stop':
          handleKhyosDesktopStop(session);
          break;
        case 'khyos_desktop_input':
          handleKhyosDesktopInput(session, msg);
          break;
        case 'khyos_tray_start':
          handleKhyosTrayStart(session, msg);
          break;
        case 'khyos_md_open':
          await handleKhyosMdOpen(session, msg);
          break;
        case 'khyos_tasks_get':
          handleKhyosTasksGet(session, msg);
          break;
        default:
          wsSend(session, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      wsSend(session, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => cleanupSession(sessionId));
  ws.on('error', () => cleanupSession(sessionId));
}

async function handleWsAuth(session, msg) {
  const token = msg.token || '';
  const result = await authenticate(token, token, { clientIp: session.clientIp });

  if (result.ok) {
    session.authenticated = true;
    session.user = result.user;
    wsSend(session, { type: 'auth_ok', sessionId: session.id });
  } else {
    wsSend(session, { type: 'auth_error', message: result.error });
    session.ws.close(4001, 'Auth failed');
  }
}

async function handleWsChat(session, msg) {
  if (!session.authenticated) {
    return wsSend(session, { type: 'error', message: 'Not authenticated' });
  }
  if (session.isGenerating) {
    return wsSend(session, { type: 'error', message: 'Already generating — send stop first' });
  }

  const rawMessage = msg.message || '';
  const { message, images } = _resolveChatAttachments(msg, String(rawMessage).trim());
  if (!message.trim() && !(images && images.length)) {
    return wsSend(session, { type: 'error', message: 'Empty message' });
  }

  // Security check
  if (rawMessage.trim()) {
    try {
      const check = getSecurity().analyzeInput(rawMessage);
      if (!check.safe) {
        return wsSend(session, { type: 'error', message: check.refusal, blocked: true });
      }
    } catch { /* security failure should not block */ }
  }

  session.isGenerating = true;
  wsSend(session, { type: 'chat_start', sessionId: session.id });

  const effort = msg.effort || session.effort;
  // One correlation id per WS turn (mirrors the SSE path): threaded into chat()
  // so traceAudit stamps every stage under it, and echoed on the structured
  // `error` event so the frontend can drill down to the server-side timeline.
  const requestId = _genChatRequestId();
  const wsModel = msg.preferredModel || msg.model || undefined;
  let wsToolRan = false;

  try {
    const result = await getAi().chat(message, {
      effort,
      requestId,
      images: images && images.length ? images : undefined,
      preferredAdapter: msg.preferredAdapter || undefined,
      preferredModel: msg.preferredModel || msg.model || undefined,
      onChunk: (chunk) => {
        if (!session.isGenerating) return; // stopped
        if (chunk.type === 'thinking') {
          wsSend(session, { type: 'thinking', text: chunk.text });
        } else if (chunk.type === 'reset') {
          // 响应防抖抗拼接：通知前端丢弃已累积的废稿文本，等待修正内容替换。
          wsSend(session, { type: 'reset', reason: String(chunk.reason || 'retry') });
        } else if (chunk.type === 'text') {
          wsSend(session, { type: 'text', text: chunk.text });
        } else if (chunk.type === 'assistant_message') {
          // 用户可见的中间消息(如视觉路由说明)——转发到前端,由 AIChat 渲染进消息气泡。
          wsSend(session, { type: 'assistant_message', content: String(chunk.content || chunk.text || '') });
        } else if (chunk.type === 'tool_use') {
          wsToolRan = true;
          // Surface tool calls live (previously dropped here, so the UI only
          // ever saw a single post-hoc tool_call from result.commands — or
          // nothing when commands was empty).
          wsSend(session, {
            type: 'tool_use',
            tool: String(chunk.tool || chunk.name || 'tool'),
            input: chunk.input !== undefined ? chunk.input : {},
            id: String(chunk.id || chunk.toolUseId || ''),
          });
        } else if (chunk.type === 'tool_result') {
          let success;
          if (typeof chunk.success === 'boolean') success = chunk.success;
          else if (typeof chunk.isError === 'boolean') success = !chunk.isError;
          else if (typeof chunk.is_error === 'boolean') success = !chunk.is_error;
          wsSend(session, {
            type: 'tool_result',
            tool: String(chunk.tool || chunk.name || 'tool'),
            success,
            text: _summarizeToolResultForStream(chunk),
            id: String(chunk.id || chunk.toolUseId || ''),
          });
        } else if (chunk.type === 'cost') {
          wsSend(session, { type: 'cost', data: chunk });
        }
      },
      onControlRequest: ({ requestId, request } = {}) => {
        if (!session.isGenerating) return undefined;
        wsSend(session, {
          type: 'control_request',
          requestId: String(requestId || '').trim(),
          request: request && typeof request === 'object' ? request : {},
        });
        return undefined;
      },
      onFallback: (info) => {
        wsSend(session, {
          type: 'fallback',
          from: info.failedAdapter,
          to: info.nextAdapter,
          error: info.failedError,
          errorType: info.failedErrorType,
        });
      },
    });

    // Send tool calls if any
    if (result.commands?.length > 0) {
      for (const cmd of result.commands) {
        wsSend(session, { type: 'tool_call', command: cmd });
      }
    }

    // Zero-silent-failure parity with SSE (DESIGN-ARCH-028): an empty reply with
    // no tool activity is not a successful completion — it is a precise E01/E02
    // attribution. Emit a structured `error` event (NOT an empty chat_complete)
    // so the frontend renders the human-readable card + trace drill-down.
    let wsReply = String((result && result.reply) || '').trim();
    // 输出层软 bug 主动监听(goal 2026-06-25):WS 最终收口,与 SSE done / CLI 对称。
    // 对完整 reply 检测 + 简单修复乱码 / 未闭合围栏;不可修复落错误日志;render:true 永不抛。
    try {
      wsReply = require('./outputIntegrityMonitor').guardText(wsReply, { source: 'web-ws-complete', render: true }).text.trim();
    } catch { /* monitor absent/erroring — emit raw reply unchanged */ }
    if (!wsReply && !wsToolRan) {
      _wsSendStructuredFailure(session, {
        errorType: 'empty_reply',
        model: (result && result.provider) || wsModel,
        finish_reason: result && (result.finish_reason || result.finishReason),
      }, { kind: 'llm', model: wsModel }, requestId);
    } else {
      wsSend(session, {
        type: 'chat_complete',
        reply: wsReply,
        elapsed: result.elapsed,
        provider: result.provider,
        adapter: result.adapter,
        tokenUsage: result.tokenUsage,
        effort: result.effort,
      });
    }
  } catch (err) {
    // Classify the thrown error to E0x instead of leaking a raw "Chat failed: …".
    // The structured event carries the same fields as the SSE injector so a single
    // frontend card renders both transports identically.
    if (!_wsSendStructuredFailure(session, err, { kind: 'llm', model: wsModel }, requestId)) {
      // failsafe module unavailable → legacy minimal error (never silent).
      wsSend(session, { type: 'error', message: `Chat failed: ${err.message}` });
    }
  } finally {
    session.isGenerating = false;
  }
}

/**
 * Classify a WS chat failure to an E0x attribution and emit a structured `error`
 * event matching the SSE StreamFailSafeInjector shape (so the frontend renders one
 * card for both transports). Returns true if it emitted a structured event, false
 * if the failsafe module was unavailable (caller falls back to a minimal error).
 * @param {object} session  WS session.
 * @param {*} input         Raw failure signal (Error / empty-reply descriptor).
 * @param {object} ctx      classify() context override ({ kind, model }).
 * @param {string} requestId  Per-turn correlation id for trace drill-down.
 * @returns {boolean}
 */
function _wsSendStructuredFailure(session, input, ctx, requestId) {
  let failure;
  try {
    const { classify } = require('./failsafe');
    failure = classify(input, { endpoint: 'ai-gateway', ...ctx });
  } catch {
    return false;
  }
  wsSend(session, {
    type: 'error',
    fallback: true,
    status: failure.status,
    error_code: failure.error_code,
    reason: failure.reason,
    detail: failure.detail,
    suggestion: failure.suggestion,
    retryable: failure.retryable,
    sensitive: failure.sensitive,
    category: failure.category,
    fields: failure.fields,
    requestId: requestId || null,
    // Back-compat: a precise reason, never a bare "Chat failed".
    message: `[${failure.error_code}] ${failure.reason}`,
  });
  return true;
}

function handleWsStop(session) {
  session.isGenerating = false;
  wsSend(session, {
    type: 'chat_complete',
    reply: '',
    elapsed: 0,
    provider: 'cancelled',
    adapter: 'none',
  });
}

function handleWsSetEffort(session, msg) {
  const presets = getAi().getEffortPresets();
  if (!presets[msg.effort]) {
    return wsSend(session, { type: 'error', message: `Invalid effort: ${msg.effort}` });
  }
  session.effort = msg.effort;
  wsSend(session, { type: 'effort_set', effort: msg.effort, label: presets[msg.effort].label });
}

function cleanupSession(sessionId) {
  const session = _sessions.get(sessionId);
  if (session) {
    session.isGenerating = false;
    stopKhyosDesktopStream(session);
    if (session.khyosRunner) {
      try { session.khyosRunner.stop(); } catch { /* ignore */ }
      session.khyosRunner = null;
    }
    _sessions.delete(sessionId);
  }
}

// ── KHY OS 终端 + 桌面查看器 WS 处理器(已抽取为叶子 ./aiManagementKhyosWs.js)──
// 零模块作用域可变态(全挂 session 对象)。唯一反向边 wsSend(无态)经 setKhyosDeps 注入。
// WS 消息 switch(khyos_*)与 cleanupSession/gcSweep 里的 stopKhyosDesktopStream 按**同名
// re-import** 接回,调用点字节不变。
const {
  handleKhyosStart, handleKhyosInput, handleKhyosStop,
  handleKhyosDesktopStart, handleKhyosDesktopStop, handleKhyosDesktopInput, stopKhyosDesktopStream,
  handleKhyosTrayStart, handleKhyosMdOpen, handleKhyosTasksGet,
} = require('./aiManagementKhyosWs');
require('./aiManagementKhyosWs').setKhyosDeps({ wsSend });

// ── Heartbeat / GC ────────────────────────────────────────────

function gcSweep() {
  const now = Date.now();

  // Close idle sessions
  for (const [id, session] of _sessions) {
    if (now - session.lastActivity > SESSION_IDLE_MS) {
      stopKhyosDesktopStream(session);
      if (session.khyosRunner) {
        try { session.khyosRunner.stop(); } catch { /* ignore */ }
        session.khyosRunner = null;
      }
      wsSend(session, { type: 'error', message: 'Session closed: idle timeout' });
      session.ws.close(4002, 'Idle timeout');
      _sessions.delete(id);
    }
  }

  // Clean stale rate limit entries
  for (const [ip, entry] of _rateLimits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      _rateLimits.delete(ip);
    }
  }
}

// ── Server Lifecycle ──────────────────────────────────────────

/**
 * Start the AI management server.
 * @param {number} [port] - Port to listen on (default: AI_MGMT_PORT or 9090)
 * @returns {Promise<number>} The actual port the server is listening on
 */
function start(port) {
  return new Promise(async (resolve, reject) => {
    if (_server) return reject(new Error('AI management server already running'));

    const listenPort = port || parseInt(process.env.AI_MGMT_PORT, 10) || 9090;

    // Seed the built-in SenseNova channel idempotently before serving, so its
    // key / provider config is visible on the management page even when the
    // user never ran `khy init` and regardless of when the daemon started.
    try {
      require('./customProviderRegistrar').ensureBuiltinSenseNova();
    } catch { /* best effort — never block server start */ }

    // Seed the qoder reverse-proxy channels (OpenAI + Anthropic) only when the
    // user opted in (QODER_PROXY_ENDPOINT/API_KEY or KHY_QODER_PROXY); no-op else.
    try {
      require('./customProviderRegistrar').ensureBuiltinQoder();
    } catch { /* best effort — never block server start */ }

    // Fresh-install DB self-heal — ensure base tables + the advertised
    // `admin / admin123` account exist before serving, so the first login and
    // any DB-backed route don't 500 with "no such table: users" on a pip
    // install that never ran `node scripts/seed.js`. Awaited so the very first
    // request already sees a seeded DB. Gated KHY_MANAGE_DB_AUTOSEED
    // (default-on); gate-off / any error → no-op, never throws, never blocks.
    try {
      await require('./manageDbBootstrap').ensureManageDbSeeded(process.env);
    } catch { /* best effort — never block server start */ }

    // Init gateway in background
    try {
      const gw = getGateway();
      if (!gw._initialized) gw.init().catch(() => {});
    } catch { /* best effort */ }

    // [ARCH-031] Gateway log lease — install once at daemon boot. Self-gated by
    // KHY_GATEWAY_LOG_LEASE (default off); install() is a no-op idempotent unless
    // the flag is explicitly on, so this line is zero-behavior-change by default.
    // When enabled, it leases adapter log visibility (in-use/status-query only)
    // and silences unrelated background noise. See gatewayLogLease/index.js.
    try {
      require('./gatewayLogLease').install();
    } catch { /* best effort — never block server start */ }

    // Hot-reload the API key pool when its sources change — so a key added via a
    // direct .env edit, the CLI (separate process), or the Web UI takes effect
    // immediately without a daemon restart. Watches the canonical/mirror .env +
    // api_keys.json; on a real (content-hashed) change it overlays env key vars
    // and calls apiKeyPool.reload(). Idempotent; killable via
    // KHY_DISABLE_KEYPOOL_WATCH=1. See apiKeyPoolWatcher.js.
    try {
      require('./apiKeyPoolWatcher').start();
    } catch { /* best effort — never block server start */ }

    // Create WebSocket server (noServer mode — attached to HTTP upgrade)
    const WebSocket = require('ws');
    _wss = new WebSocket.Server({ noServer: true });
    _wss.on('connection', handleWsConnection);

    // Create HTTP server
    _server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
      }

      const url = new URL(req.url, `http://localhost:${listenPort}`);
      const pathname = url.pathname;

      if (tryHandleFrontendStatic(req, res, pathname)) {
        return;
      }

      // Rate limiting
      const ip = getClientIp(req);
      const rateCheck = checkRateLimit(ip);
      if (!rateCheck.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(rateCheck.retryAfter || 60),
          ...corsHeaders(),
        });
        res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded', retryAfter: rateCheck.retryAfter }));
        return;
      }

      // Health endpoint — no auth required
      if (pathname === '/api/health') {
        try { return await handleHealth(req, res); }
        catch (err) { return sendError(res, 500, err.message); }
      }

      // Login endpoint — public route
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        try { return await handleAuthLogin(req, res); }
        catch (err) { return sendJson(res, 500, { success: false, message: err.message || 'Login failed' }); }
      }

      // Built-in prompt template catalog — public read-only route. Non-sensitive
      // static content, identical for everyone; served without auth so the chat
      // empty-state is populated even before/without a session. Gate-off or any
      // exception yields an empty catalog (the frontend has a local fallback).
      if (req.method === 'GET' && pathname === '/api/ai/prompts/builtin') {
        try {
          return await handleListBuiltinPrompts(req, res, {
            category: url.searchParams.get('category'),
          });
        } catch { return sendJson(res, 200, { success: true, data: { templates: [], categories: [] } }); }
      }

      if (req.method === 'POST' && pathname === '/api/payment-webhooks/mock') {
        try { return await handlePublicPaymentWebhook(req, res, 'mock'); }
        catch (err) { return sendError(res, 500, err.message || 'Payment webhook failed'); }
      }

      // Auth check for all other routes
      const auth = await authenticateRequest(req, ip);
      if (!auth.ok) {
        return sendError(res, 401, auth.error);
      }
      req.authContext = auth;

      // Route dispatch
      try {
        await routeRequest(req, res, pathname, url.searchParams);
      } catch (err) {
        sendError(res, 500, `Internal error: ${err.message}`);
      }
    });

    // WebSocket upgrade
    _server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url, `http://localhost:${listenPort}`);
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      _wss.handleUpgrade(req, socket, head, (ws) => {
        _wss.emit('connection', ws, req);
      });
    });

    // Port auto-retry (up to +10)
    let attempt = 0;
    const maxAttempts = 10;

    function tryListen(tryPort) {
      const onListening = () => {
        _server.off('error', onError);
        _port = tryPort;
        _startTime = Date.now();
        _heartbeatTimer = setInterval(gcSweep, GC_INTERVAL_MS);
        _heartbeatTimer.unref();
        resolve(tryPort);
      };

      const onError = (err) => {
        _server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts) {
          attempt += 1;
          tryListen(tryPort + 1);
          return;
        }
        _server = null;
        _wss = null;
        reject(err);
      };

      _server.once('listening', onListening);
      _server.once('error', onError);
      _server.listen(tryPort);
    }

    tryListen(listenPort);
  });
}

/**
 * Stop the AI management server.
 */
function stop() {
  return new Promise((resolve) => {
    if (!_server) { resolve(); return; }

    // Notify all sessions
    for (const [id, session] of _sessions) {
      wsSend(session, { type: 'error', message: 'Server shutting down' });
      try { session.ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    _sessions.clear();

    if (_heartbeatTimer) {
      clearInterval(_heartbeatTimer);
      _heartbeatTimer = null;
    }

    // Tear down the API key pool watcher (closes fs watchers + poll timer).
    try { require('./apiKeyPoolWatcher').stop(); } catch { /* ignore */ }

    // Close WebSocket server
    if (_wss) {
      _wss.close(() => {});
      _wss = null;
    }

    // Close HTTP server with 5s force-close
    const forceTimer = setTimeout(() => {
      _server = null;
      _port = 0;
      resolve();
    }, 5000);
    forceTimer.unref();

    _server.close(() => {
      clearTimeout(forceTimer);
      _server = null;
      _port = 0;
      resolve();
    });
  });
}

function isRunning() { return !!_server; }

function getPort() { return _port || parseInt(process.env.AI_MGMT_PORT, 10) || 9090; }

module.exports = {
  start,
  stop,
  isRunning,
  getPort,
  configureFrontendStatic,
  __test__: {
    applyGatewayConfigPatch,
    // Exposed so a regression test can assert these routers are actually
    // reachable through the daemon (return 401 auth, not 404), guarding the
    // exact require-path + mount-prefix the dispatcher uses for the
    // marketplace / plugins families the SPA depends on.
    getMarketplaceApp,
    getPluginsApp,
    // Proxy-subscription router reachability + the pre-auth /vendor/* static branch
    // (muya WYSIWYG bundle). Guards against the 404 (route unmounted) and 401
    // (/vendor/* falling through to the auth gate) the khychat SPA hit post pip-install.
    getProxySubscriptionApp,
    // Command-catalog router (「功能索引」GET /api/commands) reachability — guards the
    // exact require-path + mount-prefix the dispatcher uses, so the FeatureCatalog page
    // does not 404 ("Not found / 功能索引暂时加载不出来") as it did when unmounted.
    getCommandsApp,
    tryHandleFrontendStatic,
    // Account-pool route dispatch (GET/POST/PUT/DELETE /api/ai-gateway/accounts/*)
    // + a fake-pool injector, so a regression test can assert the frontend's
    // batch-delete / use / import / unban calls reach the daemon-native pool
    // instead of falling through to 404.
    handleAiGatewayNamespace,
    _setAccountPoolForTest(pool) { _accountPoolOverrideForTest = pool; },
    // Failure-attribution drill-down + structured WS failure (DESIGN-ARCH-028
    // human-readable card + trace). Exposed for unit tests with mocked req/res.
    handleAttributionDetail,
    _wsSendStructuredFailure,
    _genChatRequestId,
    // Gateway read-through cache helpers (Redis-backed, memory fallback).
    cachedGatewayPayload,
    writeGatewayCache,
    invalidateGatewayCache,
    gatewayCacheEnabled,
    gatewayCacheTtl,
    // Inline image-path → attachment extraction shared by the HTTP/stream/WS chat
    // entry points, so a regression test can assert REPL parity + gate byte-revert.
    _resolveChatAttachments,
    _isWebInlineImagePathEnabled,
  },
};
