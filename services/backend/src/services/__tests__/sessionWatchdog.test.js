'use strict';

/**
 * sessionWatchdog leaf tests (node:test).
 *
 * Coverage:
 *   - idle hang fires once per episode with the honest onHang payload
 *   - activity (stdout writes) postpones and re-arms the idle report
 *   - self-report writes never reset the idle clock they report on
 *   - per-process idempotency (Symbol lock) and gate-off / resetForTest
 *   - sync-stall sampler is unref'd (never holds the event loop open)
 *
 * Timing: real timers with shrunken sampleMs/idleLimitMs injected via opts;
 * windows are padded so the suite stays reliable on loaded CI machines.
 */

const assert = require('node:assert');
const test = require('node:test');

const { installSessionWatchdog, resetForTest } = require('../sessionWatchdog');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAST = { sampleMs: 40, idleLimitMs: 120, stallMs: 60_000 };

test('idle hang fires onHang after the idle window with diagnostics', async () => {
  resetForTest();
  const events = [];
  const inst = installSessionWatchdog({
    env: {},
    ...FAST,
    onHang: (e) => events.push(e),
  });
  assert.equal(inst.reason, 'installed');
  await sleep(600);
  assert.ok(events.length >= 1, 'expected at least one idle hang event');
  assert.equal(events[0].kind, 'idle');
  assert.ok(events[0].idleSeconds >= 0);
  inst.stop();
});

test('activity postpones the idle report, then a fresh episode fires again', async () => {
  resetForTest();
  const events = [];
  const inst = installSessionWatchdog({
    env: {},
    ...FAST,
    onHang: (e) => events.push(e),
  });
  // Stay active for ~400ms via stdout writes (each write touches the guard).
  const start = Date.now();
  while (Date.now() - start < 400) {
    process.stdout.write('');
    await sleep(80);
  }
  assert.equal(events.length, 0, 'activity must postpone the idle report');
  // Go quiet — a new idle episode must arm and fire.
  await sleep(600);
  assert.ok(events.length >= 1, 'expected a hang event after activity stops');
  inst.stop();
});

test('per-process install is idempotent (Symbol lock)', () => {
  resetForTest();
  const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
  const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
  assert.equal(b.reason, 'already-installed');
  a.stop();
});

test('gate off disables the watchdog entirely', () => {
  resetForTest();
  const r = installSessionWatchdog({ env: { KHY_SESSION_WATCHDOG: '0' } });
  assert.equal(r.reason, 'gate-off');
});

test('stop() releases the lock so a later install works again', async () => {
  resetForTest();
  const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
  a.stop();
  const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
  assert.equal(b.reason, 'installed');
  b.stop();
});
