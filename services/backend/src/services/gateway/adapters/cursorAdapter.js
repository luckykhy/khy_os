/**
 * Cursor Adapter — connect to Cursor IDE's AI models.
 *
 * Reads Cursor's auth token from local storage files and provides
 * access to Cursor's model catalog. Supports both local token detection
 * and account pool fallback.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');
const { requestJson } = require('./_proxyTunnel');
const { parseList, dedupePaths, resolveUserHomeRoots } = require('./_adapterUtils');
// Model-name SSOT: default IDE model flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');
const { createProtocolHandler } = require('./_protocolPipeline');
const {
  normalizeToken, isLikelyCredentialToken,
  isNativeLoginToken, countsTowardAvailability,
} = require('./_ideTokenMixin');
const { findInstallation, findDataPath } = require('./ideDetector');
const { buildSuccess, buildFailure } = require('./_responseBuilder');


// resolveUserHomeRoots imported from _adapterUtils

function buildCursorStoragePaths() {
  const out = [];
  for (const homeRoot of resolveUserHomeRoots()) {
    out.push(path.join(homeRoot, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'storage.json'));
  }
  for (const p of parseList(process.env.CURSOR_STORAGE_PATHS || process.env.CURSOR_STORAGE_PATH)) {
    out.push(p);
  }
  return dedupePaths(out);
}

function buildCursorDbPaths() {
  const out = [];
  for (const homeRoot of resolveUserHomeRoots()) {
    out.push(path.join(homeRoot, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    out.push(path.join(homeRoot, '.config', 'Cursor', 'User', 'globalStorage', 'state-global.vscdb'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state-global.vscdb'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state-global.vscdb'));
  }
  for (const p of parseList(process.env.CURSOR_DB_PATHS || process.env.CURSOR_DB_PATH)) {
    out.push(p);
  }
  return dedupePaths(out);
}

const CURSOR_STORAGE_PATHS = buildCursorStoragePaths();
const CURSOR_DB_PATHS = buildCursorDbPaths();

const KNOWN_MODELS = [
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', isDefault: false },
  { id: 'cursor-small', name: 'Cursor Small', isDefault: false },
];

const { DEFAULT_TIMEOUT_MS } = require('./_protocolPipeline');
const TIMEOUT_MS = parseInt(process.env.CURSOR_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
const ACCOUNT_POOL_TYPE = 'cursor';

const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'cursor' });
let _available = null;
let _token = null;

// hasTokenShape is replaced by isLikelyCredentialToken from _ideTokenMixin
const hasTokenShape = isLikelyCredentialToken;

function firstNonEmpty(values = []) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function extractTokenFromUnknown(value, depth = 0) {
  if (depth > 6 || value == null) return '';

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return '';
    if (hasTokenShape(raw)) return normalizeToken(raw);
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        return extractTokenFromUnknown(JSON.parse(raw), depth + 1);
      } catch {
        return '';
      }
    }
    return '';
  }

  if (Buffer.isBuffer(value)) {
    return extractTokenFromUnknown(value.toString('utf8'), depth + 1);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const token = extractTokenFromUnknown(item, depth + 1);
      if (token) return token;
    }
    return '';
  }

  if (typeof value !== 'object') return '';

  const directKeys = [
    'accessToken',
    'access_token',
    'authToken',
    'idToken',
    'token',
    'userJwt',
    'cursorAuth/accessToken',
    'cursorAuth.accessToken',
    'cursor.accessToken',
  ];
  for (const key of directKeys) {
    const token = normalizeToken(value[key]);
    if (hasTokenShape(token)) return token;
  }

  const nested = ['cursorAuth', 'auth', 'session', 'credentials', 'login'];
  for (const key of nested) {
    const token = extractTokenFromUnknown(value[key], depth + 1);
    if (token) return token;
  }

  for (const [k, v] of Object.entries(value)) {
    if (/(refresh.?token)/i.test(k)) continue;
    if (/(access.?token|auth.?token|id.?token|jwt|bearer)/i.test(k)) {
      const token = extractTokenFromUnknown(v, depth + 1);
      if (token) return token;
    }
  }
  return '';
}

/**
 * Try to read Cursor auth token from local storage.
 */
function readCursorToken() {
  // Try SQLite database first (primary storage since Cursor 0.40+)
  for (const dbPath of CURSOR_DB_PATHS) {
    try {
      if (fs.existsSync(dbPath)) {
        const token = readTokenFromVscdb(dbPath);
        if (token) return { accessToken: token, source: 'state.vscdb', path: dbPath };
      }
    } catch { /* skip */ }
  }

  // Fallback: try storage.json (older versions)
  for (const p of CURSOR_STORAGE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Cursor stores token under varying keys across versions.
        const token = firstNonEmpty([
          data.cursorAuth?.accessToken,
          data['cursorAuth/accessToken'],
          data['cursorAuth.accessToken'],
          data.cursorAuth?.token,
          data['cursorAuth/token'],
          data.cursorAuth?.authToken,
          data['cursorAuth/authToken'],
          data.accessToken,
          extractTokenFromUnknown(data),
        ]);
        if (hasTokenShape(token)) {
          return { accessToken: normalizeToken(token), source: 'storage.json', path: p };
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Read token from Cursor's SQLite database (state.vscdb).
 * Uses better-sqlite3 if available, falls back to manual parsing.
 */
function readTokenFromVscdb(dbPath) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table');
      const tableName = (
        tables.find(t => String(t.name || '') === 'ItemTable')
        || tables.find(t => String(t.name || '').toLowerCase() === 'itemtable')
        || tables.find(t => /itemtable/i.test(String(t.name || '')))
      )?.name;
      if (!tableName || !/^[A-Za-z0-9_]+$/.test(String(tableName))) return null;

      const tokenKeys = [
        'cursorAuth/accessToken',
        'cursorAuth.accessToken',
        'cursorAuth/token',
        'cursorAuth.authToken',
        'accessToken',
        'cursor.accessToken',
        'cursor.sessionToken',
      ];

      for (const key of tokenKeys) {
        try {
          const row = db.prepare(`SELECT value FROM "${tableName}" WHERE key = ?`).get(key);
          const token = extractTokenFromUnknown(row && row.value);
          if (hasTokenShape(token)) return normalizeToken(token);
        } catch { /* try next */ }
      }

      try {
        const rows = db.prepare(
          `SELECT key, value FROM "${tableName}" WHERE key LIKE ? OR key LIKE ? OR key LIKE ? LIMIT 200`
        ).all('%cursorAuth%', '%accessToken%', '%token%');
        for (const row of rows) {
          const key = String(row?.key || '');
          if (/refresh.?token/i.test(key)) continue;
          const token = extractTokenFromUnknown(row?.value);
          if (hasTokenShape(token)) return normalizeToken(token);
        }
      } catch {
        // ignore broad-scan failures
      }
    } finally {
      db.close();
    }
  } catch {
    // better-sqlite3 unavailable or DB layout changed: fallback to text scan
  }

  try {
    const buffer = fs.readFileSync(dbPath);
    const content = buffer.toString('utf8', 0, Math.min(buffer.length, 4 * 1024 * 1024));
    const tokenPatterns = [
      /cursorAuth[\/.]accessToken[^A-Za-z0-9._\-+/=~:]+([A-Za-z0-9._\-+/=~:]{20,4096})/,
      /cursorAuth[\/.]authToken[^A-Za-z0-9._\-+/=~:]+([A-Za-z0-9._\-+/=~:]{20,4096})/,
      /"accessToken"\s*:\s*"([A-Za-z0-9._\-+/=~:]{20,4096})"/,
      /"authToken"\s*:\s*"([A-Za-z0-9._\-+/=~:]{20,4096})"/,
      /\b(eyJ[A-Za-z0-9._\-+/=~:]{20,4096})\b/,
    ];
    for (const pattern of tokenPatterns) {
      const match = content.match(pattern);
      if (match && hasTokenShape(match[1])) return normalizeToken(match[1]);
    }
  } catch {
    // ignore final fallback failures
  }

  return null;
}

// Strict availability: an adapter is "available" only when the IDE is locally
// installed AND there is a genuine local login. A native login token (read from
// Cursor's own storage) inherently proves install+login. Pool/imported tokens do
// NOT count unless KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS is set AND Cursor is
// locally installed. Token assignment for routing/generate is unchanged.
function _cursorInstalled() {
  try { return !!(findInstallation('cursor') || findDataPath('cursor')); }
  catch { return false; }
}

function _computeAvailable(token) {
  if (isNativeLoginToken(token)) return true;
  return _cursorInstalled() && countsTowardAvailability(token);
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  const localToken = readCursorToken();
  if (localToken && hasTokenShape(localToken.accessToken)) {
    _token = localToken;
    persistObservedToken(localToken);
  } else if (!(_token && hasTokenShape(_token.accessToken) && String(_token.source || '').startsWith('pool:'))) {
    _token = null;
  }
  _available = _computeAvailable(_token);
  return _available;
}

function toPoolTokenShape(poolToken = null) {
  if (!poolToken || !hasTokenShape(poolToken.accessToken)) return null;
  return {
    accessToken: normalizeToken(poolToken.accessToken),
    refreshToken: poolToken.refreshToken ? String(poolToken.refreshToken).trim() : null,
    source: `pool:${poolToken.label || ACCOUNT_POOL_TYPE}`,
    path: poolToken.sourcePath || '',
    expiresAt: poolToken.expiresAt || null,
  };
}

async function detectAsync(forceRefresh = false) {
  const localDetected = detect(forceRefresh);
  if (localDetected) return true;

  const poolToken = await getPoolActiveToken();
  if (poolToken && hasTokenShape(poolToken.accessToken)) {
    // Pool token is kept for routing/generate, but only counts toward
    // availability under strict rules (native login, or imported-creds flag + install).
    _token = poolToken;
    persistObservedToken(poolToken);
    _available = _computeAvailable(poolToken);
    return _available;
  }
  _available = false;
  return false;
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

function _stableLabel(source) {
  // Strip accumulated "pool:" / "cursor:" prefixes to prevent label growth loop
  const stripped = String(source || '').replace(/^(?:pool:|cursor:)+/g, '');
  return `${ACCOUNT_POOL_TYPE}:${stripped || 'pool'}`;
}

function _decodeJwtEmail(accessToken) {
  try {
    const parts = String(accessToken || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.email || payload.unique_name || payload.preferred_username || null;
  } catch { return null; }
}

function persistObservedToken(token = null) {
  if (!token || !token.accessToken) return;
  Promise.resolve().then(async () => {
    try {
      const pool = require('../../accountPool');
      await pool.init();
      const email = token.email || _decodeJwtEmail(token.accessToken);
      await pool.saveObservedToken(ACCOUNT_POOL_TYPE, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || null,
        email: email || null,
        sourcePath: token.path || '',
        label: email || _stableLabel(token.source),
        authData: {
          source: token.source || ACCOUNT_POOL_TYPE,
          path: token.path || '',
          expiresAt: token.expiresAt || null,
        },
      }, { activateIfNone: true });
      await pool.autoImportObservedCredentials(ACCOUNT_POOL_TYPE);
    } catch { /* ignore */ }
  });
}

async function listModels() {
  detect(true);
  const poolToken = await getPoolActiveToken();
  if (poolToken && hasTokenShape(poolToken.accessToken)) {
    _token = poolToken;
    _available = true;
  }
  if (_token && hasTokenShape(_token.accessToken)) {
    persistObservedToken(_token);
  }
  return KNOWN_MODELS.map(m => ({
    ...m,
    provider: 'cursor',
    description: '',
  }));
}

/**
 * Generate a response using Cursor's API.
 * Falls back to OpenAI-compatible endpoint if direct API unavailable.
 */
async function generate(prompt, options = {}) {
  const poolToken = await getPoolActiveToken();
  if (poolToken && hasTokenShape(poolToken.accessToken)) {
    _token = poolToken;
    _available = true;
  }

  if (!detect()) {
    return buildFailure('Cursor token not available', {
      adapter: 'cursor', provider: 'Cursor', errorType: 'auth',
    });
  }

  persistObservedToken(_token);

  const model = options.model || MODELS.ide;
  const onChunk = options.onChunk || (() => {});

  try {
    // Use OpenAI-compatible endpoint
    const chatResult = await cursorChat(prompt, model, onChunk, options);
    return buildSuccess(chatResult.content, {
      adapter: 'cursor', provider: `Cursor (${model})`, model,
      toolUseBlocks: chatResult.toolUseBlocks || [],
      stopReason: chatResult.stopReason || 'end_turn',
      attempts: [{ provider: 'Cursor', success: true }],
    });
  } catch (err) {
    const statusCode = err.status || err.statusCode || err.response?.status || undefined;
    return buildFailure(err, {
      adapter: 'cursor', provider: 'Cursor', statusCode,
      attempts: [{ provider: 'Cursor', success: false, error: err.message, statusCode }],
    });
  }
}

/**
 * Call Cursor's API endpoint.
 * Returns { content, toolUseBlocks, stopReason }.
 */
function cursorChat(prompt, model, onChunk, options = {}) {
  const { body } = _openaiHandler.buildRequestBody(prompt, {
    ...options,
    model,
    stream: false,
  });

  return requestJson(
    'https://api2.cursor.sh/v1/chat/completions',
    {
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: sanitizeOutgoingHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_token.accessToken}`,
      }),
      body,
    },
    {
      namespace: 'cursor',
      envKeys: ['CURSOR_HTTP_PROXY', 'CURSOR_HTTPS_PROXY', 'CURSOR_PROXY', 'CURSOR_ALL_PROXY'],
      autoEnvKey: 'CURSOR_AUTO_PROXY',
      portsEnvKey: 'CURSOR_AUTO_PROXY_PORTS',
    }
  ).then((res) => {
    const statusCode = Number(res.status || 0);
    if (statusCode === 401 || statusCode === 403) {
      throw new Error(`Cursor auth failed (${statusCode})`);
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Cursor API HTTP ${statusCode}`);
    }

    const result = res.data || {};
    if (!result.choices?.[0]) {
      if (result.error) throw new Error(result.error.message || 'Cursor API error');
      throw new Error(`Invalid response from Cursor API (HTTP ${statusCode})`);
    }

    const parsed = _openaiHandler.parseJsonResponse(result);
    if (parsed.content) onChunk({ type: 'text', text: parsed.content });

    return {
      content: parsed.content,
      toolUseBlocks: parsed.toolUseBlocks,
      stopReason: parsed.stopReason,
    };
  });
}

function getStatus() {
  // Recompute synchronously from the filesystem so a stale module-level
  // `_available` (e.g. after an uninstall) cannot report a false "available".
  detect(true);
  const installed = _cursorInstalled() || isNativeLoginToken(_token);
  let detail;
  if (_available) {
    detail = `Token 有效 (${KNOWN_MODELS.length} 个模型)`;
  } else if (installed) {
    detail = 'Cursor 已安装，未检测到登录态 — 请先登录 Cursor IDE';
  } else {
    detail = '未检测到 Cursor 安装';
  }
  return {
    name: 'Cursor IDE',
    type: 'cursor',
    available: _available,
    detail,
  };
}

function destroy() {
  _available = null;
  _token = null;
}

module.exports = { detect, detectAsync, listModels, generate, getStatus, destroy };
