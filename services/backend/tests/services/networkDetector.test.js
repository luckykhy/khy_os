'use strict';
/**
 * networkDetector.test.js (node:test)
 *
 * Goal "优化khy的本地模�?: the connectivity oracle that drives offline /
 * local-mode degradation must (a) carry no hardcoded finance host, (b) treat
 * the system online when ANY of several neutral probes connects, only offline
 * when all fail, (c) honor env-configured targets/timeout (零硬编码), and
 * (d) expose freshness via getStatus() (状态透明).
 *
 * Hermetic: net.connect is monkeypatched to a scripted fake socket; no real
 * sockets are opened. The module is re-required per case to pick up env config.
 */
const net = require('net');
const { EventEmitter } = require('events');
const DETECTOR_PATH = require.resolve('../../src/services/networkDetector');
const LOGGER_PATH = require.resolve('../../src/utils/logger');
const ENV_KEYS = [
  'KHY_NET_PROBE_HOSTS',
  'KHY_NET_PROBE_TIMEOUT_MS',
  'KHY_NET_PROBE_INTERVAL_MS',
];
/**
 * Load a fresh detector singleton with the given env + a scripted connect.
 * `outcome(target)` returns 'connect' | 'timeout' | 'error' for each probe.
 */
function loadDetector({ env = {}, outcome }) {
  const savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const savedConnect = net.connect;
  net.connect = ({ host, port }) => {
    const sock = new EventEmitter();
    sock.setTimeout = () => {};
    sock.destroy = () => {};
    const ev = outcome({ host, port });
    queueMicrotask(() => sock.emit(ev));
    return sock;
  };
  delete require.cache[DETECTOR_PATH];
  delete require.cache[LOGGER_PATH];
  require.cache[LOGGER_PATH] = {
    id: LOGGER_PATH, filename: LOGGER_PATH, loaded: true, exports: {
      info() {}, warn() {}, error() {}, debug() {},
    },
  };
  const detector = require(DETECTOR_PATH);
  const restore = () => {
    net.connect = savedConnect;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    delete require.cache[DETECTOR_PATH];
    delete require.cache[LOGGER_PATH];
  };
  return { detector, restore };
}
// ── shouldAttemptNetwork(): permissive gate for forced-local web fallback ─────

describe('Network Detector', () => {
  test('no hardcoded finance host in default targets', async () => {
      const src = require('fs').readFileSync(DETECTOR_PATH, 'utf8');
      expect(!/eastmoney/i.test(src)).toBeTruthy();
  });

  test('isOnline() is false before init', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'connect' });
      try {
        expect(detector.isOnline()).toBe(false);
        expect(detector.getStatus().stale).toBe(true);
        expect(detector.getStatus().initialized).toBe(false);
      } finally { restore(); }
  });

  test('online when any single probe connects (others fail)', async () => {
      // Only the global Cloudflare resolver answers; CN ones fail.
      const { detector, restore } = loadDetector({
        outcome: ({ host }) => (host === '1.1.1.1' ? 'connect' : 'error'),
      });
      try {
        const online = await detector.checkNow();
        expect(online).toBe(true);
        expect(detector.getDataMode()).toBe('online');
        expect(detector.getStatus().reason).toMatch(/reachable/);
      } finally { restore(); }
  });

  test('offline only when every probe fails', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'error' });
      try {
        const online = await detector.checkNow();
        expect(online).toBe(false);
        expect(detector.getDataMode()).toBe('offline');
        expect(detector.getStatus().reason).toMatch(/all .* probes failed/);
      } finally { restore(); }
  });

  test('timeout is treated as unreachable', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'timeout' });
      try {
        expect(await detector.checkNow()).toBe(false);
      } finally { restore(); }
  });

  test('env KHY_NET_PROBE_HOSTS overrides targets (零硬编码)', async () => {
      const { detector, restore } = loadDetector({
        env: { KHY_NET_PROBE_HOSTS: 'proxy.internal:8443, mirror.local' },
        outcome: () => 'error',
      });
      try {
        assert.deepStrictEqual(detector.getStatus().targets, [
          'proxy.internal:8443',
          'mirror.local:443', // default port applied when omitted
        ]);
      } finally { restore(); }
  });

  test('env tunes timeout and interval', async () => {
      const { detector, restore } = loadDetector({
        env: { KHY_NET_PROBE_TIMEOUT_MS: '500', KHY_NET_PROBE_INTERVAL_MS: '60000' },
        outcome: () => 'error',
      });
      try {
        const s = detector.getStatus();
        expect(s.timeoutMs).toBe(500);
        expect(s.intervalMs).toBe(60000);
      } finally { restore(); }
  });

  test('getStatus() reports freshness after a check', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'connect' });
      try {
        await detector.checkNow();
        const s = detector.getStatus();
        expect(s.online).toBe(true);
        expect(s.stale).toBe(false);
        expect(typeof s.ageMs === 'number' && s.ageMs >= 0).toBeTruthy();
        expect(Array.isArray(s.targets).toBeTruthy() && s.targets.length >= 1);
      } finally { restore(); }
  });

  test('shouldAttemptNetwork() is permissive before any check', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'error' });
      try {
        // Never checked �?must NOT skip network (could be online, we just don't know).
        expect(detector.shouldAttemptNetwork()).toBe(true);
      } finally { restore(); }
  });

  test('shouldAttemptNetwork() suppresses only on a fresh confident offline', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'error' });
      try {
        await detector.checkNow();
        expect(detector.isOnline()).toBe(false);
        // Fresh + offline �?skip the doomed network attempt.
        expect(detector.shouldAttemptNetwork()).toBe(false);
      } finally { restore(); }
  });

  test('shouldAttemptNetwork() stays permissive when online', async () => {
      const { detector, restore } = loadDetector({ outcome: () => 'connect' });
      try {
        await detector.checkNow();
        expect(detector.isOnline()).toBe(true);
        expect(detector.shouldAttemptNetwork()).toBe(true);
      } finally { restore(); }
  });

  test('shouldAttemptNetwork() falls back to permissive when offline reading is stale', async () => {
      // Tiny interval so the reading goes stale immediately; stale offline must NOT
      // be trusted to skip �?re-attempt rather than wrongly assume still-offline.
      const { detector, restore } = loadDetector({
        env: { KHY_NET_PROBE_INTERVAL_MS: '1' },
        outcome: () => 'error',
      });
      try {
        await detector.checkNow();
        expect(detector.isOnline()).toBe(false);
        await new Promise(r => setTimeout(r, 10)); // age past intervalMs*2
        expect(detector.shouldAttemptNetwork()).toBe(true, 'stale offline must not suppress');
      } finally { restore(); }
  });

});

