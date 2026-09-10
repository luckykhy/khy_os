'use strict';

/**
 * crossPlatformHub.js — Central message bus for 4-platform connectivity.
 *
 * Connects Terminal (CLI), Web (ai-frontend), Desktop (Electron), Mobile (Capacitor)
 * through a unified event + state synchronization layer.
 *
 * Architecture:
 *   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
 *   │   Terminal  │  │    Web      │  │   Desktop   │  │   Mobile    │
 *   │   (CLI)     │  │ (ai-front)  │  │  (Electron) │  │ (Capacitor) │
 *   └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
 *          │                │                │                │
 *          └────────────────┴────────┬───────┴────────────────┘
 *                                    │
 *                          ┌─────────▼─────────┐
 *                          │ crossPlatformHub  │
 *                          │  (message bus)    │
 *                          └─────────┬─────────┘
 *                                    │
 *              ┌─────────────────────┼─────────────────────┐
 *              │                     │                     │
 *     ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
 *     │  sessionSync    │  │   notifier      │  │  deviceManager  │
     │  (conversations) │  │ (notifications) │  │ (registry)      │
 *     └─────────────────┘  └─────────────────┘  └─────────────────┘
 *
 * Message types:
 *   - state:sync        : Push state delta to all connected platforms
 *   - session:update    : Conversation state changed
 *   - session:request   : Request conversation state from other platform
 *   - notification      : Cross-platform notification
 *   - command:route     : Route a command to another platform
 *   - presence          : Device online/offline status
 *
 * @module services/crossPlatform/crossPlatformHub
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── Platform identifiers ───────────────────────────────────────────────
const PLATFORMS = Object.freeze({
  TERMINAL: 'terminal',
  WEB: 'web',
  DESKTOP: 'desktop',
  MOBILE: 'mobile',
});

// ── Message priority levels ────────────────────────────────────────────
const PRIORITY = Object.freeze({
  CRITICAL: 0,   // Immediate delivery (security alerts, system errors)
  HIGH: 1,       // Urgent (session state changes, approval requests)
  NORMAL: 2,     // Standard (notifications, presence updates)
  LOW: 3,        // Background (analytics, telemetry)
});

// ── Singleton state ────────────────────────────────────────────────────
let _instance = null;

class CrossPlatformHub extends EventEmitter {
  constructor() {
    super();
    this._devices = new Map();      // deviceId → DeviceInfo
    this._sessions = new Map();     // sessionId → SessionState
    this._messageQueue = [];        // Pending messages for offline devices
    this._subscriptions = new Map(); // eventType → Set<deviceId>
    this._maxQueueSize = 1000;
    this._maxDevicesPerUser = 10;
    this._started = false;
    this._heartbeatInterval = null;
  }

  // ── Singleton accessor ─────────────────────────────────────────────

  static getInstance() {
    if (!_instance) {
      _instance = new CrossPlatformHub();
    }
    return _instance;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize the cross-platform hub.
   * Idempotent — safe to call multiple times.
   */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;

    // Heartbeat: detect stale device connections every 30s
    this._heartbeatInterval = setInterval(() => {
      this._evictStaleDevices();
    }, 30000);

    this.emit('hub:started');
  }

  /**
   * Stop the hub and clean up resources.
   */
  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;

    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }

    this._devices.clear();
    this._sessions.clear();
    this._messageQueue = [];
    this._subscriptions.clear();
    this.emit('hub:stopped');
  }

  // ── Device Registry ────────────────────────────────────────────────

  /**
   * Register a device connection.
   * @param {object} deviceInfo
   * @param {string} deviceInfo.deviceId - Unique device identifier
   * @param {string} deviceInfo.platform - One of PLATFORMS values
   * @param {string} deviceInfo.userId - User identifier
   * @param {string} [deviceInfo.deviceName] - Human-readable name
   * @param {string} [deviceInfo.clientId] - Bridge/WS client ID
   * @param {object} [deviceInfo.capabilities] - What this device can do
   * @returns {object} Registered device info
   */
  registerDevice(deviceInfo) {
    if (!deviceInfo || !deviceInfo.deviceId || !deviceInfo.platform) {
      throw new Error('registerDevice: deviceId and platform are required');
    }

    if (!Object.values(PLATFORMS).includes(deviceInfo.platform)) {
      throw new Error(`registerDevice: unknown platform "${deviceInfo.platform}"`);
    }

    const now = Date.now();
    const existing = this._devices.get(deviceInfo.deviceId);

    const device = {
      deviceId: deviceInfo.deviceId,
      platform: deviceInfo.platform,
      userId: deviceInfo.userId || 'anonymous',
      deviceName: deviceInfo.deviceName || existing?.deviceName || '',
      clientId: deviceInfo.clientId || existing?.clientId || '',
      capabilities: deviceInfo.capabilities || existing?.capabilities || {},
      registeredAt: existing?.registeredAt || now,
      lastSeen: now,
      connected: true,
    };

    this._devices.set(device.deviceId, device);

    // Deliver any queued messages for this device
    this._flushQueue(device.deviceId);

    // Broadcast presence update
    this._broadcastPresence();

    this.emit('device:registered', device);
    return device;
  }

  /**
   * Unregister a device connection.
   * @param {string} deviceId
   */
  unregisterDevice(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device) {
      return;
    }

    device.connected = false;
    this._devices.delete(deviceId);

    // Clean up subscriptions
    for (const [eventType, subscribers] of this._subscriptions) {
      subscribers.delete(deviceId);
    }

    this._broadcastPresence();
    this.emit('device:unregistered', device);
  }

  /**
   * Update device heartbeat (mark as still connected).
   * @param {string} deviceId
   */
  touchDevice(deviceId) {
    const device = this._devices.get(deviceId);
    if (device) {
      device.lastSeen = Date.now();
      device.connected = true;
    }
  }

  /**
   * Update device capabilities or metadata.
   * @param {string} deviceId
   * @param {object} updates
   */
  updateDevice(deviceId, updates) {
    const device = this._devices.get(deviceId);
    if (!device) {
      return null;
    }

    if (updates.deviceName !== undefined) {
      device.deviceName = updates.deviceName;
    }
    if (updates.capabilities !== undefined) {
      device.capabilities = { ...device.capabilities, ...updates.capabilities };
    }
    if (updates.clientId !== undefined) {
      device.clientId = updates.clientId;
    }

    device.lastSeen = Date.now();
    this.emit('device:updated', device);
    return device;
  }

  /**
   * Get a device by ID.
   * @param {string} deviceId
   */
  getDevice(deviceId) {
    return this._devices.get(deviceId) || null;
  }

  /**
   * List all connected devices, optionally filtered by user or platform.
   * @param {object} [filter]
   * @param {string} [filter.userId]
   * @param {string} [filter.platform]
   * @returns {Array<object>}
   */
  listDevices(filter = {}) {
    const devices = [];
    for (const device of this._devices.values()) {
      if (filter.userId && device.userId !== filter.userId) {
        continue;
      }
      if (filter.platform && device.platform !== filter.platform) {
        continue;
      }
      if (filter.connectedOnly && !device.connected) {
        continue;
      }
      devices.push({ ...device });
    }
    return devices;
  }

  /**
   * Get online device count for a user.
   * @param {string} userId
   */
  getOnlineCount(userId) {
    let count = 0;
    for (const device of this._devices.values()) {
      if (device.userId === userId && device.connected) {
        count++;
      }
    }
    return count;
  }

  // ── Session State Sync ─────────────────────────────────────────────

  /**
   * Register a session for cross-platform sync.
   * @param {string} sessionId
   * @param {object} state - Initial session state
   */
  registerSession(sessionId, state = {}) {
    const session = {
      sessionId,
      state: { ...state },
      lastModified: Date.now(),
      modifiedBy: state.platform || 'unknown',
      version: 1,
    };
    this._sessions.set(sessionId, session);
    this.emit('session:registered', { sessionId });
    return session;
  }

  /**
   * Update session state (delta sync).
   * @param {string} sessionId
   * @param {object} delta - State changes to merge
   * @param {string} sourceDeviceId - Which device made the change
   */
  updateSession(sessionId, delta, sourceDeviceId) {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = this.registerSession(sessionId, delta);
      session.modifiedBy = sourceDeviceId;
      return session;
    }

    session.state = { ...session.state, ...delta };
    session.lastModified = Date.now();
    session.modifiedBy = sourceDeviceId;
    session.version = (session.version || 0) + 1;

    // Broadcast to all devices subscribed to this session
    this._broadcastSessionUpdate(sessionId, session, sourceDeviceId);
    this.emit('session:updated', { sessionId, session, sourceDeviceId });
    return session;
  }

  /**
   * Get current session state.
   * @param {string} sessionId
   */
  getSession(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  /**
   * Delete a session.
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    this._sessions.delete(sessionId);
    this.emit('session:deleted', { sessionId });
  }

  // ── Message Routing ────────────────────────────────────────────────

  /**
   * Send a message to a specific device.
   * @param {string} targetDeviceId
   * @param {object} message
   * @param {number} [priority=PRIORITY.NORMAL]
   */
  sendToDevice(targetDeviceId, message, priority = PRIORITY.NORMAL) {
    const device = this._devices.get(targetDeviceId);
    if (!device || !device.connected) {
      // Queue for later delivery
      this._enqueueMessage(targetDeviceId, message, priority);
      return false;
    }

    const envelope = this._createEnvelope(message, priority, targetDeviceId);
    this.emit('message:deliver', { targetDeviceId, envelope });
    return true;
  }

  /**
   * Send a message to all devices of a specific platform.
   * @param {string} platform
   * @param {object} message
   * @param {number} [priority=PRIORITY.NORMAL]
   */
  sendToPlatform(platform, message, priority = PRIORITY.NORMAL) {
    const targets = this.listDevices({ platform, connectedOnly: true });
    for (const device of targets) {
      this.sendToDevice(device.deviceId, message, priority);
    }
    return targets.length;
  }

  /**
   * Broadcast a message to all connected devices for a user.
   * @param {string} userId
   * @param {object} message
   * @param {number} [priority=PRIORITY.NORMAL]
   * @param {string} [excludeDeviceId] - Optional device to exclude (sender)
   */
  broadcastToUser(userId, message, priority = PRIORITY.NORMAL, excludeDeviceId = null) {
    const targets = this.listDevices({ userId, connectedOnly: true });
    let delivered = 0;
    for (const device of targets) {
      if (device.deviceId === excludeDeviceId) {
        continue;
      }
      const ok = this.sendToDevice(device.deviceId, message, priority);
      if (ok) {
        delivered++;
      }
    }
    return delivered;
  }

  /**
   * Subscribe a device to an event type.
   * @param {string} deviceId
   * @param {string} eventType
   */
  subscribe(deviceId, eventType) {
    if (!this._subscriptions.has(eventType)) {
      this._subscriptions.set(eventType, new Set());
    }
    this._subscriptions.get(eventType).add(deviceId);
  }

  /**
   * Unsubscribe a device from an event type.
   * @param {string} deviceId
   * @param {string} eventType
   */
  unsubscribe(deviceId, eventType) {
    const subscribers = this._subscriptions.get(eventType);
    if (subscribers) {
      subscribers.delete(deviceId);
    }
  }

  // ── Cross-Platform Commands ────────────────────────────────────────

  /**
   * Route a command from one platform to another.
   * @param {object} route
   * @param {string} route.sourceDeviceId
   * @param {string} route.targetPlatform
   * @param {string} route.command
   * @param {object} [route.payload]
   * @param {function} [route.onResponse] - Callback for async responses
   */
  routeCommand(route) {
    const { sourceDeviceId, targetPlatform, command, payload = {} } = route;

    const sourceDevice = this._devices.get(sourceDeviceId);
    if (!sourceDevice) {
      throw new Error(`routeCommand: source device "${sourceDeviceId}" not found`);
    }

    const targets = this.listDevices({ platform: targetPlatform, connectedOnly: true });
    if (targets.length === 0) {
      throw new Error(`routeCommand: no connected devices for platform "${targetPlatform}"`);
    }

    const commandId = crypto.randomBytes(8).toString('hex');
    const message = {
      type: 'command:route',
      commandId,
      sourcePlatform: sourceDevice.platform,
      sourceDeviceId,
      command,
      payload,
      timestamp: Date.now(),
    };

    // Send to first available target (could be extended to load-balance)
    const target = targets[0];
    this.sendToDevice(target.deviceId, message, PRIORITY.HIGH);

    this.emit('command:routed', { commandId, sourceDeviceId, targetDeviceId: target.deviceId, command });
    return { commandId, targetDeviceId: target.deviceId };
  }

  // ── Notifications ──────────────────────────────────────────────────

  /**
   * Send a cross-platform notification.
   * @param {object} notification
   * @param {string} notification.userId - Target user
   * @param {string} notification.title
   * @param {string} notification.body
   * @param {string} [notification.type='info'] - info | warning | error | success
   * @param {string} [notification.sourcePlatform] - Which platform originated
   * @param {object} [notification.data] - Additional payload
   * @param {string} [excludeDeviceId] - Device to exclude (originator)
   */
  sendNotification(notification) {
    const {
      userId,
      title,
      body,
      type = 'info',
      sourcePlatform = 'system',
      data = {},
    } = notification;

    const message = {
      type: 'notification',
      title,
      body,
      notificationType: type,
      sourcePlatform,
      data,
      timestamp: Date.now(),
    };

    const delivered = this.broadcastToUser(userId, message, PRIORITY.NORMAL);
    this.emit('notification:sent', { userId, title, delivered });
    return delivered;
  }

  // ── Status & Diagnostics ───────────────────────────────────────────

  /**
   * Get hub status snapshot.
   */
  getStatus() {
    const platformCounts = {};
    for (const platform of Object.values(PLATFORMS)) {
      platformCounts[platform] = this.listDevices({ platform, connectedOnly: true }).length;
    }

    return {
      started: this._started,
      totalDevices: this._devices.size,
      totalSessions: this._sessions.size,
      queuedMessages: this._messageQueue.length,
      platformCounts,
      subscriptions: Object.fromEntries(
        [...this._subscriptions.entries()].map(([k, v]) => [k, v.size])
      ),
    };
  }

  // ── Private Helpers ────────────────────────────────────────────────

  _createEnvelope(message, priority, targetDeviceId) {
    return {
      ...message,
      _meta: {
        priority,
        targetDeviceId,
        messageId: crypto.randomBytes(8).toString('hex'),
        timestamp: Date.now(),
      },
    };
  }

  _enqueueMessage(deviceId, message, priority) {
    if (this._messageQueue.length >= this._maxQueueSize) {
      // Drop oldest low-priority message
      const lowIdx = this._messageQueue.findIndex((m) => m.priority >= PRIORITY.LOW);
      if (lowIdx >= 0) {
        this._messageQueue.splice(lowIdx, 1);
      } else {
        return; // Queue full of high-priority, drop new message
      }
    }
    this._messageQueue.push({ deviceId, message, priority, enqueuedAt: Date.now() });
  }

  _flushQueue(deviceId) {
    const remaining = [];
    for (const item of this._messageQueue) {
      if (item.deviceId === deviceId) {
        const device = this._devices.get(deviceId);
        if (device && device.connected) {
          const envelope = this._createEnvelope(item.message, item.priority, deviceId);
          this.emit('message:deliver', { targetDeviceId: deviceId, envelope });
          continue;
        }
      }
      remaining.push(item);
    }
    this._messageQueue = remaining;
  }

  _broadcastPresence() {
    const message = {
      type: 'presence',
      devices: this.listDevices({ connectedOnly: true }).map((d) => ({
        deviceId: d.deviceId,
        platform: d.platform,
        deviceName: d.deviceName,
        userId: d.userId,
      })),
    };
    this.emit('presence:broadcast', message);
  }

  _broadcastSessionUpdate(sessionId, session, sourceDeviceId) {
    const message = {
      type: 'session:update',
      sessionId,
      state: session.state,
      version: session.version,
      modifiedBy: session.modifiedBy,
      timestamp: session.lastModified,
    };

    // Broadcast to all devices that share the session's user
    const sourceDevice = this._devices.get(sourceDeviceId);
    if (sourceDevice) {
      this.broadcastToUser(sourceDevice.userId, message, PRIORITY.HIGH, sourceDeviceId);
    }
  }

  _evictStaleDevices() {
    const STALE_THRESHOLD = 90_000; // 90 seconds without heartbeat
    const now = Date.now();
    const staleDevices = [];

    for (const [deviceId, device] of this._devices) {
      if (now - device.lastSeen > STALE_THRESHOLD) {
        staleDevices.push(deviceId);
      }
    }

    for (const deviceId of staleDevices) {
      this.unregisterDevice(deviceId);
    }
  }
}

// ── Module exports ────────────────────────────────────────────────────

const hub = CrossPlatformHub.getInstance();

module.exports = {
  hub,
  CrossPlatformHub,
  PLATFORMS,
  PRIORITY,
};
