/**
 * crossPlatformClient.js — Cross-platform sync client for Mobile (Capacitor).
 *
 * Thin adapter over wsClientCore for the Capacitor WebView environment.
 * Uses runtime config from api/runtime.js for WebSocket URL discovery.
 *
 * @module api/crossPlatform/crossPlatformClient
 */

import { reactive, computed, readonly } from 'vue';
import { createWsClientCore, ConnectionState, PLATFORMS, ServerMessageTypes } from './shared/wsClientCore.cjs';

// ── Device ID persistence (localStorage) ────────────────────────────

function _loadDeviceId() {
  try { return localStorage.getItem('khy_cross_platform_device_id'); } catch { return null; }
}

function _saveDeviceId(id) {
  try { localStorage.setItem('khy_cross_platform_device_id', id); } catch { /* ignore */ }
}

// ── Runtime config integration ──────────────────────────────────────

async function _resolveWsUrl() {
  try {
    const { getRuntime } = await import('../runtime');
    const runtime = getRuntime();
    if (runtime?.wsUrl) return runtime.wsUrl;
    if (runtime?.managementWsUrl) return runtime.managementWsUrl;
    if (runtime?.apiBaseUrl) {
      const url = new URL(runtime.apiBaseUrl);
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${url.host}/ws/cross-platform`;
    }
  } catch { /* runtime not available */ }
  return null;
}

// ── Vue 3 composable ────────────────────────────────────────────────

export function useCrossPlatform() {
  const state = reactive({
    connectionState: ConnectionState.DISCONNECTED,
    deviceId: null,
    userId: null,
    devices: [],
    sessions: {},
    notifications: [],
    lastError: null,
  });

  function _getToken() {
    try { return localStorage.getItem('token') || null; } catch { return null; }
  }

  const adapter = {
    getPlatform: () => PLATFORMS.MOBILE,
    loadDeviceId: _loadDeviceId,
    persistDeviceId: _saveDeviceId,
    getToken: _getToken,
    getCapabilities: () => ({
      text: true,
      fileRead: false,
      fileWrite: false,
      commandExecution: false,
      notifications: true,
      voice: true,
      camera: true,
    }),
    getDeviceName: () => `Mobile (${navigator.userAgent?.slice(0, 30) || 'device'})`,
    resolveWsUrl: _resolveWsUrl,
    onStateChange: (s) => { state.connectionState = s; },
    onAuthenticated: (msg) => { state.userId = msg.userId; },
    onAuthError: (err) => { state.lastError = err; },
    onSessionUpdated: (msg) => {
      state.sessions[msg.sessionId] = {
        state: msg.state,
        version: msg.version,
        modifiedBy: msg.modifiedBy,
        timestamp: msg.timestamp,
      };
    },
    onPresence: (devices) => { state.devices = devices || []; },
    onDeviceList: (devices) => { state.devices = devices || []; },
    onNotification: (msg) => {
      state.notifications.unshift({
        ...msg,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        read: false,
      });
    },
    onError: (err) => { state.lastError = err; },
  };

  const core = createWsClientCore(adapter);

  const isConnected = computed(() => state.connectionState === ConnectionState.CONNECTED);
  const isConnecting = computed(() => state.connectionState === ConnectionState.CONNECTING);
  const onlineDevices = computed(() => state.devices);
  const terminalDevices = computed(() => state.devices.filter(d => d.platform === PLATFORMS.TERMINAL));
  const webDevices = computed(() => state.devices.filter(d => d.platform === PLATFORMS.WEB));
  const desktopDevices = computed(() => state.devices.filter(d => d.platform === PLATFORMS.DESKTOP));
  const mobileDevices = computed(() => state.devices.filter(d => d.platform === PLATFORMS.MOBILE));
  const sessionStates = computed(() => state.sessions);
  const unreadNotifications = computed(() => state.notifications.filter(n => !n.read));

  function markNotificationRead(id) {
    const n = state.notifications.find(x => x.id === id);
    if (n) n.read = true;
  }

  function clearNotifications() {
    state.notifications = [];
  }

  return {
    connectionState: readonly(state).connectionState,
    deviceId: readonly(state).deviceId,
    userId: readonly(state).userId,
    isConnected,
    isConnecting,
    onlineDevices,
    terminalDevices,
    webDevices,
    desktopDevices,
    mobileDevices,
    sessionStates,
    notifications: readonly(state).notifications,
    unreadNotifications,
    lastError: readonly(state).lastError,
    connect: core.connect,
    disconnect: core.disconnect,
    joinSession: core.joinSession,
    leaveSession: core.leaveSession,
    updateSession: core.updateSession,
    sendMessage: core.sendMessage,
    routeCommand: core.routeCommand,
    listDevices: core.listDevices,
    handoffSession: core.handoffSession,
    acceptHandoff: core.acceptHandoff,
    markNotificationRead,
    clearNotifications,
  };
}

export { ConnectionState, PLATFORMS, ServerMessageTypes };
