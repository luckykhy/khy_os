'use strict';

/**
 * crossPlatformNotifier.js — Cross-platform notification delivery.
 *
 * Delivers notifications to all connected platforms simultaneously.
 * Platform-specific delivery:
 *   - Web: Element Plus ElMessage toast
 *   - Desktop: Electron Notification (OS native)
 *   - Mobile: Capacitor push notification (stub for now)
 *   - Terminal: console.log / status line
 *
 * @module services/crossPlatform/notifier
 */

const { EventEmitter } = require('events');

let _instance = null;

class CrossPlatformNotifier extends EventEmitter {
  constructor() {
    super();
    this._hub = null;
    this._syncServer = null;
  }

  static getInstance() {
    if (!_instance) {
      _instance = new CrossPlatformNotifier();
    }
    return _instance;
  }

  initialize(hub, syncServer) {
    this._hub = hub;
    this._syncServer = syncServer;
  }

  /**
   * Send a cross-platform notification to a user.
   * @param {string} userId - Target user ID
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} [data] - Additional payload
   */
  notifyUser(userId, title, body, data = {}) {
    if (!this._syncServer) return 0;
    return this._syncServer.notifyUser(userId, title, body, data);
  }

  /**
   * Broadcast a notification to all connected clients.
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} [data] - Additional payload
   */
  broadcast(title, body, data = {}) {
    if (!this._syncServer) return;
    this._syncServer.broadcast({ type: 'notification', title, body, data, timestamp: Date.now() });
  }

  /**
   * Notify a specific platform.
   * @param {string} platform - Platform identifier (terminal/web/desktop/mobile)
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   * @param {object} [data] - Additional payload
   */
  notifyPlatform(platform, title, body, data = {}) {
    if (!this._hub) return;
    
    const message = {
      type: 'notification',
      title,
      body,
      data,
      timestamp: Date.now(),
    };

    const devices = this._hub.listDevices({ platform, connectedOnly: true });
    for (const device of devices) {
      this._hub.sendToDevice(device.deviceId, message);
    }
  }
}

const notifier = CrossPlatformNotifier.getInstance();

module.exports = { notifier, CrossPlatformNotifier };
