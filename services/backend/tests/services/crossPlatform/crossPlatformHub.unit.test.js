'use strict';

/**
 * crossPlatformHub.unit.test.js — Unit tests for the CrossPlatformHub message bus.
 *
 * Covers: lifecycle, device registry, session sync, message routing, notifications,
 * status reporting, and stale eviction. The hub is a singleton, so each test
 * re-injects a fresh instance via the class directly.
 */

const { EventEmitter } = require('events');
const { CrossPlatformHub, PLATFORMS, PRIORITY } = require('../../../src/services/crossPlatform/crossPlatformHub');

describe('CrossPlatformHub', () => {
  let hub;

  beforeEach(() => {
    // Build a fresh instance each test (avoid singleton cross-contamination).
    hub = new CrossPlatformHub();
  });

  afterEach(() => {
    hub.stop();
    hub.removeAllListeners();
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  describe('lifecycle', () => {
    test('starts in stopped state', () => {
      expect(hub.getStatus().started).toBe(false);
    });

    test('start() flips _started and emits hub:started', () => {
      const started = jest.fn();
      hub.on('hub:started', started);
      hub.start();
      expect(hub.getStatus().started).toBe(true);
      expect(started).toHaveBeenCalledTimes(1);
    });

    test('start() is idempotent — second call is a no-op', () => {
      hub.start();
      const spy = jest.fn();
      hub.on('hub:started', spy);
      hub.start();
      expect(spy).not.toHaveBeenCalled();
    });

    test('stop() clears all state and emits hub:stopped', () => {
      hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
      hub.registerSession('s1', {});
      hub.start();

      const stopped = jest.fn();
      hub.on('hub:stopped', stopped);
      hub.stop();

      expect(hub.getStatus().started).toBe(false);
      expect(hub.getStatus().totalDevices).toBe(0);
      expect(hub.getStatus().totalSessions).toBe(0);
      expect(stopped).toHaveBeenCalledTimes(1);
    });

    test('stop() on a never-started hub is a no-op', () => {
      const spy = jest.fn();
      hub.on('hub:stopped', spy);
      hub.stop();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── PLATFORMS / PRIORITY constants ────────────────────────────────

  describe('constants', () => {
    test('PLATFORMS exposes the four platforms', () => {
      expect(PLATFORMS).toEqual({
        TERMINAL: 'terminal',
        WEB: 'web',
        DESKTOP: 'desktop',
        MOBILE: 'mobile',
      });
    });

    test('PRIORITY levels are ordered CRITICAL(0) < LOW(3)', () => {
      expect(PRIORITY.CRITICAL).toBe(0);
      expect(PRIORITY.HIGH).toBe(1);
      expect(PRIORITY.NORMAL).toBe(2);
      expect(PRIORITY.LOW).toBe(3);
    });
  });

  // ── Device Registry ──────────────────────────────────────────────

  describe('registerDevice', () => {
    test('registers a device with all required fields', () => {
      const device = hub.registerDevice({
        deviceId: 'd1',
        platform: 'web',
        userId: 'u1',
        deviceName: 'Chrome on MacBook',
      });
      expect(device.deviceId).toBe('d1');
      expect(device.platform).toBe('web');
      expect(device.userId).toBe('u1');
      expect(device.deviceName).toBe('Chrome on MacBook');
      expect(device.connected).toBe(true);
      expect(device.registeredAt).toBeGreaterThan(0);
    });

    test('throws when deviceId is missing', () => {
      expect(() => hub.registerDevice({ platform: 'web', userId: 'u1' })).toThrow(/deviceId and platform are required/);
    });

    test('throws when platform is missing', () => {
      expect(() => hub.registerDevice({ deviceId: 'd1', userId: 'u1' })).toThrow(/deviceId and platform are required/);
    });

    test('throws on unknown platform', () => {
      expect(() => hub.registerDevice({ deviceId: 'd1', platform: 'smart-fridge', userId: 'u1' })).toThrow(/unknown platform/);
    });

    test('defaults userId to anonymous when omitted', () => {
      const device = hub.registerDevice({ deviceId: 'd1', platform: 'terminal' });
      expect(device.userId).toBe('anonymous');
    });

    test('emits device:registered event', () => {
      const spy = jest.fn();
      hub.on('device:registered', spy);
      hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].deviceId).toBe('d1');
    });

    test('re-registering an existing device updates it (preserves registeredAt)', () => {
      const first = hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
      const originalRegisteredAt = first.registeredAt;

      // Advance time.
      jest.useFakeTimers();
      jest.advanceTimersByTime(1000);
      const second = hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1', deviceName: 'renamed' });
      jest.useRealTimers();

      expect(second.registeredAt).toBe(originalRegisteredAt);
      expect(second.platform).toBe('web');
      expect(second.deviceName).toBe('renamed');
    });
  });

  describe('unregisterDevice', () => {
    test('removes the device and emits device:unregistered', () => {
      hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1' });
      const spy = jest.fn();
      hub.on('device:unregistered', spy);

      hub.unregisterDevice('d1');
      expect(hub.getDevice('d1')).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('is a no-op for an unknown deviceId', () => {
      const spy = jest.fn();
      hub.on('device:unregistered', spy);
      hub.unregisterDevice('nonexistent');
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('touchDevice / updateDevice', () => {
    beforeEach(() => {
      hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
    });

    test('touchDevice updates lastSeen and connected', () => {
      const before = hub.getDevice('d1').lastSeen;
      jest.useFakeTimers();
      jest.advanceTimersByTime(5000);
      hub.touchDevice('d1');
      jest.useRealTimers();
      expect(hub.getDevice('d1').lastSeen).toBeGreaterThan(before);
      expect(hub.getDevice('d1').connected).toBe(true);
    });

    test('touchDevice on unknown device is a silent no-op', () => {
      expect(() => hub.touchDevice('ghost')).not.toThrow();
    });

    test('updateDevice merges capabilities and emits device:updated', () => {
      const spy = jest.fn();
      hub.on('device:updated', spy);
      const updated = hub.updateDevice('d1', { capabilities: { screen: true } });
      expect(updated.capabilities).toEqual({ screen: true });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('updateDevice returns null for unknown device', () => {
      expect(hub.updateDevice('ghost', { deviceName: 'x' })).toBeNull();
    });
  });

  describe('listDevices', () => {
    beforeEach(() => {
      hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd3', platform: 'mobile', userId: 'u2' });
    });

    test('returns all connected devices with no filter', () => {
      expect(hub.listDevices()).toHaveLength(3);
    });

    test('filters by userId', () => {
      const u1Devices = hub.listDevices({ userId: 'u1' });
      expect(u1Devices).toHaveLength(2);
      expect(u1Devices.every((d) => d.userId === 'u1')).toBe(true);
    });

    test('filters by platform', () => {
      const webDevices = hub.listDevices({ platform: 'web' });
      expect(webDevices).toHaveLength(1);
      expect(webDevices[0].deviceId).toBe('d1');
    });

    test('filters by connectedOnly', () => {
      hub.unregisterDevice('d1');
      const connected = hub.listDevices({ connectedOnly: true });
      expect(connected).toHaveLength(2);
      expect(connected.find((d) => d.deviceId === 'd1')).toBeUndefined();
    });
  });

  describe('getOnlineCount', () => {
    test('counts only connected devices for a user', () => {
      hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd3', platform: 'mobile', userId: 'u2' });
      expect(hub.getOnlineCount('u1')).toBe(2);
      hub.unregisterDevice('d1');
      expect(hub.getOnlineCount('u1')).toBe(1);
    });
  });

  // ── Session State Sync ────────────────────────────────────────────

  describe('sessions', () => {
    test('registerSession creates a session with version 1', () => {
      const session = hub.registerSession('s1', { platform: 'web', messages: [] });
      expect(session.sessionId).toBe('s1');
      expect(session.version).toBe(1);
      expect(session.state).toEqual({ platform: 'web', messages: [] });
    });

    test('getSession returns the session or null', () => {
      hub.registerSession('s1', {});
      expect(hub.getSession('s1')).not.toBeNull();
      expect(hub.getSession('ghost')).toBeNull();
    });

    test('updateSession merges delta and increments version', () => {
      hub.registerSession('s1', { messages: ['a'] });
      const updated = hub.updateSession('s1', { messages: ['a', 'b'] }, 'd1');
      expect(updated.version).toBe(2);
      expect(updated.state.messages).toEqual(['a', 'b']);
      expect(updated.modifiedBy).toBe('d1');
    });

    test('updateSession auto-registers unknown session', () => {
      const session = hub.updateSession('new-sess', { foo: 'bar' }, 'd1');
      expect(session.sessionId).toBe('new-sess');
      expect(session.version).toBe(1);
    });

    test('deleteSession removes the session', () => {
      hub.registerSession('s1', {});
      hub.deleteSession('s1');
      expect(hub.getSession('s1')).toBeNull();
    });
  });

  // ── Message Routing ──────────────────────────────────────────────

  describe('sendToDevice', () => {
    beforeEach(() => {
      hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'web', userId: 'u1' });
    });

    test('delivers to a connected device and emits message:deliver', () => {
      const spy = jest.fn();
      hub.on('message:deliver', spy);
      const ok = hub.sendToDevice('d2', { type: 'ping' });
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].targetDeviceId).toBe('d2');
    });

    test('queues for offline device and returns false', () => {
      hub.unregisterDevice('d2');
      const ok = hub.sendToDevice('d2', { type: 'ping' });
      expect(ok).toBe(false);
      expect(hub.getStatus().queuedMessages).toBe(1);
    });

    test('sendToPlatform delivers to all connected devices of that platform', () => {
      hub.registerDevice({ deviceId: 'd3', platform: 'terminal', userId: 'u2' });
      const spy = jest.fn();
      hub.on('message:deliver', spy);
      const count = hub.sendToPlatform('terminal', { type: 'broadcast' });
      expect(count).toBe(2); // d1 + d3
      expect(spy).toHaveBeenCalledTimes(2);
    });

    test('broadcastToUser delivers to all user devices except excluded', () => {
      const spy = jest.fn();
      hub.on('message:deliver', spy);
      const delivered = hub.broadcastToUser('u1', { type: 'note' }, PRIORITY.HIGH, 'd1');
      expect(delivered).toBe(1); // only d2 (d1 excluded)
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].envelope._meta.priority).toBe(PRIORITY.HIGH);
    });
  });

  // ── Subscriptions ────────────────────────────────────────────────

  describe('subscriptions', () => {
    test('subscribe / unsubscribe track event types per device', () => {
      hub.subscribe('d1', 'session:update');
      hub.subscribe('d1', 'presence');
      hub.unsubscribe('d1', 'session:update');
      // No public getter — verified indirectly via unsubscribe of a never-subscribed event.
      expect(() => hub.unsubscribe('d1', 'never')).not.toThrow();
    });
  });

  // ── Cross-Platform Commands ──────────────────────────────────────

  describe('routeCommand', () => {
    beforeEach(() => {
      hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'web', userId: 'u1' });
    });

    test('routes command to the first connected device on the target platform', () => {
      const result = hub.routeCommand({
        sourceDeviceId: 'd1',
        targetPlatform: 'web',
        command: 'open-session',
        payload: { sessionId: 's1' },
      });
      expect(result.targetDeviceId).toBe('d2');
      expect(result.commandId).toBeTruthy();
    });

    test('throws when source device is unknown', () => {
      expect(() =>
        hub.routeCommand({ sourceDeviceId: 'ghost', targetPlatform: 'web', command: 'x' })
      ).toThrow(/source device "ghost" not found/);
    });

    test('throws when no connected devices for target platform', () => {
      expect(() =>
        hub.routeCommand({ sourceDeviceId: 'd1', targetPlatform: 'mobile', command: 'x' })
      ).toThrow(/no connected devices for platform "mobile"/);
    });
  });

  // ── Notifications ────────────────────────────────────────────────

  describe('sendNotification', () => {
    beforeEach(() => {
      hub.registerDevice({ deviceId: 'd1', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'web', userId: 'u1' });
    });

    test('delivers notification to all user devices and emits notification:sent', () => {
      const spy = jest.fn();
      hub.on('notification:sent', spy);
      const delivered = hub.sendNotification({
        userId: 'u1',
        title: 'Test',
        body: 'Hello',
        type: 'info',
      });
      expect(delivered).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].title).toBe('Test');
    });
  });

  // ── Status & Diagnostics ─────────────────────────────────────────

  describe('getStatus', () => {
    test('returns a full status snapshot', () => {
      hub.registerDevice({ deviceId: 'd1', platform: 'web', userId: 'u1' });
      hub.registerDevice({ deviceId: 'd2', platform: 'terminal', userId: 'u2' });
      hub.registerSession('s1', {});
      hub.start();

      const status = hub.getStatus();
      expect(status.started).toBe(true);
      expect(status.totalDevices).toBe(2);
      expect(status.totalSessions).toBe(1);
      expect(status.platformCounts).toEqual({
        terminal: 1,
        web: 1,
        desktop: 0,
        mobile: 0,
      });
      expect(status.subscriptions).toEqual({});
    });
  });

  // ── Stale eviction ───────────────────────────────────────────────

  describe('_evictStaleDevices', () => {
    test('evicts devices older than 90s without heartbeat, keeps fresh ones', () => {
      jest.useFakeTimers();

      // Register both devices at the same time origin.
      hub.registerDevice({ deviceId: 'fresh', platform: 'terminal', userId: 'u1' });
      hub.registerDevice({ deviceId: 'stale', platform: 'web', userId: 'u1' });

      // Advance past the stale threshold.
      jest.advanceTimersByTime(91_000);

      // Keep 'fresh' alive with a heartbeat; leave 'stale' to time out.
      hub.touchDevice('fresh');

      hub._evictStaleDevices();

      jest.useRealTimers();

      expect(hub.getDevice('stale')).toBeNull();
      expect(hub.getDevice('fresh')).not.toBeNull();
    });
  });
});
