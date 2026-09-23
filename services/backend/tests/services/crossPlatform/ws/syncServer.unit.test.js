'use strict';

/**
 * syncServer.unit.test.js — Unit tests for the cross-platform WebSocket sync server.
 *
 * Mocks the `ws` module so the server's attach/detach, client registration,
 * message dispatch, notify, broadcast, and status paths can be exercised without
 * real sockets. Persistence (disk I/O) is suppressed by mocking dataHome.
 */

// ── Mock dataHome so persistence doesn't touch the real filesystem ──
jest.mock('../../../../src/utils/dataHome', () => ({
  getDataHome: jest.fn(() => require('os').tmpdir()),
}));

// ── Mock ws ─────────────────────────────────────────────────────────
jest.mock('ws', () => {
  const EventEmitter = require('events');

  class MockWS extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1; // OPEN
      this.isAlive = true;
      this.send = jest.fn();
      this.ping = jest.fn();
      this.close = jest.fn();
      this.terminate = jest.fn();
    }
  }

  class MockWSS extends EventEmitter {
    constructor() {
      super();
      this.clients = new Set();
    }
    close() {
      this.emit('close');
    }
  }

  return {
    Server: MockWSS,
    WebSocket: MockWS,
    OPEN: 1,
  };
});

describe('syncServer', () => {
  let mockHub;
  const { WebSocket: MockWS } = require('ws');

  beforeEach(() => {
    // Clean up module-level state from previous tests.
    const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
    try { syncServer.detach(); } catch { /* ignore */ }

    mockHub = {
      registerDevice: jest.fn(),
      unregisterDevice: jest.fn(),
      touchDevice: jest.fn(),
      updateDevice: jest.fn(),
      registerSession: jest.fn(),
      getSession: jest.fn(),
      updateSession: jest.fn(() => ({
        sessionId: 's1', state: {}, version: 1, modifiedBy: 'd1', lastModified: Date.now(),
      })),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      deleteSession: jest.fn(),
      listDevices: jest.fn(() => []),
      _sessions: new Map(),
    };
  });

  // ── attach / detach ──────────────────────────────────────────────

  describe('attach / detach', () => {
    test('attach registers a connection handler', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });
      expect(wss).toBeDefined();
      expect(wss.listenerCount('connection')).toBe(1);
      syncServer.detach();
    });

    test('attach is idempotent — second call returns undefined', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      syncServer.attach({}, { hub: mockHub });
      const second = syncServer.attach({}, { hub: mockHub });
      expect(second).toBeUndefined();
      syncServer.detach();
    });

    test('detach closes all clients and clears the server', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });
      const client = new MockWS();
      wss.clients.add(client);

      syncServer.detach();
      expect(client.close).toHaveBeenCalled();
    });

    test('after detach a fresh attach succeeds', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      syncServer.attach({}, { hub: mockHub });
      syncServer.detach();
      const wss2 = syncServer.attach({}, { hub: mockHub });
      expect(wss2).toBeDefined();
      syncServer.detach();
    });
  });

  // ── getStatus / getClientCount ──────────────────────────────────

  describe('status', () => {
    test('getStatus returns connected, clients, devices', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      syncServer.attach({}, { hub: mockHub });
      const status = syncServer.getStatus();
      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('clients');
      expect(status).toHaveProperty('devices');
      expect(typeof status.connected).toBe('boolean');
      expect(typeof status.clients).toBe('number');
      expect(Array.isArray(status.devices)).toBe(true);
      syncServer.detach();
    });

    test('getClientCount starts at 0', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      syncServer.attach({}, { hub: mockHub });
      expect(syncServer.getClientCount()).toBe(0);
      syncServer.detach();
    });

    test('connected is false before attach and true after', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      expect(syncServer.getStatus().connected).toBe(false);
      syncServer.attach({}, { hub: mockHub });
      expect(syncServer.getStatus().connected).toBe(true);
      syncServer.detach();
    });
  });

  // ── Connection lifecycle ─────────────────────────────────────────

  describe('connection lifecycle', () => {
    test('a hello message is sent on connection', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });
      const ws = new MockWS();

      wss.emit('connection', ws);

      const helloCall = ws.send.mock.calls.find((c) => {
        try { return JSON.parse(c[0]).type === 'hello'; } catch { return false; }
      });
      expect(helloCall).toBeDefined();
      const hello = JSON.parse(helloCall[0]);
      expect(hello.server).toBe('khy-os-cross-platform-sync');
      syncServer.detach();
    });

    test('auth message registers device with hub and replies auth:ok', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });
      const ws = new MockWS();

      wss.emit('connection', ws);
      const messageHandler = ws.listeners('message')[0];
      expect(messageHandler).toBeDefined();

      // No authenticate function => _handleAuth runs synchronously.
      messageHandler(JSON.stringify({
        type: 'auth',
        deviceId: 'd1',
        platform: 'web',
        userId: 'u1',
        token: 'tok',
      }));

      expect(mockHub.registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'd1', platform: 'web' })
      );

      const authOk = ws.send.mock.calls.find((c) => {
        try { return JSON.parse(c[0]).type === 'auth:ok'; } catch { return false; }
      });
      expect(authOk).toBeDefined();
      syncServer.detach();
    });

    test('ping message gets a pong reply', async () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });
      const ws = new MockWS();

      wss.emit('connection', ws);

      // Emit the message and wait for the async handler to complete.
      ws.emit('message', JSON.stringify({ type: 'ping' }));

      // The handler is async; give the microtask queue a chance to drain.
      await new Promise((resolve) => setImmediate(resolve));

      const pong = ws.send.mock.calls.find((c) => {
        try { return JSON.parse(c[0]).type === 'pong'; } catch { return false; }
      });
      expect(pong).toBeDefined();
      syncServer.detach();
    });
  });

  // ── notifyUser / broadcast ──────────────────────────────────────

  describe('notifyUser / broadcast', () => {
    /**
     * Helper: simulate a full auth flow for a device and return its mock WS.
     * Since no authenticate function is provided, _handleAuth runs synchronously.
     */
    function authDevice(wss, deviceId, userId, platform) {
      const ws = new MockWS();
      wss.emit('connection', ws);
      const handler = ws.listeners('message')[0];
      handler(JSON.stringify({ type: 'auth', deviceId, userId, platform, token: 'tok' }));
      return ws;
    }

    test('notifyUser sends notification to all clients of the same user', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });

      const client1 = authDevice(wss, 'd1', 'u1', 'web');
      const client2 = authDevice(wss, 'd2', 'u1', 'terminal');
      authDevice(wss, 'd3', 'u2', 'mobile');

      const delivered = syncServer.notifyUser('u1', 'Test', 'Body', { foo: 'bar' });
      expect(delivered).toBe(2); // d1 + d2

      const notifCall = client1.send.mock.calls.find((c) => {
        try { return JSON.parse(c[0]).type === 'notification'; } catch { return false; }
      });
      expect(notifCall).toBeDefined();
      const notif = JSON.parse(notifCall[0]);
      expect(notif.title).toBe('Test');
      expect(notif.body).toBe('Body');
      expect(notif.data).toEqual({ foo: 'bar' });
      syncServer.detach();
    });

    test('broadcast sends to every connected client', () => {
      const syncServer = require('../../../../src/services/crossPlatform/ws/syncServer');
      const wss = syncServer.attach({}, { hub: mockHub });

      const client1 = authDevice(wss, 'd1', 'u1', 'web');
      const client2 = authDevice(wss, 'd2', 'u2', 'terminal');

      syncServer.broadcast({ type: 'ping-all' });
      expect(client1.send).toHaveBeenCalled();
      expect(client2.send).toHaveBeenCalled();
      syncServer.detach();
    });
  });
});
