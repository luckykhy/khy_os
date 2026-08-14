/**
 * Bridge Server — HTTP + WebSocket server for remote CLI control.
 *
 * Allows remote clients (web browser, mobile, another CLI) to:
 * - Send commands/messages to the local REPL
 * - Approve/deny permission requests
 * - View real-time AI output
 *
 * Serves a mobile-friendly HTML page at GET / for phone access.
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const os = require('os');

const DEFAULT_PORT = 9222;
// Bind to all interfaces by default so LAN collaboration (phone/other devices
// controlling this CLI) works out of the box. Override with BRIDGE_BIND_HOST
// (e.g. set BRIDGE_BIND_HOST=127.0.0.1 to force localhost-only access).
const DEFAULT_BIND_HOST = '0.0.0.0';
const MAX_PORT_RETRIES = 3;
const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const BRIDGE_TIMEOUT_MS = parseInt(process.env.KHY_STARTUP_BRIDGE_TIMEOUT_MS || '5000', 10);

let _httpServer = null;
let _wss = null;
const _clients = new Map(); // id → { ws, remoteAddress, connectedAt, authenticated }
let _token = null;
let _pin = null; // 6-digit PIN for mobile login
let _tokenCreatedAt = 0;
let _lanIp = null;
let _bindHost = DEFAULT_BIND_HOST; // actual host the server is bound to (drives display URL)

// ── Message History Ring Buffer (for reconnect replay) ──
const HISTORY_MAX = 50;
let _messageHistory = []; // recent broadcast messages for replay

let _chalk;
function chalk() {
  if (_chalk) {
    return _chalk;
  }
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

// ── CORS Origin Control ──────────────────────────────────────────
// Bridge server accepts requests from loopback + LAN by default.
// Override via BRIDGE_CORS_ORIGIN (comma-separated exact origins, e.g.
// "http://localhost:3000,http://192.168.1.100:3000").
// Wildcard "*" is never used.
const _corsOriginEnv = String(process.env.BRIDGE_CORS_ORIGIN || '').trim();
const _corsAllowedOrigins = _corsOriginEnv
  ? _corsOriginEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : []; // empty → dynamic loopback/LAN check

function _isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function _isLanOrigin(origin, lanIp) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    if (!lanIp) {
      return false;
    }
    return host === lanIp || host === String(lanIp).replace(/^::ffff:/, '');
  } catch {
    return false;
  }
}

function resolveCorsOrigin(origin, lanIp) {
  if (!origin) {
    return null;
  }
  if (_corsAllowedOrigins.length > 0) {
    return _corsAllowedOrigins.includes(origin) ? origin : null;
  }
  if (_isLoopbackOrigin(origin)) {
    return origin;
  }
  if (_isLanOrigin(origin, lanIp)) {
    return origin;
  }
  return null;
}

// ── LAN IP Discovery ──────────────────────────────────────────────

/**
 * Find the best LAN IPv4 address for this machine.
 * Reuses the proven logic from routes/system.js.
 */
function _getLanIp() {
  const interfaces = os.networkInterfaces();
  const virtualKeywords = [
    'vmware',
    'virtualbox',
    'vbox',
    'virtual',
    'vethernet',
    'docker',
    'wsl',
    'hyper-v',
    'loopback',
    'tunnel',
  ];
  const candidates = [];

  for (const ifName in interfaces) {
    const lowerName = ifName.toLowerCase();
    const isVirtual = virtualKeywords.some((kw) => lowerName.includes(kw));

    for (const iface of interfaces[ifName]) {
      if (iface.family !== 'IPv4' || iface.internal) {
        continue;
      }
      const ip = iface.address;
      if (ip.startsWith('169.254')) {
        continue;
      } // APIPA

      let priority = 4;
      if (ip.startsWith('192.168') && !isVirtual) {
        priority = 1;
      } else if (ip.startsWith('10.') && !isVirtual) {
        priority = 2;
      } else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip) && !isVirtual) {
        priority = 3;
      }

      candidates.push({ ip, priority, name: ifName });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.length > 0 ? candidates[0].ip : 'localhost';
}

// ── HTTP Helpers ──────────────────────────────────────────────────

const MAX_BODY_SIZE = 10 * 1024; // 10 KB

function _parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function _jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function _setCorsHeaders(req, res) {
  const origin = resolveCorsOrigin(req.headers.origin, _lanIp);
  const headers = {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── HTTP Request Handler ──────────────────────────────────────────

async function _handleHttpRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    _setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve mobile HTML page
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    try {
      const { buildMobileHTML } = require('./mobilePage');
      const port = _httpServer.address()?.port || DEFAULT_PORT;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(buildMobileHTML(port));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    const clients = [..._clients.values()].filter((c) => c.authenticated).length;
    _jsonResponse(res, 200, { status: 'ok', clients });
    return;
  }

  // ── Auth API ──
  if (req.method === 'POST' && req.url === '/api/register') {
    // Rate limit check
    const rlKey = _getAuthRateLimitKey(req);
    const rl = _checkAuthRateLimit(rlKey);
    if (!rl.allowed) {
      _jsonResponse(res, 429, { ok: false, error: rl.reason, retryAfterMs: rl.retryAfterMs });
      return;
    }
    try {
      const body = await _parseJsonBody(req);
      const auth = require('./bridgeAuth');
      const result = auth.registerUser(body.username, body.password);
      _jsonResponse(res, result.ok ? 200 : 400, result);
    } catch (err) {
      _jsonResponse(res, 400, { ok: false, error: err.message || '请求无效' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/login') {
    // Rate limit check
    const rlKey = _getAuthRateLimitKey(req);
    const rl = _checkAuthRateLimit(rlKey);
    if (!rl.allowed) {
      _jsonResponse(res, 429, { ok: false, error: rl.reason, retryAfterMs: rl.retryAfterMs });
      return;
    }
    try {
      const body = await _parseJsonBody(req);
      const auth = require('./bridgeAuth');
      const result = auth.loginUser(body.username, body.password);
      _jsonResponse(res, result.ok ? 200 : 401, result);
    } catch (err) {
      _jsonResponse(res, 400, { ok: false, error: err.message || '请求无效' });
    }
    return;
  }

  // ── Attachment upload (mobile collaboration link) ──
  // The phone POSTs multipart/form-data here; bearer-authenticated, bypasses the
  // 10 KB JSON body cap, streams to disk via multer, then commits + enriches.
  if (req.method === 'POST' && req.url === '/api/upload') {
    const authz = String(req.headers['authorization'] || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const auth = require('./bridgeAuth');
    if (!token || !auth.validateJwt(token).ok) {
      _jsonResponse(res, 401, { success: false, error: '未授权,请先登录' });
      return;
    }
    let multer, uploadStore;
    try {
      multer = require('multer');
      uploadStore = require('../services/aiUploadStore');
    } catch {
      _jsonResponse(res, 500, { success: false, error: '上传组件不可用' });
      return;
    }
    const upload = multer({
      storage: multer.diskStorage({ destination: os.tmpdir() }),
      limits: { fileSize: uploadStore.maxFileBytes(), files: 10 },
    }).any();
    upload(req, res, async (err) => {
      if (err) {
        const tooLarge = err.code === 'LIMIT_FILE_SIZE';
        _jsonResponse(res, tooLarge ? 413 : 400, {
          success: false,
          error: tooLarge ? '文件过大' : err.message || '上传失败',
        });
        return;
      }
      try {
        const files = Array.isArray(req.files) ? req.files : [];
        const attachments = [];
        for (const f of files) {
          const manifest = await uploadStore.commitAndEnrich({
            tempPath: f.path,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size: f.size,
          });
          attachments.push(uploadStore.toDescriptor(manifest));
        }
        _jsonResponse(res, 200, { success: true, attachments });
      } catch (e) {
        _jsonResponse(res, 500, { success: false, error: e.message || '上传处理失败' });
      }
    });
    return;
  }

  // ── Attachment download / preview ──
  // Bearer-authenticated like the upload path: with default 0.0.0.0 binding any
  // LAN peer who guessed an id could otherwise pull attachments without login.
  if (req.method === 'GET' && req.url.startsWith('/api/upload/')) {
    const authz = String(req.headers['authorization'] || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const auth = require('./bridgeAuth');
    if (!token || !auth.validateJwt(token).ok) {
      _jsonResponse(res, 401, { success: false, error: '未授权,请先登录' });
      return;
    }
    const fs = require('fs');
    const uploadStore = require('../services/aiUploadStore');
    const id = req.url.slice('/api/upload/'.length).split('?')[0];
    const manifest = uploadStore.getUpload(id);
    if (!manifest) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    try {
      _setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': manifest.mimeType || 'application/octet-stream',
      });
      fs.createReadStream(manifest.storedPath).pipe(res);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ── Server Lifecycle ───────────────────────────────────────────────

/**
 * Start the HTTP + WebSocket bridge server.
 * @param {number} [port]
 * @returns {Promise<{port: number, token: string, url: string, lanIp: string}>}
 */
async function startBridgeServer(port) {
  if (_wss) {
    const actualPort = getPort();
    const lanIp = getLanIp();
    return {
      port: actualPort,
      token: _token,
      pin: _pin,
      url: _getDisplayUrl(actualPort).url,
      lanIp,
    };
  }

  // Ensure ws is available
  let WebSocketServer;
  try {
    const ws = require('ws');
    WebSocketServer = ws.WebSocketServer || ws.Server;
  } catch {
    return { port: 0, token: '', pin: '', url: '', lanIp: 'localhost' };
  }

  const basePort = port || parseInt(process.env.BRIDGE_PORT) || DEFAULT_PORT;
  const bindHost = process.env.BRIDGE_BIND_HOST || DEFAULT_BIND_HOST;
  _bindHost = bindHost; // record actual bind host so display URLs match reality
  _token = generateToken();
  _lanIp = _getLanIp();

  // Initialize user database for registration/login
  try {
    require('./bridgeAuth').initUserDb();
  } catch {
    /* optional */
  }

  // Try binding with port fallback
  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    const tryPort = basePort + attempt;
    try {
      const result = await _tryStartServer(WebSocketServer, tryPort, bindHost);
      return result;
    } catch (err) {
      if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRIES) {
        continue; // try next port
      }
      // Final attempt failed or non-EADDRINUSE error
      return { port: 0, token: '', pin: '', url: '', lanIp: _lanIp };
    }
  }

  return { port: 0, token: '', pin: '', url: '', lanIp: _lanIp };
}

function _tryStartServer(WebSocketServer, serverPort, bindHost) {
  return new Promise((resolve, reject) => {
    const httpSrv = http.createServer(_handleHttpRequest);
    const wss = new WebSocketServer({ noServer: true });

    // Startup timeout protection
    const timeoutHandle = setTimeout(() => {
      reject(new Error('Bridge server startup timeout'));
    }, BRIDGE_TIMEOUT_MS);

    httpSrv.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws, req) => {
      const clientId = 'c-' + crypto.randomBytes(3).toString('hex');
      const remoteAddr = req.socket.remoteAddress || 'unknown';
      const userAgent = (req.headers && req.headers['user-agent']) || '';

      _clients.set(clientId, {
        ws,
        remoteAddress: remoteAddr,
        userAgent,
        connectedAt: Date.now(),
        authenticated: false,
        deviceName: '', // set once the client names this device
        deviceType: '', // 'phone' | 'tablet' | 'desktop'
      });

      ws.on('message', (data) => _handleMessage(clientId, data));
      ws.on('close', () => {
        const wasAuth = _clients.get(clientId)?.authenticated;
        _clients.delete(clientId);
        if (wasAuth) {
          _broadcastPresence();
        }
      });
      ws.on('error', () => {
        const wasAuth = _clients.get(clientId)?.authenticated;
        _clients.delete(clientId);
        if (wasAuth) {
          _broadcastPresence();
        }
      });

      // Send auth challenge
      _send(ws, { type: 'auth_required', clientId });
    });

    httpSrv.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });

    httpSrv.listen(serverPort, bindHost, () => {
      clearTimeout(timeoutHandle);
      _httpServer = httpSrv;
      _wss = wss;

      const actualPort = httpSrv.address().port;
      const url = _getDisplayUrl(actualPort).url;
      resolve({ port: actualPort, token: _token, pin: _pin, url, lanIp: _lanIp });
    });
  });
}

/**
 * Stop the bridge server.
 */
async function stopBridgeServer() {
  if (!_wss && !_httpServer) {
    return;
  }

  // Close all client connections
  for (const [, client] of _clients) {
    try {
      client.ws.close(1000, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }
  _clients.clear();

  return new Promise((resolve) => {
    const done = () => {
      _wss = null;
      _httpServer = null;
      _token = null;
      _pin = null;
      resolve();
    };

    if (_wss) {
      _wss.close(() => {
        if (_httpServer) {
          _httpServer.close(done);
        } else {
          done();
        }
      });
    } else if (_httpServer) {
      _httpServer.close(done);
    } else {
      done();
    }
  });
}

// ── Message Handling ───────────────────────────────────────────────

function _handleMessage(clientId, rawData) {
  const client = _clients.get(clientId);
  if (!client) {
    return;
  }

  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch {
    return;
  }

  switch (msg.type) {
    case 'auth': {
      // Apply the same per-IP login rate limit as HTTP auth (shared bucket) so a
      // LAN attacker cannot bypass it by brute-forcing the 6-digit PIN over WS.
      const rl = _checkAuthRateLimit(_rateLimitKeyForIp(client.remoteAddress));
      if (!rl.allowed) {
        _send(client.ws, { type: 'auth_failed', reason: rl.reason, retryAfterMs: rl.retryAfterMs });
        return;
      }
      if (_validateToken(msg.token)) {
        client.authenticated = true;
        // A returning device echoes back the name it stored locally; accept it
        // (validated) so the user is not prompted to name it again.
        const { isValidDeviceName } = require('@khy/shared/deviceIdentity');
        if (msg.deviceName && isValidDeviceName(String(msg.deviceName))) {
          client.deviceName = String(msg.deviceName);
          client.deviceType = String(msg.deviceType || '');
        }
        _send(client.ws, {
          type: 'auth_ok',
          clientId,
          needsDeviceName: !client.deviceName,
        });
        // Send recent message history for reconnect replay
        for (const histMsg of _messageHistory) {
          _send(client.ws, histMsg);
        }
        // Broadcast updated online presence (with device names)
        _broadcastPresence();
      } else {
        // Don't close connection — allow retry from login screen
        _send(client.ws, { type: 'auth_failed', reason: 'Invalid or expired token' });
      }
      break;
    }

    case 'input': {
      if (!client.authenticated) {
        return;
      }
      // Attachment ids (from POST /api/upload) ride alongside the text so the
      // REPL consumer can resolve them back into images / extracted text.
      const attachments = Array.isArray(msg.attachments)
        ? msg.attachments.filter((a) => typeof a === 'string')
        : [];
      _emitBridgeEvent('input', { text: msg.text, attachments, clientId });
      break;
    }

    case 'approve': {
      if (!client.authenticated) {
        return;
      }
      _emitBridgeEvent('approve', { requestId: msg.requestId, clientId });
      break;
    }

    case 'deny': {
      if (!client.authenticated) {
        return;
      }
      _emitBridgeEvent('deny', { requestId: msg.requestId, clientId });
      break;
    }

    case 'set_device': {
      if (!client.authenticated) {
        return;
      }
      // Async name resolution; isolated so a failure never disturbs the socket.
      _handleSetDevice(clientId, msg).catch(() => {
        /* never throws to caller */
      });
      break;
    }

    case 'resolve_device': {
      if (!client.authenticated) {
        return;
      }
      // Preview a suggested name WITHOUT committing it (prefills the naming UI).
      _handleResolveDevice(clientId, msg).catch(() => {
        /* never throws to caller */
      });
      break;
    }

    case 'ping': {
      _send(client.ws, { type: 'pong', timestamp: Date.now() });
      break;
    }
  }
}

/**
 * Resolve and assign a device name for a client.
 *
 * `msg.xx` is the user-typed short name. When empty, we try host-side real-name
 * resolution (reverse DNS / NetBIOS / mDNS) and finally fall back to a generic
 * platform name — never empty, never fabricated. The chosen name is de-duplicated
 * against other connected devices, stored, echoed back, and broadcast.
 *
 * @param {string} clientId
 * @param {{xx?:string, hints?:object, userAgent?:string}} msg
 */
async function _handleSetDevice(clientId, msg) {
  const client = _clients.get(clientId);
  if (!client) {
    return;
  }

  const {
    classifyDevice,
    formatDeviceName,
    autoDeviceName,
  } = require('@khy/shared/deviceIdentity');
  const userAgent = String(msg.userAgent || client.userAgent || '');
  const hints = msg.hints && typeof msg.hints === 'object' ? msg.hints : {};
  const { type, label, platform } = classifyDevice(userAgent, hints);

  const xx = typeof msg.xx === 'string' ? msg.xx.trim() : '';
  let name;
  let source;
  if (xx) {
    name = formatDeviceName(xx, label);
    source = 'user';
  } else {
    let real = null;
    try {
      const { resolveRealName } = require('./deviceNameResolver');
      real = await resolveRealName({ ip: client.remoteAddress, userAgent, hints });
    } catch {
      real = null;
    }
    if (real && real.name) {
      name = formatDeviceName(real.name, label);
      source = real.source;
    } else {
      name = autoDeviceName({ platform, label });
      source = 'generic';
    }
  }

  name = _dedupeDeviceName(name, clientId);
  client.deviceName = name;
  client.deviceType = type;

  _send(client.ws, { type: 'device_named', name, label, deviceType: type, source });
  _broadcastPresence();
}

/**
 * Resolve a suggested name for a client WITHOUT committing it. Powers the
 * naming overlay's prefill so the user sees the best real name we could find
 * (host reverse DNS / NetBIOS / mDNS + client hints) and can accept or edit it.
 * Reports the detected type/label and the resolution source honestly; when no
 * real name is found, `suggestedXx` is empty (the UI then offers auto-naming).
 *
 * @param {string} clientId
 * @param {{hints?:object, userAgent?:string}} msg
 */
async function _handleResolveDevice(clientId, msg) {
  const client = _clients.get(clientId);
  if (!client) {
    return;
  }

  const { classifyDevice } = require('@khy/shared/deviceIdentity');
  const userAgent = String(msg.userAgent || client.userAgent || '');
  const hints = msg.hints && typeof msg.hints === 'object' ? msg.hints : {};
  const { type, label } = classifyDevice(userAgent, hints);

  let suggestedXx = '';
  let source = 'none';
  try {
    const { resolveRealName } = require('./deviceNameResolver');
    const real = await resolveRealName({ ip: client.remoteAddress, userAgent, hints });
    if (real && real.name) {
      suggestedXx = real.name;
      source = real.source;
    }
  } catch {
    /* keep empty suggestion — UI falls back to auto-naming */
  }

  _send(client.ws, { type: 'device_suggestion', suggestedXx, label, deviceType: type, source });
}

/**
 * Ensure a device name is unique among connected clients by appending a numeric
 * suffix (e.g. `_小明手机`, `_小明手机-2`). Excludes the client being named.
 */
function _dedupeDeviceName(name, selfId) {
  const taken = new Set();
  for (const [id, c] of _clients) {
    if (id !== selfId && c.deviceName) {
      taken.add(c.deviceName);
    }
  }
  if (!taken.has(name)) {
    return name;
  }
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return name;
}

// ── Broadcasting ───────────────────────────────────────────────────

/**
 * Get count of authenticated (online) clients.
 */
function _getOnlineCount() {
  let count = 0;
  for (const [, c] of _clients) {
    if (c.authenticated && c.ws.readyState === 1) {
      count++;
    }
  }
  return count;
}

/**
 * List authenticated, currently-open devices with their names/types.
 */
function _getOnlineDevices() {
  const devices = [];
  for (const [, c] of _clients) {
    if (c.authenticated && c.ws.readyState === 1) {
      devices.push({ name: c.deviceName || '', type: c.deviceType || '' });
    }
  }
  return devices;
}

/**
 * Broadcast online presence (count + named device list) to all clients.
 */
function _broadcastPresence() {
  broadcastOutput({ type: 'presence', online: _getOnlineCount(), devices: _getOnlineDevices() });
}

// Event types kept OUT of the reconnect replay ring buffer.
//
// Two reasons to skip:
//  1. ephemeral / high-frequency fragments (pong, presence, chunk_*) are
//     emitted many times per turn; keeping them out of the 50-entry ring
//     prevents a single long turn from evicting the meaningful turn skeleton
//     (turn_start / turn_complete / approval_request) that devices replay;
//  2. 'chunk_tool_use' is a mid-turn artifact: replaying it to a reconnecting
//     device resurrects a tool call whose result never arrives, and the client
//     renders the scattered block as raw JSON to the user. Only settled-turn
//     events belong in the replay stream.
// Live (connected) devices still receive every fragment in real time.
const REPLAY_SKIP_TYPES = new Set([
  'pong',
  'presence',
  'approval_resolved',
  'chunk_text',
  'chunk_thinking',
  'chunk_tool_result',
  'chunk_status',
  'chunk_tool_use',
]);

/**
 * Whether a broadcast event type must be excluded from the reconnect replay ring.
 * @param {string} type - broadcast event type
 * @returns {boolean}
 */
function _shouldSkipHistory(type) {
  return REPLAY_SKIP_TYPES.has(String(type || ''));
}

/**
 * Snapshot of the reconnect replay ring buffer (copy — callers cannot mutate it).
 * @returns {Array<object>}
 */
function _getReplayHistory() {
  return _messageHistory.slice();
}

/**
 * Broadcast output to all authenticated clients.
 * @param {object} data - message object with `type` field
 */
function broadcastOutput(data) {
  if (!_wss) {
    return;
  }

  const enriched = { ...data, timestamp: Date.now() };
  const msg = JSON.stringify(enriched);

  if (!_shouldSkipHistory(data.type)) {
    _messageHistory.push(enriched);
    if (_messageHistory.length > HISTORY_MAX) {
      _messageHistory = _messageHistory.slice(-HISTORY_MAX);
    }
  }

  for (const [, client] of _clients) {
    if (client.authenticated && client.ws.readyState === 1) {
      // OPEN
      try {
        client.ws.send(msg);
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Token Management ───────────────────────────────────────────────

function generateToken() {
  _token = crypto.randomBytes(16).toString('hex');
  _pin = process.env.BRIDGE_PIN || String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  _tokenCreatedAt = Date.now();
  return _token;
}

function _validateToken(token) {
  if (!token) {
    return false;
  }

  // 1. PIN match (6 digits, time-limited)
  if (_pin && token === _pin) {
    return Date.now() - _tokenCreatedAt <= TOKEN_EXPIRY_MS;
  }

  // 2. Full hex token match (timing-safe, time-limited)
  if (_token && token.length === _token.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(_token))) {
        return Date.now() - _tokenCreatedAt <= TOKEN_EXPIRY_MS;
      }
    } catch {
      /* length mismatch */
    }
  }

  // 3. JWT session token (self-contained expiry)
  try {
    const auth = require('./bridgeAuth');
    const result = auth.validateJwt(token);
    if (result.ok) {
      return true;
    }
  } catch {
    /* bridgeAuth not available */
  }

  return false;
}

function getToken() {
  return _token;
}

function getPin() {
  return _pin;
}

function getPort() {
  if (!_httpServer) {
    return 0;
  }
  const addr = _httpServer.address();
  return addr ? addr.port : 0;
}

function getLanIp() {
  if (!_lanIp) {
    _lanIp = _getLanIp();
  }
  return _lanIp;
}

// Hosts that only accept connections from this machine itself. Covers the whole
// IPv4 loopback block (127.0.0.0/8), localhost, and IPv6 loopback including the
// IPv4-mapped form, so any loopback bind host is correctly treated as local-only.
function _isLocalOnlyHost(host) {
  if (!host) {
    return false;
  }
  const h = String(host).toLowerCase();
  return (
    h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h) || /^::ffff:127\./.test(h)
  );
}

/**
 * Build the collaboration display URL aligned with the ACTUAL bind host.
 * When bound to 127.0.0.1 we must not advertise the LAN IP (other devices
 * would hit ERR_CONNECTION_REFUSED); when bound to 0.0.0.0 (or any LAN
 * address) the LAN IP is the correct, reachable address for phones/other hosts.
 * @param {number} port
 * @returns {{ url: string, localOnly: boolean }}
 */
function _getDisplayUrl(port) {
  const lanIp = getLanIp();
  // Also degrade to local-only when no usable LAN interface exists (getLanIp
  // falls back to 'localhost'); otherwise we would advertise an unreachable URL.
  const localOnly = _isLocalOnlyHost(_bindHost) || lanIp === 'localhost';
  const displayHost = localOnly ? '127.0.0.1' : lanIp;
  return { url: `http://${displayHost}:${port}/`, localOnly };
}

// ── Event Emitter ──────────────────────────────────────────────────

const _eventListeners = [];

function _emitBridgeEvent(event, data) {
  for (const listener of _eventListeners) {
    try {
      listener(event, data);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Register a bridge event listener.
 * @param {function} listener - (event, data) => void
 * @returns {function} Unsubscribe function
 */
function onBridgeEvent(listener) {
  _eventListeners.push(listener);
  return () => {
    const idx = _eventListeners.indexOf(listener);
    if (idx >= 0) {
      _eventListeners.splice(idx, 1);
    }
  };
}

// ── Status Display ─────────────────────────────────────────────────

function printStatus() {
  const c = chalk();
  if (!_wss) {
    console.log(c.gray('\n  Bridge server is not running.\n'));
    return;
  }

  const port = getPort();
  const connected = getConnectedClients();
  const clientCount = connected.length;
  const { url, localOnly } = _getDisplayUrl(port);

  console.log(c.bold('\n  Bridge Status'));
  console.log(c.gray('  ' + '\u2500'.repeat(35)));
  console.log(`  \u534F\u4F5C\u94FE\u63A5:  ${c.green(url)}`);
  // In localhost-only mode the LAN IP is unreachable from other devices, so tell
  // the user exactly how to enable LAN collaboration instead of misleading them.
  if (localOnly) {
    console.log(
      c.yellow(
        '           \u4EC5\u9650\u672C\u673A\u8BBF\u95EE\uFF0C\u8BBE BRIDGE_BIND_HOST=0.0.0.0 \u5F00\u542F\u5C40\u57DF\u7F51\u534F\u4F5C'
      )
    );
  }
  console.log(`  PIN:     ${_pin ? c.cyan.bold(_pin) : c.gray('none')}`);
  console.log(`  \u5DF2\u8FDE\u63A5:  ${c.cyan(clientCount)} \u4E2A\u5BA2\u6237\u7AEF`);
  // List each connected device by name (falls back to its IP when unnamed).
  for (const dev of connected) {
    const label = dev.deviceName || c.gray(dev.remoteAddress || dev.id);
    console.log(`           \u2022 ${c.cyan(label)}`);
  }
  console.log(`  Token:   ${_token ? c.cyan(_token.slice(0, 8) + '...') : c.gray('none')}`);
  console.log('');
}

function printToken() {
  const c = chalk();
  if (!_wss || !_token) {
    console.log(c.gray('\n  No active bridge server. Run: bridge start\n'));
    return;
  }
  const remaining = Math.max(0, TOKEN_EXPIRY_MS - (Date.now() - _tokenCreatedAt));
  console.log(c.bold('\n  Bridge Token'));
  console.log(c.cyan(`  ${_token.slice(0, 8)}...${_token.slice(-4)}`));
  console.log(c.gray(`  Expires in ${Math.round(remaining / 60000)} minutes\n`));
}

// ── Rate Limiting for Auth Endpoints ──────────────────────────────
// Prevent brute-force attacks on PIN/password auth over LAN.

const _authAttempts = new Map(); // key → { count, firstAttempt, lastAttempt }
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const AUTH_RATE_LIMIT_MAX = 10; // max attempts per window per key
const AUTH_LOCKOUT_MS = 5 * 60_000; // 5 minute lockout after exceeding limit

function _checkAuthRateLimit(key) {
  const now = Date.now();
  const entry = _authAttempts.get(key);

  if (!entry) {
    _authAttempts.set(key, { count: 1, firstAttempt: now, lastAttempt: now });
    return { allowed: true };
  }

  // Check if locked out
  if (entry.count >= AUTH_RATE_LIMIT_MAX && now - entry.lastAttempt < AUTH_LOCKOUT_MS) {
    const remainingMs = AUTH_LOCKOUT_MS - (now - entry.lastAttempt);
    return {
      allowed: false,
      retryAfterMs: remainingMs,
      reason: `Too many attempts. Try again in ${Math.ceil(remainingMs / 1000)}s`,
    };
  }

  // Reset window if expired
  if (now - entry.firstAttempt > AUTH_RATE_LIMIT_WINDOW_MS) {
    entry.count = 1;
    entry.firstAttempt = now;
    entry.lastAttempt = now;
    return { allowed: true };
  }

  // Increment attempt
  entry.count++;
  entry.lastAttempt = now;

  if (entry.count >= AUTH_RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterMs: AUTH_LOCKOUT_MS,
      reason: `Rate limit exceeded (${AUTH_RATE_LIMIT_MAX} attempts per minute). Locked out for 5 minutes.`,
    };
  }

  return { allowed: true };
}

function _getAuthRateLimitKey(req) {
  // Per-IP rate limiting only; HTTP (/api/register, /api/login) and WS auth
  // share the same bucket so an attacker cannot bypass one path via the other.
  return _rateLimitKeyForIp(req.socket && req.socket.remoteAddress);
}

function _rateLimitKeyForIp(ip) {
  return ip || 'unknown';
}

// ── Nginx Config Generator ────────────────────────────────────────

/**
 * Generate nginx reverse proxy config snippet for bridge server.
 * @param {object} [opts]
 * @param {string} [opts.serverName] - server_name (default: _)
 * @param {number} [opts.listenPort] - nginx listen port (default: 80)
 * @param {string} [opts.locationPrefix] - URL path prefix (default: /khy)
 * @param {boolean} [opts.ssl] - include HTTPS listen + redirect
 * @param {string} [opts.certPath] - path to SSL cert
 * @param {string} [opts.keyPath] - path to SSL key
 * @returns {string} nginx config text
 */
function generateNginxConfig(opts = {}) {
  const bridgePort = getPort() || DEFAULT_PORT;
  const serverName = opts.serverName || '_';
  const listenPort = opts.listenPort || 80;
  const prefix = (opts.locationPrefix || '/khy').replace(/\/+$/, '');
  const upstream = `127.0.0.1:${bridgePort}`;
  const ssl = opts.ssl && opts.certPath && opts.keyPath;

  const lines = [
    '# KHY Bridge — nginx reverse proxy config',
    `# Generated: ${new Date().toISOString()}`,
    `# Bridge port: ${bridgePort}`,
    '',
    'upstream khy_bridge {',
    `    server ${upstream};`,
    '}',
    '',
    'server {',
    `    listen ${listenPort};`,
  ];

  if (ssl) {
    lines.push(`    listen 443 ssl;`);
    lines.push(`    ssl_certificate     ${opts.certPath};`);
    lines.push(`    ssl_certificate_key ${opts.keyPath};`);
  }

  lines.push(`    server_name ${serverName};`);
  lines.push('');

  // HTML page + static assets
  lines.push(`    # Mobile control page`);
  lines.push(`    location ${prefix}/ {`);
  lines.push(`        proxy_pass http://khy_bridge/;`);
  lines.push(`        proxy_set_header Host $host;`);
  lines.push(`        proxy_set_header X-Real-IP $remote_addr;`);
  lines.push(`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
  lines.push(`        proxy_set_header X-Forwarded-Proto $scheme;`);
  lines.push(`    }`);
  lines.push('');

  // WebSocket upgrade path
  lines.push(`    # WebSocket connection`);
  lines.push(`    location ${prefix}/ws {`);
  lines.push(`        proxy_pass http://khy_bridge/;`);
  lines.push(`        proxy_http_version 1.1;`);
  lines.push(`        proxy_set_header Upgrade $http_upgrade;`);
  lines.push(`        proxy_set_header Connection "upgrade";`);
  lines.push(`        proxy_set_header Host $host;`);
  lines.push(`        proxy_set_header X-Real-IP $remote_addr;`);
  lines.push(`        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
  lines.push(`        proxy_set_header X-Forwarded-Proto $scheme;`);
  lines.push(`        proxy_read_timeout 86400s;`);
  lines.push(`        proxy_send_timeout 86400s;`);
  lines.push(`    }`);

  // Health check
  lines.push('');
  lines.push(`    # Health check`);
  lines.push(`    location ${prefix}/health {`);
  lines.push(`        proxy_pass http://khy_bridge/health;`);
  lines.push(`    }`);

  lines.push('}');
  return lines.join('\n');
}

function printNginxConfig(opts = {}) {
  const c = chalk();
  const port = getPort();
  const prefix = (opts.locationPrefix || '/khy').replace(/\/+$/, '');

  console.log(c.bold('\n  Bridge Nginx Config'));
  console.log(c.gray('  ' + '\u2500'.repeat(35)));

  if (!port) {
    console.log(c.yellow('  Bridge not running — using default port ' + DEFAULT_PORT));
  }

  const config = generateNginxConfig(opts);
  console.log('');
  console.log(config);
  console.log('');
  console.log(c.dim('  Usage:'));
  console.log(c.dim(`  1. Save to /etc/nginx/conf.d/khy-bridge.conf`));
  console.log(c.dim(`  2. nginx -t && nginx -s reload`));
  console.log(c.dim(`  3. Open http://<server>${prefix}/?token=<token>`));
  console.log('');
}

// ── Helpers ────────────────────────────────────────────────────────

function _send(ws, data) {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function getConnectedClients() {
  return [..._clients.entries()]
    .filter(([, c]) => c.authenticated)
    .map(([id, c]) => ({
      id,
      remoteAddress: c.remoteAddress,
      connectedAt: c.connectedAt,
      deviceName: c.deviceName || '',
      deviceType: c.deviceType || '',
    }));
}

/**
 * Compact, render-ready status for the persistent TUI footer. Single source of
 * truth so the UI never has to call five getters + slice the token itself; it
 * also keeps the live (non-secret) collaboration state visible across a whole
 * session instead of scrolling away after the one-shot `printStatus()` banner.
 * `running` is false (and the footer renders nothing) when no bridge is up.
 * @returns {{running:boolean, url?:string, localOnly?:boolean, pin?:string, clientCount?:number, tokenShort?:string}}
 */
function getStatusSnapshot() {
  if (!_wss) {
    return { running: false };
  }
  const port = getPort();
  const { url, localOnly } = _getDisplayUrl(port);
  return {
    running: port > 0,
    url,
    // True when bound to 127.0.0.1: the URL is reachable from this machine only.
    localOnly,
    pin: _pin || '',
    clientCount: getConnectedClients().length,
    // Short, non-sensitive prefix only — mirrors printStatus(), never the full token.
    tokenShort: _token ? _token.slice(0, 8) : '',
  };
}

module.exports = {
  startBridgeServer,
  stopBridgeServer,
  broadcastOutput,
  _shouldSkipHistory,
  _getReplayHistory,
  onBridgeEvent,
  generateToken,
  getConnectedClients,
  getStatusSnapshot,
  getToken,
  getPin,
  getPort,
  getLanIp,
  printStatus,
  printToken,
  generateNginxConfig,
  printNginxConfig,
};
