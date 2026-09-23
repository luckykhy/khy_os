'use strict';

/**
 * protocol.js — Cross-platform sync protocol constants and message builders.
 *
 * Single source of truth for ALL four platforms.
 * Located at: services/backend/src/services/crossPlatform/protocol.js
 * Other platforms access via NTFS junction: crossPlatform/shared/protocol.js
 *
 * @module services/crossPlatform/protocol
 */

// ── Message types (Client → Server) ─────────────────────────────────
const ClientMessageTypes = Object.freeze({
  AUTH: 'auth',
  PING: 'ping',
  SESSION_JOIN: 'session:join',
  SESSION_LEAVE: 'session:leave',
  SESSION_UPDATE: 'session:update',
  MESSAGE_SEND: 'message:send',
  COMMAND_ROUTE: 'command:route',
  DEVICE_LIST: 'device:list',
});

// ── Message types (Server → Client) ─────────────────────────────────
const ServerMessageTypes = Object.freeze({
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

// ── Platform identifiers ─────────────────────────────────────────────
const PLATFORMS = Object.freeze({
  TERMINAL: 'terminal',
  WEB: 'web',
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

// ── Connection states ────────────────────────────────────────────────
const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  AUTHENTICATING: 'authenticating',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

// ── Protocol version ────────────────────────────────────────────────
const PROTOCOL_VERSION = 1;

// ── Envelope builders ────────────────────────────────────────────────

function authMessage({ token, deviceId, platform, deviceName, userId, capabilities }) {
  return {
    type: ClientMessageTypes.AUTH,
    token,
    deviceId,
    platform,
    deviceName,
    userId,
    capabilities,
    protocol: PROTOCOL_VERSION,
    timestamp: Date.now(),
  };
}

function pingMessage() {
  return {
    type: ClientMessageTypes.PING,
    timestamp: Date.now(),
  };
}

function sessionJoinMessage(sessionId) {
  return {
    type: ClientMessageTypes.SESSION_JOIN,
    sessionId,
    timestamp: Date.now(),
  };
}

function sessionLeaveMessage(sessionId) {
  return {
    type: ClientMessageTypes.SESSION_LEAVE,
    sessionId,
    timestamp: Date.now(),
  };
}

function sessionUpdateMessage(sessionId, delta) {
  return {
    type: ClientMessageTypes.SESSION_UPDATE,
    sessionId,
    delta,
    timestamp: Date.now(),
  };
}

function messageSendMessage({ targetDeviceId, targetPlatform, payload }) {
  return {
    type: ClientMessageTypes.MESSAGE_SEND,
    targetDeviceId,
    targetPlatform,
    payload,
    timestamp: Date.now(),
  };
}

function commandRouteMessage({ targetPlatform, command, payload }) {
  return {
    type: ClientMessageTypes.COMMAND_ROUTE,
    targetPlatform,
    command,
    payload,
    timestamp: Date.now(),
  };
}

function deviceListMessage() {
  return {
    type: ClientMessageTypes.DEVICE_LIST,
    timestamp: Date.now(),
  };
}

// ── Message parser ──────────────────────────────────────────────────

function parseMessage(data) {
  let msg;
  try {
    msg = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return { type: 'error', error: 'Invalid JSON' };
  }
  if (!msg || !msg.type) {
    return { type: 'error', error: 'Missing message type' };
  }
  return msg;
}

function isServerMessage(msg) {
  return Object.values(ServerMessageTypes).includes(msg.type);
}

function isClientMessage(msg) {
  return Object.values(ClientMessageTypes).includes(msg.type);
}

module.exports = {
  ClientMessageTypes,
  ServerMessageTypes,
  PLATFORMS,
  ConnectionState,
  PROTOCOL_VERSION,
  authMessage,
  pingMessage,
  sessionJoinMessage,
  sessionLeaveMessage,
  sessionUpdateMessage,
  messageSendMessage,
  commandRouteMessage,
  deviceListMessage,
  parseMessage,
  isServerMessage,
  isClientMessage,
};
