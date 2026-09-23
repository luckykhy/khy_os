/**
 * wsClientCore.js — Cross-platform sync WebSocket client core.
 *
 * Platform-agnostic WebSocket client for the cross-platform sync server.
 * Used by crossPlatformClient.js (Web/Vue 3 adapter) and can be reused by
 * other platform adapters (desktop, mobile, terminal).
 *
 * @module services/crossPlatform/shared/wsClientCore
 */

import { resolveWsUrl } from '@/utils/ws';
// Wire-format constants come from protocol.cjs — the single source of truth
// shared by all four platforms (see its header). Importing them instead of
// re-declaring the enum locally is what stops the handshake from drifting: this
// module used to send the literal 'auth:request', a type that is NOT in
// ClientMessageTypes and has no case in syncServer's message switch, so the
// server answered "Unknown message type" and the client sat in AUTHENTICATING
// until its 10s timeout, tore the socket down and reconnected — forever.
import { ClientMessageTypes } from './protocol.cjs';

// ── Enums ──────────────────────────────────────────────────────────────

export const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

export const PLATFORMS = Object.freeze({
  TERMINAL: 'terminal',
  WEB: 'web',
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

export const ServerMessageTypes = Object.freeze({
  HELLO: 'hello',
  AUTH_OK: 'auth:ok',
  AUTH_ERROR: 'auth:error',
  PONG: 'pong',
  SESSION_UPDATED: 'session:updated',
  SESSION_JOINED: 'session:joined',
  MESSAGE: 'message',
  COMMAND: 'command',
  PRESENCE: 'presence',
  DEVICE_LIST: 'device:list',
  NOTIFICATION: 'notification',
  ERROR: 'error',
});

// ── Constants ──────────────────────────────────────────────────────────

const WS_PATH = '/ws/cross-platform';
const RECONNECT_DELAY_BASE = 1000;
const RECONNECT_DELAY_MAX = 30000;
const HEARTBEAT_INTERVAL = 25000;
const AUTH_TIMEOUT_MS = 10000;

// ── Client factory ─────────────────────────────────────────────────────

export function createWsClientCore(adapter) {
  let ws = null;
  let reconnectAttempts = 0;
  let heartbeatTimer = null;
  let authTimeout = null;
  let shouldReconnect = true;
  let pendingQueue = [];

  // ── State change ─────────────────────────────────────────────────────

  function setState(state) {
    adapter.onStateChange(state);
  }

  // ── Message handling ─────────────────────────────────────────────────

  function handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case ServerMessageTypes.HELLO:
        handleHello(msg);
        break;
      case ServerMessageTypes.AUTH_OK:
        handleAuthOk(msg);
        break;
      case ServerMessageTypes.AUTH_ERROR:
        handleAuthError(msg);
        break;
      case ServerMessageTypes.PONG:
        // Heartbeat response — no action needed
        break;
      case ServerMessageTypes.SESSION_UPDATED:
        adapter.onSessionUpdated(msg);
        break;
      case ServerMessageTypes.SESSION_JOINED:
        adapter.onSessionJoined(msg);
        break;
      case ServerMessageTypes.MESSAGE:
        adapter.onMessage(msg);
        break;
      case ServerMessageTypes.COMMAND:
        adapter.onCommand(msg);
        break;
      case ServerMessageTypes.PRESENCE:
        adapter.onPresence(msg.devices);
        break;
      case ServerMessageTypes.DEVICE_LIST:
        adapter.onDeviceList(msg.devices);
        break;
      case ServerMessageTypes.NOTIFICATION:
        adapter.onNotification(msg);
        break;
      case ServerMessageTypes.ERROR:
        adapter.onError(msg.error || msg.message || 'Unknown error');
        break;
      default:
        break;
    }
  }

  function handleHello(msg) {
    // Server sent hello — request auth
    const token = adapter.getToken();
    if (!token) {
      setState(ConnectionState.DISCONNECTED);
      return;
    }
    setState(ConnectionState.AUTHENTICATING);
    clearAuthTimeout();
    authTimeout = setTimeout(() => {
      if (getState() === ConnectionState.AUTHENTICATING) {
        setState(ConnectionState.ERROR);
        disconnectInternal();
      }
    }, AUTH_TIMEOUT_MS);

    send({
      type: ClientMessageTypes.AUTH,
      token: token,
      deviceId: adapter.loadDeviceId(),
      platform: adapter.getPlatform(),
      deviceName: adapter.getDeviceName(),
      capabilities: adapter.getCapabilities(),
    });
  }

  function handleAuthOk(msg) {
    clearAuthTimeout();
    setState(ConnectionState.CONNECTED);
    reconnectAttempts = 0;
    adapter.onAuthenticated(msg);
    startHeartbeat();
    processPendingQueue();
  }

  function handleAuthError(msg) {
    clearAuthTimeout();
    setState(ConnectionState.ERROR);
    adapter.onAuthError(msg.error || msg.message || 'Authentication failed');
    disconnectInternal();
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────────

  function connect() {
    if (ws) return;
    shouldReconnect = true;
    reconnectAttempts = 0;
    connectInternal();
  }

  function connectInternal() {
    setState(ConnectionState.CONNECTING);
    const url = resolveWsUrl(WS_PATH);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      setState(ConnectionState.ERROR);
      adapter.onError(`WebSocket creation failed: ${err.message}`);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      handleMessage(event.data);
    };

    ws.onerror = (event) => {
      adapter.onError(`WebSocket error: ${event.message || 'unknown'}`);
    };

    ws.onclose = (event) => {
      ws = null;
      stopHeartbeat();
      clearAuthTimeout();

      if (!shouldReconnect) {
        setState(ConnectionState.DISCONNECTED);
        adapter.onDisconnected();
        return;
      }

      setState(ConnectionState.RECONNECTING);
      adapter.onDisconnected();
      scheduleReconnect();
    };
  }

  function disconnect() {
    shouldReconnect = false;
    disconnectInternal();
  }

  function disconnectInternal() {
    stopHeartbeat();
    clearAuthTimeout();
    if (ws) {
      try {
        ws.close(1000, 'Client disconnect');
      } catch { /* ignore */ }
      ws = null;
    }
    setState(ConnectionState.DISCONNECTED);
    adapter.onDisconnected();
  }

  function getState() {
    if (!ws) return ConnectionState.DISCONNECTED;
    if (ws.readyState === WebSocket.CONNECTING) return ConnectionState.CONNECTING;
    if (ws.readyState === WebSocket.OPEN) return ConnectionState.CONNECTED;
    return ConnectionState.DISCONNECTED;
  }

  // ── Reconnection ─────────────────────────────────────────────────────

  function scheduleReconnect() {
    if (!shouldReconnect) return;
    reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_DELAY_BASE * Math.pow(1.5, reconnectAttempts - 1),
      RECONNECT_DELAY_MAX
    );
    setTimeout(connectInternal, delay);
  }

  // ── Heartbeat ────────────────────────────────────────────────────────

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        send({ type: 'ping' });
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // ── Auth timeout ─────────────────────────────────────────────────────

  function clearAuthTimeout() {
    if (authTimeout) {
      clearTimeout(authTimeout);
      authTimeout = null;
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    // Queue for later
    pendingQueue.push(payload);
    return false;
  }

  function processPendingQueue() {
    while (pendingQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      const payload = pendingQueue.shift();
      ws.send(JSON.stringify(payload));
    }
  }

  // ── API methods ──────────────────────────────────────────────────────

  return {
    connect,
    disconnect,

    joinSession: (sessionId, options = {}) =>
      send({
        type: 'session:join',
        sessionId,
        ...options,
      }),

    leaveSession: (sessionId) =>
      send({
        type: 'session:leave',
        sessionId,
      }),

    updateSession: (sessionId, state, modifiedBy) =>
      send({
        type: 'session:update',
        sessionId,
        state,
        modifiedBy,
      }),

    sendMessage: (target, content, options = {}) =>
      send({
        type: 'message:send',
        target,
        content,
        ...options,
      }),

    routeCommand: (target, command, params = {}) =>
      send({
        type: 'command:route',
        target,
        command,
        params,
      }),

    listDevices: () =>
      send({
        type: 'device:list:request',
      }),

    handoffSession: (sessionId, targetDevice) =>
      send({
        type: 'session:handoff',
        sessionId,
        targetDevice,
      }),

    acceptHandoff: (sessionId) =>
      send({
        type: 'session:handoff:accept',
        sessionId,
      }),
  };
}
