'use strict';

/**
 * wsClientCore.js 鈥?Shared WebSocket client core for 4-platform sync.
 *
 * Single source of truth for connection lifecycle, heartbeat, message routing.
 * Located at: services/backend/src/services/crossPlatform/wsClientCore.js
 * Other platforms access via NTFS junction: crossPlatform/shared/wsClientCore.js
 *
 * Platform-specific adapters provide:
 * - loadDeviceId() / persistDeviceId(id)
 * - getPlatform() / getCapabilities() / getDeviceName()
 * - onStateChange / onAuthenticated / onSessionUpdated / onPresence / etc.
 * - resolveWsUrl() (optional, for mobile runtime discovery)
 *
 * @module services/crossPlatform/wsClientCore
 */

const {
  ClientMessageTypes,
  ServerMessageTypes,
  ConnectionState,
  PLATFORMS,
  authMessage,
  pingMessage,
  sessionJoinMessage,
  sessionLeaveMessage,
  sessionUpdateMessage,
  messageSendMessage,
  commandRouteMessage,
  deviceListMessage,
} = require('./protocol.cjs');

const DEFAULT_RECONNECT_INTERVAL_MS = 5000;
const MAX_RECONNECT_INTERVAL_MS = 60000;
const PING_INTERVAL_MS = 25000;

function createWsClientCore(adapter) {
  let _ws = null;
  let _state = ConnectionState.DISCONNECTED;
  let _deviceId = null;
  let _userId = null;
  let _token = null;
  let _url = null;
  let _autoReconnect = true;
  let _reconnectInterval = DEFAULT_RECONNECT_INTERVAL_MS;
  let _reconnectTimer = null;
  let _pingTimer = null;
  let _joinedSessions = new Set();

  const _devices = [];
  const _sessions = {};
  const _notifications = [];
  let _lastError = null;

  // 鈹€鈹€ Device ID 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function _generateDeviceId(platform) {
    const existing = adapter.loadDeviceId ? adapter.loadDeviceId() : null;
    if (existing) return existing;
    const prefix = platform || adapter.getPlatform();
    const uid = Math.random().toString(36).slice(2, 10);
    const id = `${prefix}-${Date.now()}-${uid}`;
    if (adapter.persistDeviceId) adapter.persistDeviceId(id);
    return id;
  }

  // 鈹€鈹€ Message builders 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function _buildAuthMessage() {
    return authMessage({
      token: _token,
      deviceId: _deviceId,
      platform: adapter.getPlatform(),
      deviceName: adapter.getDeviceName ? adapter.getDeviceName() : `${adapter.getPlatform()} device`,
      capabilities: adapter.getCapabilities ? adapter.getCapabilities() : {},
    });
  }

  // 鈹€鈹€ WebSocket handlers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function _onOpen() {
    _setState(ConnectionState.AUTHENTICATING);
    _send(_buildAuthMessage());
    _startPing();
  }

  function _onMessage(raw) {
    const data = typeof raw === 'string' ? raw : raw.toString();
    let msg;
    try {
      msg = JSON.parse(data);
    } catch { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case ServerMessageTypes.HELLO:
        _reconnectInterval = DEFAULT_RECONNECT_INTERVAL_MS;
        break;
      case ServerMessageTypes.AUTH_OK:
        _setState(ConnectionState.CONNECTED);
        _userId = msg.userId;
        for (const sessionId of _joinedSessions) {
          _send(sessionJoinMessage(sessionId));
        }
        if (adapter.onAuthenticated) adapter.onAuthenticated(msg);
        break;
      case ServerMessageTypes.AUTH_ERROR:
        _setState(ConnectionState.ERROR);
        _lastError = msg.error;
        if (adapter.onAuthError) adapter.onAuthError(msg.error);
        break;
      case ServerMessageTypes.PONG:
        break;
      case ServerMessageTypes.SESSION_UPDATED:
        _sessions[msg.sessionId] = {
          state: msg.state,
          version: msg.version,
          modifiedBy: msg.modifiedBy,
          timestamp: msg.timestamp,
        };
        if (adapter.onSessionUpdated) adapter.onSessionUpdated(msg);
        break;
      case ServerMessageTypes.SESSION_JOINED:
        if (adapter.onSessionJoined) adapter.onSessionJoined(msg);
        break;
      case ServerMessageTypes.MESSAGE:
        if (adapter.onMessage) adapter.onMessage(msg);
        break;
      case ServerMessageTypes.COMMAND:
        if (adapter.onCommand) adapter.onCommand(msg);
        break;
      case ServerMessageTypes.PRESENCE:
        _devices.length = 0;
        _devices.push(...(msg.devices || []));
        if (adapter.onPresence) adapter.onPresence(msg.devices);
        break;
      case ServerMessageTypes.DEVICE_LIST:
        _devices.length = 0;
        _devices.push(...(msg.devices || []));
        if (adapter.onDeviceList) adapter.onDeviceList(msg.devices);
        break;
      case ServerMessageTypes.NOTIFICATION:
        _notifications.unshift({
          ...msg,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          read: false,
        });
        if (adapter.onNotification) adapter.onNotification(msg);
        break;
      case ServerMessageTypes.ERROR:
        _lastError = msg.error;
        if (adapter.onError) adapter.onError(msg.error);
        break;
    }
  }

  function _onClose(event) {
    _clearTimers();
    _ws = null;
    _setState(ConnectionState.DISCONNECTED);
    if (_autoReconnect && event.code !== 1000) {
      _scheduleReconnect();
    }
    if (adapter.onDisconnected) adapter.onDisconnected({ code: event.code, reason: event.reason?.toString() });
  }

  function _onError(err) {
    _setState(ConnectionState.ERROR);
    if (adapter.onError) adapter.onError(err.message || String(err));
  }

  // 鈹€鈹€ Connection lifecycle 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function connect(url, options = {}) {
    if (url) _url = url;
    if (options.token) _token = options.token;
    else if (adapter.getToken) {
      const t = adapter.getToken();
      if (t) _token = t;
    }
    if (options.autoReconnect !== undefined) _autoReconnect = options.autoReconnect;

    if (!_url && adapter.resolveWsUrl) {
      return adapter.resolveWsUrl().then((resolvedUrl) => {
        if (resolvedUrl) {
          _url = resolvedUrl;
          _doConnect();
        } else {
          _setState(ConnectionState.ERROR);
          _lastError = 'No WebSocket URL resolved';
        }
      });
    }

    _doConnect();
  }

  function _doConnect() {
    if (!_url) {
      _setState(ConnectionState.ERROR);
      _lastError = 'No WebSocket URL configured';
      return;
    }

    _deviceId = _generateDeviceId();

    if (_ws) {
      try { _ws.close(1000, 'Reconnecting'); } catch { /* ignore */ }
    }

    _setState(ConnectionState.CONNECTING);

    try {
      _ws = new WebSocket(_url);
    } catch (err) {
      _setState(ConnectionState.ERROR);
      _lastError = err.message;
      if (_autoReconnect) _scheduleReconnect();
      return;
    }

    _ws.onopen = _onOpen;
    _ws.onmessage = (event) => _onMessage(event.data);
    _ws.onclose = _onClose;
    _ws.onerror = _onError;
  }

  function disconnect() {
    _autoReconnect = false;
    _clearTimers();
    if (_ws) {
      try { _ws.close(1000, 'Client disconnect'); } catch { /* ignore */ }
      _ws = null;
    }
    _setState(ConnectionState.DISCONNECTED);
  }

  // 鈹€鈹€ Public API 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function joinSession(sessionId) {
    _joinedSessions.add(sessionId);
    _send(sessionJoinMessage(sessionId));
  }

  function leaveSession(sessionId) {
    _joinedSessions.delete(sessionId);
    _send(sessionLeaveMessage(sessionId));
  }

  function updateSession(sessionId, delta) {
    _send(sessionUpdateMessage(sessionId, delta));
  }

  function sendMessage(target) {
    _send(messageSendMessage(target));
  }

  function routeCommand(targetPlatform, command, payload) {
    _send(commandRouteMessage({ targetPlatform, command, payload }));
  }

  function listDevices() {
    _send(_buildDeviceListMessage());
  }

  function handoffSession(sessionId, targetDeviceId, targetPlatform) {
    _send({
      type: 'session:handoff',
      sessionId,
      targetDeviceId,
      targetPlatform,
      timestamp: Date.now(),
    });
  }

  function acceptHandoff(sessionId) {
    _send({
      type: 'session:handoff:accept',
      sessionId,
      timestamp: Date.now(),
    });
  }

  function getState() {
    return {
      connectionState: _state,
      deviceId: _deviceId,
      userId: _userId,
      devices: [..._devices],
      sessions: { ..._sessions },
      notifications: [..._notifications],
      lastError: _lastError,
    };
  }

  // 鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  function _send(message) {
    if (!_ws || _ws.readyState !== 1) return false;
    try {
      _ws.send(JSON.stringify(message));
      return true;
    } catch { return false; }
  }

  function _setState(newState) {
    if (_state === newState) return;
    _state = newState;
    if (adapter.onStateChange) adapter.onStateChange(newState);
  }

  function _startPing() {
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(() => _send(pingMessage()), PING_INTERVAL_MS);
  }

  function _clearTimers() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
  }

  function _scheduleReconnect() {
    if (_reconnectTimer) return;
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      if (!_ws) {
        _setState(ConnectionState.RECONNECTING);
        _doConnect();
      }
    }, _reconnectInterval);
    _reconnectInterval = Math.min(_reconnectInterval * 2, MAX_RECONNECT_INTERVAL_MS);
  }

  return {
    connect, disconnect,
    joinSession, leaveSession, updateSession,
    sendMessage, routeCommand, listDevices,
    handoffSession, acceptHandoff,
    getState,
    get state() { return _state; },
    get deviceId() { return _deviceId; },
    get platform() { return adapter.getPlatform(); },
  };
}

module.exports = {
  createWsClientCore,
  ConnectionState,
  PLATFORMS,
  ServerMessageTypes,
  ClientMessageTypes,
};
