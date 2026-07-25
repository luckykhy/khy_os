'use strict';

/**
 * Tests for the cc-switch-inspired gateway management improvements:
 *   1. Error-rate circuit breaking (sliding window).
 *   2. success_threshold recovery gating (half-open observation).
 *   3. User-defined failover order injection into route ordering.
 *
 * The error-rate window is tested directly on MemoryHealthStore (deterministic).
 * The gateway-level behaviors run against the singleton with an injected
 * MemoryHealthStore; they are guarded with `if (!gateway) return` because the
 * singleton has heavy optional dependencies that may not load in CI.
 */

const { MemoryHealthStore } = require('../../src/services/gateway/redisHealthStore');

let gateway;
let loadError;
const ORIG_ENV = { ...process.env };

beforeAll(() => {
  try {
    gateway = require('../../src/services/gateway/aiGateway');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    loadError = e;
  }
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

// ── 1. Error-rate window (MemoryHealthStore, deterministic) ──────────────────

describe('MemoryHealthStore error-rate window', () => {
  test('tallies total/failed and computes rate', async () => {
    const store = new MemoryHealthStore();
    await store.recordWindowOutcome('a', true);
    await store.recordWindowOutcome('a', false);
    await store.recordWindowOutcome('a', false);
    const stats = await store.getWindowStats('a');
    expect(stats.total).toBe(3);
    expect(stats.failed).toBe(2);
    expect(stats.rate).toBeCloseTo(2 / 3, 5);
  });

  test('empty window returns zero rate', async () => {
    const store = new MemoryHealthStore();
    const stats = await store.getWindowStats('missing');
    expect(stats).toEqual({ total: 0, failed: 0, rate: 0 });
  });

  test('clearFailure resets the window', async () => {
    const store = new MemoryHealthStore();
    await store.recordWindowOutcome('a', false);
    await store.clearFailure('a');
    const stats = await store.getWindowStats('a');
    expect(stats.total).toBe(0);
  });

  test('getAllAdapterStates surfaces windowTotal/windowFailed/errorRate', async () => {
    const store = new MemoryHealthStore();
    await store.recordWindowOutcome('a', false);
    await store.recordWindowOutcome('a', true);
    const states = await store.getAllAdapterStates(['a']);
    expect(states.a.windowTotal).toBe(2);
    expect(states.a.windowFailed).toBe(1);
    expect(states.a.errorRate).toBeCloseTo(0.5, 5);
  });
});

// ── 2. Error-rate circuit breaking (gateway) ─────────────────────────────────

describe('gateway error-rate circuit breaking', () => {
  function prep() {
    gateway._healthStore = new MemoryHealthStore();
    gateway._adapterFailures = {};
    gateway._adapterLastError = {};
    gateway._cooldownSelfHealMeta = {};
    gateway._cooldownSelfHealInFlight = new Map();
  }

  test('opens on error rate even below consecutive threshold', async () => {
    if (!gateway) return;
    prep();
    // Keep the consecutive trigger out of the way; isolate the rate trigger.
    process.env.GATEWAY_CIRCUIT_BREAKER_THRESHOLD = '100';
    process.env.GATEWAY_CIRCUIT_ERROR_RATE_THRESHOLD = '0.4';
    process.env.GATEWAY_CIRCUIT_MIN_REQUESTS = '5';

    const key = 'kiro';
    // Pre-seed the window: 5 failures + 3 successes (rate 0.625, total 8).
    for (let i = 0; i < 5; i++) await gateway._healthStore.recordWindowOutcome(key, false);
    for (let i = 0; i < 3; i++) await gateway._healthStore.recordWindowOutcome(key, true);

    await gateway._recordAdapterFailure(key, 'server_error', 'boom');

    const mirror = gateway._adapterLastError[key];
    expect(mirror).toBeTruthy();
    expect(mirror.circuitOpen).toBe(true);
    expect(mirror.circuitReason).toBe('error_rate');

    await gateway._clearAdapterFailure(key); // cleanup timers/state
  });

  test('does not open on a tiny sample', async () => {
    if (!gateway) return;
    prep();
    process.env.GATEWAY_CIRCUIT_BREAKER_THRESHOLD = '100';
    process.env.GATEWAY_CIRCUIT_ERROR_RATE_THRESHOLD = '0.4';
    process.env.GATEWAY_CIRCUIT_MIN_REQUESTS = '10';

    const key = 'cursor';
    await gateway._recordAdapterFailure(key, 'server_error', 'boom');

    const mirror = gateway._adapterLastError[key];
    expect(mirror.circuitOpen).toBe(false);

    await gateway._clearAdapterFailure(key);
  });
});

// ── 3. success_threshold recovery gating (gateway) ───────────────────────────

describe('gateway success_threshold recovery gating', () => {
  function prepOpen(key) {
    gateway._healthStore = new MemoryHealthStore();
    gateway._adapterFailures = {};
    gateway._cooldownSelfHealMeta = {};
    gateway._cooldownSelfHealInFlight = new Map();
    gateway._adapterLastError = {
      [key]: { at: Date.now(), errorType: 'server_error', error: 'x', cooldownMs: 1000, circuitOpen: true },
    };
  }

  test('requires N consecutive successes before fully clearing', async () => {
    if (!gateway) return;
    process.env.GATEWAY_CIRCUIT_SUCCESS_THRESHOLD = '2';
    const key = 'trae';
    prepOpen(key);

    // First success → half-open observation, NOT cleared.
    await gateway._clearAdapterFailure(key);
    expect(gateway._adapterLastError[key]).toBeTruthy();
    expect(gateway._adapterLastError[key].halfOpen).toBe(true);

    // Second success → threshold met → fully cleared.
    await gateway._clearAdapterFailure(key);
    expect(gateway._adapterLastError[key]).toBeUndefined();
  });

  test('threshold=1 reverts to legacy first-success clear', async () => {
    if (!gateway) return;
    process.env.GATEWAY_CIRCUIT_SUCCESS_THRESHOLD = '1';
    const key = 'claude';
    prepOpen(key);

    await gateway._clearAdapterFailure(key);
    expect(gateway._adapterLastError[key]).toBeUndefined();
  });

  test('closed circuit clears immediately (fast path untouched)', async () => {
    if (!gateway) return;
    process.env.GATEWAY_CIRCUIT_SUCCESS_THRESHOLD = '5';
    const key = 'codex';
    gateway._healthStore = new MemoryHealthStore();
    gateway._adapterFailures = {};
    gateway._cooldownSelfHealMeta = {};
    gateway._cooldownSelfHealInFlight = new Map();
    gateway._adapterLastError = {}; // no prior failure → not in recovery

    await gateway._clearAdapterFailure(key);
    expect(gateway._adapterLastError[key]).toBeUndefined();
  });
});

// ── 4. User-defined failover order injection ─────────────────────────────────

describe('gateway user failover order', () => {
  test('listed adapters sort to the front in given order', () => {
    if (!gateway) return;
    const keys = gateway._adapters.map((a) => a.key);
    if (keys.length < 2) return; // need at least two adapters to reorder

    // Pick the last two adapters and force them to the front in reverse.
    const a = keys[keys.length - 1];
    const b = keys[keys.length - 2];
    process.env.GATEWAY_FAILOVER_ORDER = `${a},${b}`;
    gateway._invalidateFailoverOrderCache();

    const ordered = gateway._orderAdaptersByDefaultRoutePreference(gateway._adapters);
    expect(ordered[0].key).toBe(a);
    expect(ordered[1].key).toBe(b);

    delete process.env.GATEWAY_FAILOVER_ORDER;
    gateway._invalidateFailoverOrderCache();
  });

  test('no user order → unchanged length, all adapters preserved', () => {
    if (!gateway) return;
    delete process.env.GATEWAY_FAILOVER_ORDER;
    gateway._invalidateFailoverOrderCache();
    const ordered = gateway._orderAdaptersByDefaultRoutePreference(gateway._adapters);
    expect(ordered.length).toBe(gateway._adapters.length);
    expect(new Set(ordered.map((a) => a.key))).toEqual(new Set(gateway._adapters.map((a) => a.key)));
  });
});
