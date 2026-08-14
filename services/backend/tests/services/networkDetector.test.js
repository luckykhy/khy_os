'use strict';

/**
 * networkDetector.test.js (node:test)
 *
 * Goal "优化khy的本地模式": the connectivity oracle that drives offline /
 * local-mode degradation must (a) carry no hardcoded finance host, (b) treat
 * the system online when ANY of several neutral probes connects, only offline
 * when all fail, (c) honor env-configured targets/timeout (零硬编码), and
 * (d) expose freshness via getStatus() (状态透明).
 *
 * Hermetic: net.connect is monkeypatched to a scripted fake socket; no real
 * sockets are opened. The module is re-required per case to pick up env config.
 */
const test = require('node:test');
const assert = require('node:assert');
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

test('no hardcoded finance host in default targets', () => {
  const src = require('fs').readFileSync(DETECTOR_PATH, 'utf8');
  assert.ok(!/eastmoney/i.test(src), 'finance host leaked into OS connectivity probe');
});

test('isOnline() is false before init', () => {
  const { detector, restore } = loadDetector({ outcome: () => 'connect' });
  try {
    assert.strictEqual(detector.isOnline(), false);
    assert.strictEqual(detector.getStatus().stale, true);
    assert.strictEqual(detector.getStatus().initialized, false);
  } finally { restore(); }
});

test('online when any single probe connects (others fail)', async () => {
  // Only the global Cloudflare resolver answers; CN ones fail.
  const { detector, restore } = loadDetector({
    outcome: ({ host }) => (host === '1.1.1.1' ? 'connect' : 'error'),
  });
  try {
    const online = await detector.checkNow();
    assert.strictEqual(online, true);
    assert.strictEqual(detector.getDataMode(), 'online');
    assert.match(detector.getStatus().reason, /reachable/);
  } finally { restore(); }
});

test('offline only when every probe fails', async () => {
  const { detector, restore } = loadDetector({ outcome: () => 'error' });
  try {
    const online = await detector.checkNow();
    assert.strictEqual(online, false);
    assert.strictEqual(detector.getDataMode(), 'offline');
    assert.match(detector.getStatus().reason, /all .* probes failed/);
  } finally { restore(); }
});

test('timeout is treated as unreachable', async () => {
  const { detector, restore } = loadDetector({ outcome: () => 'timeout' });
  try {
    assert.strictEqual(await detector.checkNow(), false);
  } finally { restore(); }
});

test('env KHY_NET_PROBE_HOSTS overrides targets (零硬编码)', () => {
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

test('env tunes timeout and interval', () => {
  const { detector, restore } = loadDetector({
    env: { KHY_NET_PROBE_TIMEOUT_MS: '500', KHY_NET_PROBE_INTERVAL_MS: '60000' },
    outcome: () => 'error',
  });
  try {
    const s = detector.getStatus();
    assert.strictEqual(s.timeoutMs, 500);
    assert.strictEqual(s.intervalMs, 60000);
  } finally { restore(); }
});

test('getStatus() reports freshness after a check', async () => {
  const { detector, restore } = loadDetector({ outcome: () => 'connect' });
  try {
    await detector.checkNow();
    const s = detector.getStatus();
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.stale, false);
    assert.ok(typeof s.ageMs === 'number' && s.ageMs >= 0);
    assert.ok(Array.isArray(s.targets) && s.targets.length >= 1);
  } finally { restore(); }
});

// ── shouldAttemptNetwork(): permissive gate for forced-local web fallback ─────

test('shouldAttemptNetwork() is permissive before any check', () => {
  const { detector, restore } = loadDetector({ outcome: () => 'error' });
  try {
    // Never checked → must NOT skip network (could be online, we just don't know).
    assert.strictEqual(detector.shouldAttemptNetwork(), true);
  } finally { restore(); }
});

test('shouldAttemptNetwork() suppresses only on a fresh confident offline', async () => {
  const { detector, restore } = loadDetector({ outcome: () => 'error' });
  try {
    await detector.checkNow();
    assert.strictEqual(detector.isOnline(), false);
    // Fresh + offline → skip the doomed network attempt.
    assert.strictEqual(detector.shouldAttemptNetwork(), false);
  } finally { restore(); }
});

test('shouldAttemptNetwork() stays permissive when online', async () => {
  const { detector, restore } = loadDetector({ outcome: () => 'connect' });
  try {
    await detector.checkNow();
    assert.strictEqual(detector.isOnline(), true);
    assert.strictEqual(detector.shouldAttemptNetwork(), true);
  } finally { restore(); }
});

test('shouldAttemptNetwork() falls back to permissive when offline reading is stale', async () => {
  // Tiny interval so the reading goes stale immediately; stale offline must NOT
  // be trusted to skip — re-attempt rather than wrongly assume still-offline.
  const { detector, restore } = loadDetector({
    env: { KHY_NET_PROBE_INTERVAL_MS: '1' },
    outcome: () => 'error',
  });
  try {
    await detector.checkNow();
    assert.strictEqual(detector.isOnline(), false);
    await new Promise(r => setTimeout(r, 10)); // age past intervalMs*2
    assert.strictEqual(detector.shouldAttemptNetwork(), true, 'stale offline must not suppress');
  } finally { restore(); }
});
