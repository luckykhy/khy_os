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
const MAX_PORT_RETRIES = 3;
const TOKEN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

let _httpServer = null;
let _wss = null;
let _clients = new Map(); // id → { ws, remoteAddress, connectedAt, authenticated }
let _token = null;
let _pin = null; // 6-digit PIN for mobile login
let _tokenCreatedAt = 0;
let _lanIp = null;

// ── Message History Ring Buffer (for reconnect replay) ──
const HISTORY_MAX = 50;
let _messageHistory = []; // recent broadcast messages for replay

let _chalk;
function chalk() {
  if (_chalk) return _chalk;
  const m = require('chalk');
  _chalk = m.default || m;
  return _chalk;
}

// ── LAN IP Discovery ──────────────────────────────────────────────

/**
 * Find the best LAN IPv4 address for this machine.
 * Reuses the proven logic from routes/system.js.
 */
function _getLanIp() {
  const interfaces = os.networkInterfaces();
  const virtualKeywords = [
    'vmware', 'virtualbox', 'vbox', 'virtual', 'vethernet',
    'docker', 'wsl', 'hyper-v', 'loopback', 'tunnel',
  ];
  const candidates = [];

  for (const ifName in interfaces) {
    const lowerName = ifName.toLowerCase();
    const isVirtual = virtualKeywords.some(kw => lowerName.includes(kw));

    for (const iface of interfaces[ifName]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (ip.startsWith('169.254')) continue; // APIPA

      let priority = 4;
      if (ip.startsWith('192.168') && !isVirtual) priority = 1;
      else if (ip.startsWith('10.') && !isVirtual) priority = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip) && !isVirtual) priority = 3;

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
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function _jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// ── HTTP Request Handler ──────────────────────────────────────────

async function _handleHttpRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
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
    const clients = [..._clients.values()].filter(c => c.authenticated).length;
    _jsonResponse(res, 200, { status: 'ok', clients });
    return;
  }

  // ── Auth API ──
  if (req.method === 'POST' && req.url === '/api/register') {
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
          error: tooLarge ? '文件过大' : (err.message || '上传失败'),
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
  if (req.method === 'GET' && req.url.startsWith('/api/upload/')) {
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
      res.writeHead(200, {
        'Content-Type': manifest.mimeType || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
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
    return { port: actualPort, token: _token, pin: _pin, url: `http://${lanIp}:${actualPort}/`, lanIp };
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
  _token = generateToken();
  _lanIp = _getLanIp();

  // Initialize user database for registration/login
  try { require('./bridgeAuth').initUserDb(); } catch { /* optional */ }

  // Try binding with port fallback
  for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
    const tryPort = basePort + attempt;
    try {
      const result = await _tryStartServer(WebSocketServer, tryPort);
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

function _tryStartServer(WebSocketServer, serverPort) {
  return new Promise((resolve, reject) => {
    const httpSrv = http.createServer(_handleHttpRequest);
    const wss = new WebSocketServer({ noServer: true });

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
        deviceName: '',   // set once the client names this device
        deviceType: '',   // 'phone' | 'tablet' | 'desktop'
      });

      ws.on('message', (data) => _handleMessage(clientId, data));
      ws.on('close', () => {
        const wasAuth = _clients.get(clientId)?.authenticated;
        _clients.delete(clientId);
        if (wasAuth) _broadcastPresence();
      });
      ws.on('error', () => {
        const wasAuth = _clients.get(clientId)?.authenticated;
        _clients.delete(clientId);
        if (wasAuth) _broadcastPresence();
      });

      // Send auth challenge
      _send(ws, { type: 'auth_required', clientId });
    });

    httpSrv.on('error', (err) => {
      reject(err);
    });

    httpSrv.listen(serverPort, () => {
      _httpServer = httpSrv;
      _wss = wss;

      const actualPort = httpSrv.address().port;
      const url = `http://${_lanIp}:${actualPort}/`;
      resolve({ port: actualPort, token: _token, pin: _pin, url, lanIp: _lanIp });
    });
  });
}

/**
 * Stop the bridge server.
 */
async function stopBridgeServer() {
  if (!_wss && !_httpServer) return;

  // Close all client connections
  for (const [, client] of _clients) {
    try { client.ws.close(1000, 'Server shutting down'); } catch { /* ignore */ }
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
  if (!client) return;

  let msg;
  try { msg = JSON.parse(rawData.toString()); } catch { return; }

  switch (msg.type) {
    case 'auth': {
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
      if (!client.authenticated) return;
      // Attachment ids (from POST /api/upload) ride alongside the text so the
      // REPL consumer can resolve them back into images / extracted text.
      const attachments = Array.isArray(msg.attachments)
        ? msg.attachments.filter(a => typeof a === 'string')
        : [];
      _emitBridgeEvent('input', { text: msg.text, attachments, clientId });
      break;
    }

    case 'approve': {
      if (!client.authenticated) return;
      _emitBridgeEvent('approve', { requestId: msg.requestId, clientId });
      break;
    }

    case 'deny': {
      if (!client.authenticated) return;
      _emitBridgeEvent('deny', { requestId: msg.requestId, clientId });
      break;
    }

    case 'set_device': {
      if (!client.authenticated) return;
      // Async name resolution; isolated so a failure never disturbs the socket.
      _handleSetDevice(clientId, msg).catch(() => { /* never throws to caller */ });
      break;
    }

    case 'resolve_device': {
      if (!client.authenticated) return;
      // Preview a suggested name WITHOUT committing it (prefills the naming UI).
      _handleResolveDevice(clientId, msg).catch(() => { /* never throws to caller */ });
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
  if (!client) return;

  const { classifyDevice, formatDeviceName, autoDeviceName } = require('@khy/shared/deviceIdentity');
  const userAgent = String(msg.userAgent || client.userAgent || '');
  const hints = (msg.hints && typeof msg.hints === 'object') ? msg.hints : {};
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
    } catch { real = null; }
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
  if (!client) return;

  const { classifyDevice } = require('@khy/shared/deviceIdentity');
  const userAgent = String(msg.userAgent || client.userAgent || '');
  const hints = (msg.hints && typeof msg.hints === 'object') ? msg.hints : {};
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
  } catch { /* keep empty suggestion — UI falls back to auto-naming */ }

  _send(client.ws, { type: 'device_suggestion', suggestedXx, label, deviceType: type, source });
}

/**
 * Ensure a device name is unique among connected clients by appending a numeric
 * suffix (e.g. `_小明手机`, `_小明手机-2`). Excludes the client being named.
 */
function _dedupeDeviceName(name, selfId) {
  const taken = new Set();
  for (const [id, c] of _clients) {
    if (id !== selfId && c.deviceName) taken.add(c.deviceName);
  }
  if (!taken.has(name)) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate)) return candidate;
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
    if (c.authenticated && c.ws.readyState === 1) count++;
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

/**
 * Broadcast output to all authenticated clients.
 * @param {object} data - message object with `type` field
 */
function broadcastOutput(data) {
  if (!_wss) return;

  const enriched = { ...data, timestamp: Date.now() };
  const msg = JSON.stringify(enriched);

  // Save to history ring buffer (skip ephemeral / high-frequency types).
  // Per-chunk streaming fragments (chunk_text/thinking/tool_result/status) are
  // emitted many times per turn; keeping them out of the 50-entry ring prevents
  // a single long turn from evicting the meaningful turn skeleton (turn_start /
  // turn_complete / chunk_tool_use / approval_request) that reconnecting devices
  // replay. Live (connected) devices still receive every fragment in real time.
  const skipHistory = new Set([
    'pong', 'presence', 'approval_resolved',
    'chunk_text', 'chunk_thinking', 'chunk_tool_result', 'chunk_status',
  ]);
  if (!skipHistory.has(data.type)) {
    _messageHistory.push(enriched);
    if (_messageHistory.length > HISTORY_MAX) {
      _messageHistory = _messageHistory.slice(-HISTORY_MAX);
    }
  }

  for (const [, client] of _clients) {
    if (client.authenticated && client.ws.readyState === 1) { // OPEN
      try { client.ws.send(msg); } catch { /* ignore */ }
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
  if (!token) return false;

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
    } catch { /* length mismatch */ }
  }

  // 3. JWT session token (self-contained expiry)
  try {
    const auth = require('./bridgeAuth');
    const result = auth.validateJwt(token);
    if (result.ok) return true;
  } catch { /* bridgeAuth not available */ }

  return false;
}

function getToken() { return _token; }
function getPin() { return _pin; }

function getPort() {
  if (!_httpServer) return 0;
  const addr = _httpServer.address();
  return addr ? addr.port : 0;
}

function getLanIp() {
  if (!_lanIp) _lanIp = _getLanIp();
  return _lanIp;
}

// ── Event Emitter ──────────────────────────────────────────────────

const _eventListeners = [];

function _emitBridgeEvent(event, data) {
  for (const listener of _eventListeners) {
    try { listener(event, data); } catch { /* ignore */ }
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
    if (idx >= 0) _eventListeners.splice(idx, 1);
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
  const lanIp = getLanIp();

  console.log(c.bold('\n  Bridge Status'));
  console.log(c.gray('  ' + '\u2500'.repeat(35)));
  console.log(`  \u534F\u4F5C\u94FE\u63A5:  ${c.green(`http://${lanIp}:${port}`)}`);
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
  console.log(c.cyan(`  ${_token}`));
  console.log(c.gray(`  Expires in ${Math.round(remaining / 60000)} minutes\n`));
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
  try { ws.send(JSON.stringify(data)); } catch { /* ignore */ }
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
 * @returns {{running:boolean, url?:string, pin?:string, clientCount?:number, tokenShort?:string}}
 */
function getStatusSnapshot() {
  if (!_wss) return { running: false };
  const port = getPort();
  return {
    running: port > 0,
    url: `http://${getLanIp()}:${port}`,
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
