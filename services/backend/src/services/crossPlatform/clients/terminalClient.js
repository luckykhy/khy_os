'use strict';

/**
 * terminalClient.js — Terminal-platform client for cross-platform sync.
 *
 * Wraps createWsClientCore with a terminal adapter (EventEmitter-based):
 * - bridges core adapter callbacks to named events (authenticated,
 *   auth:error, device:list, presence, message, notification, error,
 *   disconnected, state:change)
 * - persists the terminal device ID under the khyquant data home
 * - re-exports the full core public API (connect/disconnect/sessions/...)
 *
 * Used by CLI handlers (khy cross ...) and cli/autoConnect.js.
 *
 * @module services/crossPlatform/clients/terminalClient
 */

const { EventEmitter } = require('events');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { createWsClientCore, ConnectionState, PLATFORMS } = require('../wsClientCore');

const DEVICE_ID_FILE = () => {
  try {
    const { getDataHome } = require('../../../utils/dataHome');
    return path.join(getDataHome(), 'terminal-device-id');
  } catch {
    // Fall back to user home if data home is unavailable
    return path.join(os.homedir(), '.khyquant', 'terminal-device-id');
  }
};

function createTerminalClient(config = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const url = config.url || null;
  const token = config.token || null;

  const adapter = {
    getPlatform: () => PLATFORMS.TERMINAL,
    getDeviceName: () => 'khy terminal',
    getCapabilities: () => ({ text: true, terminal: true, commands: true }),

    loadDeviceId() {
      try {
        return fs.readFileSync(DEVICE_ID_FILE(), 'utf8').trim() || null;
      } catch { return null; }
    },

    persistDeviceId(id) {
      try {
        fs.mkdirSync(path.dirname(DEVICE_ID_FILE()), { recursive: true });
        fs.writeFileSync(DEVICE_ID_FILE(), id, 'utf8');
      } catch { /* non-fatal: device ID regenerates next run */ }
    },

    getToken: () => token,

    onStateChange: (state) => emitter.emit('state:change', state),
    onAuthenticated: (msg) => emitter.emit('authenticated', msg),
    onAuthError: (err) => emitter.emit('auth:error', err),
    onSessionUpdated: (msg) => emitter.emit('session:updated', msg),
    onSessionJoined: (msg) => emitter.emit('session:joined', msg),
    onMessage: (msg) => emitter.emit('message', msg),
    onCommand: (msg) => emitter.emit('command', msg),
    onPresence: (devices) => emitter.emit('presence', devices),
    onDeviceList: (devices) => emitter.emit('device:list', devices),
    onNotification: (msg) => emitter.emit('notification', msg),
    onError: (err) => emitter.emit('error', err),
    onDisconnected: (info) => emitter.emit('disconnected', info),
  };

  const core = createWsClientCore(adapter);

  function connect(overrideUrl, options = {}) {
    return core.connect(overrideUrl || url, {
      token,
      autoReconnect: options.autoReconnect !== undefined
        ? options.autoReconnect
        : config.autoReconnect,
    });
  }

  function disconnect() {
    return core.disconnect();
  }

  // Live property bridges (must be getters: state/deviceId change after connect)
  Object.defineProperties(emitter, {
    state: { get: () => core.state },
    deviceId: { get: () => core.deviceId },
    platform: { get: () => core.platform },
  });

  return Object.assign(emitter, {
    connect,
    disconnect,
    joinSession: core.joinSession,
    leaveSession: core.leaveSession,
    updateSession: core.updateSession,
    sendMessage: core.sendMessage,
    routeCommand: core.routeCommand,
    listDevices: core.listDevices,
    handoffSession: core.handoffSession,
    acceptHandoff: core.acceptHandoff,
    getConnectionState: core.getState,
    core, // exposed for tests/debugging; do not use in production code paths
  });
}

module.exports = {
  createTerminalClient,
  ConnectionState,
  PLATFORMS,
};
