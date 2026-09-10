'use strict';

/**
 * crossPlatformSyncServer.js 鈥?WebSocket server for 4-platform real-time sync.
 *
 * Attaches to the existing aiManagementServer HTTP server and handles
 * WebSocket connections from Terminal, Web, Desktop, and Mobile clients.
 *
 * Protocol:
 *   Client 鈫?Server:
 *     { type: 'auth', token, deviceId, platform, deviceName, userId }
 *     { type: 'ping' }
 *     { type: 'session:join', sessionId }
 *     { type: 'session:leave', sessionId }
 *     { type: 'session:update', sessionId, delta }
 *     { type: 'message:send', targetDeviceId?, targetPlatform?, payload }
 *     { type: 'command:route', targetPlatform, command, payload }
 *     { type: 'device:list' }
 *
 *   Server 鈫?Client:
 *     { type: 'auth:ok', deviceId, platforms }
 *     { type: 'auth:error', error }
 *     { type: 'pong' }
 *     { type: 'session:updated', sessionId, state, version, modifiedBy }
 *     { type: 'session:joined', sessionId, participants }
 *     { type: 'message', fromDeviceId, fromPlatform, payload }
 *     { type: 'command', fromDeviceId, fromPlatform, command, payload }
 *     { type: 'presence', devices }
 *     { type: 'device:list', devices }
 *     { type: 'notification', title, body, data }
 *
 * @module services/crossPlatform/ws/syncServer
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 鈹€鈹€ Module state 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
let _wss = null;
let _hub = null;
let _authenticate = null;
let _clients = new Map(); // deviceId 鈫?{ ws, userId, platform, deviceName, sessions: Set }
let _persistenceDir = null;
let _persistenceFile = null;
let _persistenceDirty = false;
let _persistenceTimer = null;
const PERSIST_INTERVAL_MS = 5000;

// 鈹€鈹€ Persistence helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function _ensurePersistenceDir() {
  if (_persistenceDir) return;
  try {
    const { getDataHome } = require('../../utils/dataHome.cjs');
    _persistenceDir = path.join(getDataHome(), 'sync');
    fs.mkdirSync(_persistenceDir, { recursive: true });
    _persistenceFile = path.join(_persistenceDir, 'crossPlatformHub.json');
  } catch {
    _persistenceDir = null;
    _persistenceFile = null;
  }
}

function _loadFromDisk() {
  _ensurePersistenceDir();
  if (!_persistenceFile || !fs.existsSync(_persistenceFile)) return null;
  try {
    const raw = fs.readFileSync(_persistenceFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _saveToDisk() {
  if (!_persistenceFile || !_hub) return;
  try {
    const snapshot = {
      savedAt: Date.now(),
      devices: _hub.listDevices({ connectedOnly: false }),
      sessions: Array.from(_hub._sessions?.entries() || []).map(([id, s]) => ({
        sessionId: id,
        state: s.state,
        version: s.version,
        lastModified: s.lastModified,
        modifiedBy: s.modifiedBy,
      })),
    };
    const tmp = `${_persistenceFile}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmp, _persistenceFile);
    _persistenceDirty = false;
  } catch {
    /* best effort */
  }
}

function _schedulePersistence() {
  _persistenceDirty = true;
  if (_persistenceTimer) return;
  _persistenceTimer = setTimeout(() => {
    _persistenceTimer = null;
    if (_persistenceDirty) _saveToDisk();
  }, PERSIST_INTERVAL_MS);
}

// 鈹€鈹€ Client management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function _registerClient(deviceId, ws, info) {
  _clients.set(deviceId, {
    ws,
    userId: info.userId || 'anonymous',
    platform: info.platform,
    deviceName: info.deviceName || '',
    sessions: new Set(),
    connectedAt: Date.now(),
  });
}

function _unregisterClient(deviceId) {
  const client = _clients.get(deviceId);
  if (!client) return;

  // Leave all sessions
  for (const sessionId of client.sessions) {
    _hub?.unsubscribe?.(`${sessionId}:update`, deviceId);
  }
  _clients.delete(deviceId);
}

function _sendToClient(deviceId, message) {
  const client = _clients.get(deviceId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
  try {
    client.ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function _broadcastToUser(userId, message, excludeDeviceId = null) {
  let delivered = 0;
  for (const [deviceId, client] of _clients) {
    if (client.userId === userId && deviceId !== excludeDeviceId) {
      if (_sendToClient(deviceId, message)) delivered++;
    }
  }
  return delivered;
}

function _broadcastToPlatform(platform, message, excludeDeviceId = null) {
  let delivered = 0;
  for (const [deviceId, client] of _clients) {
    if (client.platform === platform && deviceId !== excludeDeviceId) {
      if (_sendToClient(deviceId, message)) delivered++;
    }
  }
  return delivered;
}

function _broadcastPresence() {
  const devices = [];
  for (const [deviceId, client] of _clients) {
    devices.push({
      deviceId,
      platform: client.platform,
      deviceName: client.deviceName,
      userId: client.userId,
      connectedAt: client.connectedAt,
    });
  }
  const message = { type: 'presence', devices, timestamp: Date.now() };
  for (const deviceId of _clients.keys()) {
    _sendToClient(deviceId, message);
  }
}

// 鈹€鈹€ Message handlers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function _handleAuth(ws, msg) {
  const { token, deviceId, platform, deviceName, userId } = msg;

  if (!deviceId || !platform) {
    ws.send(JSON.stringify({ type: 'auth:error', error: 'deviceId and platform required' }));
    return;
  }

  // Authenticate if auth function is available
  let authUserId = userId || 'anonymous';
  if (_authenticate && token) {
    try {
      const result = await _authenticate(token, null, {});
      if (result?.ok) {
        authUserId = result.user?.id ? `user:${result.user.id}` : authUserId;
      }
    } catch {
      /* fall through to unauthenticated */
    }
  }

  // Register with hub
  if (_hub) {
    _hub.registerDevice({
      deviceId,
      platform,
      userId: authUserId,
      deviceName,
      capabilities: msg.capabilities || {},
    });
  }

  _registerClient(deviceId, ws, {
    userId: authUserId,
    platform,
    deviceName,
  });

  // Send auth confirmation with current platforms
  const platforms = {};
  for (const [, client] of _clients) {
    if (client.userId === authUserId) {
      platforms[client.platform] = (platforms[client.platform] || 0) + 1;
    }
  }

  ws.send(JSON.stringify({
    type: 'auth:ok',
    deviceId,
    userId: authUserId,
    platforms,
    timestamp: Date.now(),
  }));

  // Broadcast presence update
  _broadcastPresence();
  _schedulePersistence();
}

function _handlePing(ws, msg, deviceId) {
  _hub?.touchDevice(deviceId);
  ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
}

function _handleSessionJoin(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  client.sessions.add(sessionId);
  _hub?.subscribe?.(`${sessionId}:update`, deviceId);

  // Register session if new
  if (_hub && !_hub.getSession(sessionId)) {
    _hub.registerSession(sessionId, { createdBy: deviceId });
  }

  // Notify other participants
  const participants = [];
  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId)) participants.push({ deviceId: did, platform: c.platform });
  }

  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, {
        type: 'session:joined',
        sessionId,
        deviceId,
        platform: client.platform,
        participants,
      });
    }
  }

  // Send current session state to joiner
  const session = _hub?.getSession(sessionId);
  if (session) {
    ws.send(JSON.stringify({
      type: 'session:updated',
      sessionId,
      state: session.state,
      version: session.version,
      modifiedBy: session.modifiedBy,
      timestamp: session.lastModified,
    }));
  }
}

function _handleSessionHandoff(ws, msg, deviceId) {
  const { sessionId, targetDeviceId, targetPlatform } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // Find target device
  let target = null;
  if (targetDeviceId) {
    target = _clients.get(targetDeviceId);
  } else if (targetPlatform) {
    for (const [did, c] of _clients) {
      if (c.platform === targetPlatform && c.userId === client.userId) {
        target = c;
        break;
      }
    }
  }

  if (!target) {
    _sendToClient(deviceId, {
      type: 'error',
      error: '鐩爣璁惧涓嶅湪绾?,
    });
    return;
  }

  // Get current session state
  const session = _hub?.getSession(sessionId);
  if (!session) {
    _sendToClient(deviceId, {
      type: 'error',
      error: '浼氳瘽涓嶅瓨鍦?,
    });
    return;
  }

  // Send handoff request to target
  _sendToClient(target.deviceId, {
    type: 'session:handoff:request',
    sessionId,
    state: session.state,
    version: session.version,
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    timestamp: Date.now(),
  });

  // Notify source that handoff was initiated
  _sendToClient(deviceId, {
    type: 'session:handoff:initiated',
    sessionId,
    targetDeviceId: target.deviceId,
    timestamp: Date.now(),
  });
}

function _handleSessionHandoffAccept(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // Add target to session
  client.sessions.add(sessionId);

  // Notify all participants
  const participants = [];
  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId)) {
      participants.push({ deviceId: did, platform: c.platform });
    }
  }

  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, {
        type: 'session:handoff:accepted',
        sessionId,
        deviceId,
        platform: client.platform,
        participants,
      });
    }
  }

  // Send current session state to accepter
  const session = _hub?.getSession(sessionId);
  if (session) {
    ws.send(JSON.stringify({
      type: 'session:updated',
      sessionId,
      state: session.state,
      version: session.version,
      modifiedBy: session.modifiedBy,
      timestamp: session.lastModified,
    }));
  }
}

function _handleSessionLeave(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  client.sessions.delete(sessionId);
  _hub?.unsubscribe?.(`${sessionId}:update`, deviceId);
}

function _handleSessionUpdate(ws, msg, deviceId) {
  const { sessionId, delta } = msg;
  if (!sessionId || !delta) return;

  if (!_hub) return;
  const session = _hub.updateSession(sessionId, delta, deviceId);
  _schedulePersistence();

  // Broadcast to all participants in this session
  const message = {
    type: 'session:updated',
    sessionId,
    state: session.state,
    version: session.version,
    modifiedBy: deviceId,
    timestamp: session.lastModified,
  };

  for (const [did, client] of _clients) {
    if (client.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, message);
    }
  }
}

function _handleMessageSend(ws, msg, deviceId) {
  const { targetDeviceId, targetPlatform, payload } = msg;
  if (!payload) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  const message = {
    type: 'message',
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    payload,
    timestamp: Date.now(),
  };

  if (targetDeviceId) {
    _sendToClient(targetDeviceId, message);
  } else if (targetPlatform) {
    _broadcastToPlatform(targetPlatform, message, deviceId);
  } else {
    _broadcastToUser(client.userId, message, deviceId);
  }
}

function _handleCommandRoute(ws, msg, deviceId) {
  const { targetPlatform, command, payload } = msg;
  if (!targetPlatform || !command) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  const message = {
    type: 'command',
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    command,
    payload: payload || {},
    timestamp: Date.now(),
  };

  _broadcastToPlatform(targetPlatform, message, deviceId);
}

function _handleDeviceList(ws, msg, deviceId) {
  const client = _clients.get(deviceId);
  if (!client) return;

  const devices = [];
  for (const [did, c] of _clients) {
    if (c.userId === client.userId) {
      devices.push({
        deviceId: did,
        platform: c.platform,
        deviceName: c.deviceName,
        connectedAt: c.connectedAt,
      });
    }
  }

  ws.send(JSON.stringify({ type: 'device:list', devices }));
}

// 鈹€鈹€ WebSocket connection handler 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function _handleConnection(ws, req) {
  let deviceId = null;

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (!msg || !msg.type) return;

    try {
      switch (msg.type) {
        case 'auth':
          deviceId = msg.deviceId;
          await _handleAuth(ws, msg);
          break;
        case 'ping':
          _handlePing(ws, msg, deviceId);
          break;
        case 'session:join':
          _handleSessionJoin(ws, msg, deviceId);
          break;
        case 'session:handoff':
          _handleSessionHandoff(ws, msg, deviceId);
          break;
        case 'session:handoff:accept':
          _handleSessionHandoffAccept(ws, msg, deviceId);
          break;
        case 'session:leave':
          _handleSessionLeave(ws, msg, deviceId);
          break;
        case 'session:update':
          _handleSessionUpdate(ws, msg, deviceId);
          break;
        case 'message:send':
          _handleMessageSend(ws, msg, deviceId);
          break;
        case 'command:route':
          _handleCommandRoute(ws, msg, deviceId);
          break;
        case 'device:list':
          _handleDeviceList(ws, msg, deviceId);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      _unregisterClient(deviceId);
      _hub?.unregisterDevice(deviceId);
      _broadcastPresence();
      _schedulePersistence();
    }
  });

  ws.on('error', () => {
    if (deviceId) {
      _unregisterClient(deviceId);
      _hub?.unregisterDevice(deviceId);
    }
  });

  // Send initial hello
  ws.send(JSON.stringify({
    type: 'hello',
    server: 'khy-os-cross-platform-sync',
    protocol: 1,
    timestamp: Date.now(),
  }));
}

// 鈹€鈹€ Public API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * Attach the cross-platform sync WebSocket server to an existing HTTP server.
 * @param {http.Server} httpServer - The HTTP server instance
 * @param {object} options
 * @param {object} options.hub - CrossPlatformHub instance
 * @param {function} [options.authenticate] - Auth function (token, apiKey, opts) => { ok, user }
 * @param {string} [options.path] - WebSocket path (default: /ws/cross-platform)
 */
function attach(httpServer, options = {}) {
  if (_wss) return; // Already attached

  _hub = options.hub || null;
  _authenticate = options.authenticate || null;

  // Load persisted state from disk
  const persisted = _loadFromDisk();
  if (persisted && _hub) {
    // Restore sessions (devices will re-register on connect)
    for (const s of persisted.sessions || []) {
      _hub.registerSession(s.sessionId, s.state);
      const session = _hub.getSession(s.sessionId);
      if (session) {
        session.version = s.version || 1;
        session.lastModified = s.lastModified || Date.now();
        session.modifiedBy = s.modifiedBy || 'restored';
      }
    }
  }

  _wss = new WebSocket.Server({
    server: httpServer,
    path: options.path || '/ws/cross-platform',
    maxPayload: 1024 * 1024, // 1MB
  });

  _wss.on('connection', _handleConnection);

  // Periodic heartbeat / cleanup
  const heartbeat = setInterval(() => {
    if (!_wss) { clearInterval(heartbeat); return; }
    for (const ws of _wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  _wss.on('close', () => clearInterval(heartbeat));

  return _wss;
}

/**
 * Detach the WebSocket server.
 */
function detach() {
  if (_persistenceTimer) {
    clearTimeout(_persistenceTimer);
    _persistenceTimer = null;
  }
  _saveToDisk();

  if (_wss) {
    for (const ws of _wss.clients) {
      ws.close(1001, 'Server shutting down');
    }
    _wss.close();
    _wss = null;
  }
  _clients.clear();
}

/**
 * Get connected client count.
 */
function getClientCount() {
  return _clients.size;
}

/**
 * Get sync server status.
 */
function getStatus() {
  return {
    connected: _wss !== null,
    clients: _clients.size,
    devices: Array.from(_clients.entries()).map(([id, c]) => ({
      deviceId: id,
      platform: c.platform,
      deviceName: c.deviceName,
      userId: c.userId,
      sessions: c.sessions.size,
    })),
  };
}

/**
 * Send a notification to a specific user across all their devices.
 */
function notifyUser(userId, title, body, data = {}) {
  const message = {
    type: 'notification',
    title,
    body,
    data,
    timestamp: Date.now(),
  };
  return _broadcastToUser(userId, message);
}

/**
 * Broadcast a message to all connected clients.
 */
function broadcast(message) {
  for (const deviceId of _clients.keys()) {
    _sendToClient(deviceId, message);
  }
}

module.exports = {
  attach,
  detach,
  getClientCount,
  getStatus,
  notifyUser,
  broadcast,
};
