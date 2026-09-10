'use strict';

/**
 * terminalClient.js 鈥?Cross-platform sync client for Terminal (CLI).
 *
 * Thin adapter over wsClientCore for the Node.js/CLI environment.
 *
 * @module services/crossPlatform/clients/terminalClient
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { createWsClientCore, ConnectionState, PLATFORMS } = require('../wsClientCore.cjs');

// 鈹€鈹€ Device ID persistence (filesystem) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function _getDeviceIdFilePath() {
  try {
    const { getDataHome } = require('../../utils/dataHome.cjs');
    return path.join(getDataHome(), 'sync', 'terminal-device-id.json');
  } catch { return null; }
}

const DEVICE_ID_FILE = _getDeviceIdFilePath();

function _loadDeviceId() {
  if (!DEVICE_ID_FILE) return null;
  try {
    if (fs.existsSync(DEVICE_ID_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICE_ID_FILE, 'utf-8')).deviceId;
    }
  } catch { /* ignore */ }
  return null;
}

function _saveDeviceId(id) {
  if (!DEVICE_ID_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DEVICE_ID_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_ID_FILE, JSON.stringify({ deviceId: id, createdAt: Date.now() }, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

// 鈹€鈹€ Terminal Client 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

class TerminalClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this._url = options.url || null;
    this._token = options.token || null;
    this._autoReconnect = options.autoReconnect !== false;

    const adapter = {
      getPlatform: () => PLATFORMS.TERMINAL,
      loadDeviceId: _loadDeviceId,
      persistDeviceId: _saveDeviceId,
      getCapabilities: () => ({
        text: true,
        fileRead: true,
        fileWrite: true,
        commandExecution: true,
        terminal: true,
      }),
      getDeviceName: () => `Terminal (${os.hostname()})`,
      onStateChange: (state) => this.emit('state', state),
      onAuthenticated: (msg) => this.emit('authenticated', msg),
      onAuthError: (err) => this.emit('auth:error', err),
      onDisconnected: (info) => this.emit('disconnected', info),
      onSessionUpdated: (msg) => this.emit('session:updated', msg),
      onSessionJoined: (msg) => this.emit('session:joined', msg),
      onMessage: (msg) => this.emit('message', msg),
      onCommand: (msg) => this.emit('command', msg),
      onPresence: (devices) => this.emit('presence', devices),
      onDeviceList: (devices) => this.emit('device:list', devices),
      onNotification: (msg) => this.emit('notification', msg),
      onError: (err) => this.emit('error', new Error(err)),
    };

    this._core = createWsClientCore(adapter);
  }

  get deviceId() { return this._core.deviceId; }
  get state() { return this._core.state; }
  get platform() { return this._core.platform; }

  connect(url) { this._core.connect(url || this._url, { token: this._token, autoReconnect: this._autoReconnect }); }
  disconnect() { this._core.disconnect(); }
  joinSession(sessionId) { this._core.joinSession(sessionId); }
  leaveSession(sessionId) { this._core.leaveSession(sessionId); }
  updateSession(sessionId, delta) { this._core.updateSession(sessionId, delta); }
  sendMessage(target) { this._core.sendMessage(target); }
  routeCommand(platform, cmd, payload) { this._core.routeCommand(platform, cmd, payload); }
  listDevices() { this._core.listDevices(); }
  handoffSession(sessionId, targetDeviceId, targetPlatform) { this._core.handoffSession(sessionId, targetDeviceId, targetPlatform); }
  acceptHandoff(sessionId) { this._core.acceptHandoff(sessionId); }
}

function createTerminalClient(options = {}) {
  return new TerminalClient(options);
}

module.exports = { TerminalClient, createTerminalClient };
