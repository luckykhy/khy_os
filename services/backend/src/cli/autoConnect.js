'use strict';

/**
 * autoConnect.js — Auto-connect terminal client for cross-platform sync.
 *
 * Non-intrusive wrapper that:
 * 1. Auto-connects terminal client on `khy` startup
 * 2. Listens for presence/notification/message events
 * 3. Surfaces events via console output (can be wired to status line later)
 *
 * Usage: require this file before starting REPL
 */

const { createTerminalClient } = require('../../services/crossPlatform/clients/terminalClient');
const { AI_BACKEND_DEFAULT_URL } = require('../../constants/serviceDefaults');

let _client = null;
let _handlers = {};

function init() {
  if (_client) return _client;

  const backendUrl = process.env.KHY_BACKEND_URL || AI_BACKEND_DEFAULT_URL;
  const wsUrl = backendUrl.replace(/^http/, 'ws') + '/ws/cross-platform';

  _client = createTerminalClient({
    url: wsUrl,
    token: process.env.KHY_AUTH_TOKEN,
    autoReconnect: true,
  });

  // Auto-connect (non-blocking)
  _client.connect();

  // Wire up event handlers
  _handlers.authenticated = (msg) => {
    console.log(`[跨设备] 已连接 · 用户: ${msg.userId} · 平台: ${Object.keys(msg.platforms).join(', ')}`);
  };

  _handlers.presence = (devices) => {
    const others = devices.filter(d => d.deviceId !== _client.deviceId);
    if (others.length > 0) {
      console.log(`[跨设备] ${others.length} 台设备在线: ${others.map(d => `${d.platform}(${d.deviceId.slice(0, 8)})`).join(', ')}`);
    }
  };

  _handlers.notification = (msg) => {
    console.log(`[跨设备通知] ${msg.title}: ${msg.body}`);
  };

  _handlers.message = (msg) => {
    console.log(`[跨设备消息] ${msg.fromPlatform}(${msg.fromDeviceId.slice(0, 8)}): ${msg.payload.text || JSON.stringify(msg.payload)}`);
  };

  _handlers.error = (err) => {
    console.warn(`[跨设备错误] ${err.message || err}`);
  };

  _handlers.disconnected = () => {
    console.log('[跨设备] 连接已断开，尝试重连...');
  };

  // Attach handlers
  Object.entries(_handlers).forEach(([event, handler]) => {
    _client.on(event, handler);
  });

  return _client;
}

function getClient() {
  return _client;
}

function destroy() {
  if (_client) {
    Object.entries(_handlers).forEach(([event, handler]) => {
      _client.off(event, handler);
    });
    _client.disconnect();
    _client = null;
  }
  _handlers = {};
}

module.exports = { init, getClient, destroy };
