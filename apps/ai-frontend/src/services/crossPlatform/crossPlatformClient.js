'use strict';

/**
 * crossPlatformClient.js — Cross-platform sync client for Web (Vue 3).
 *
 * Thin adapter over wsClientCore for the browser/Vue 3 environment.
 * Provides reactive state via Vue 3 composables.
 *
 * @module services/crossPlatform/crossPlatformClient
 */

import { reactive, computed, readonly } from 'vue';
import { createWsClientCore, ConnectionState, PLATFORMS, ServerMessageTypes } from './shared/wsClientCore';

// ── Device ID persistence (localStorage) ────────────────────────────

function _loadDeviceId() {
  try { return localStorage.getItem('khy_cross_platform_device_id'); } catch { return null; }
}

function _saveDeviceId(id) {
  try { localStorage.setItem('khy_cross_platform_device_id', id); } catch { /* ignore */ }
}

// ── Vue 3 composable ────────────────────────────────────────────────

export function useCrossPlatform() {
  // Reactive state
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
    getPlatform: () => PLATFORMS.WEB,
    loadDeviceId: _loadDeviceId,
    persistDeviceId: _saveDeviceId,
    getToken: _getToken,
    getCapabilities: () => ({
      text: true,
      fileRead: true,
      fileWrite: false,
      commandExecution: false,
      notifications: true,
    }),
    getDeviceName: () => `Web (${navigator.userAgent?.slice(0, 30) || 'browser'})`,
    onStateChange: (s) => { state.connectionState = s; },
    onAuthenticated: (msg) => { state.userId = msg.userId; },
    onAuthError: (err) => { state.lastError = err; },
    onDisconnected: () => { /* handled by state */ },
    onSessionUpdated: (msg) => {
      state.sessions[msg.sessionId] = {
        state: msg.state,
        version: msg.version,
        modifiedBy: msg.modifiedBy,
        timestamp: msg.timestamp,
      };
    },
    onSessionJoined: () => { /* no-op for web */ },
    onMessage: () => { /* no-op for web */ },
    onCommand: () => { /* no-op for web */ },
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

  // Computed getters
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
    // State (readonly)
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
    // Actions
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
    // Helpers
    markNotificationRead,
    clearNotifications,
  };
}

export { ConnectionState, PLATFORMS, ServerMessageTypes };
