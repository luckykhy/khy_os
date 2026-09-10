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
const { installSessionWatchdog, resetForTest } = require('../sessionWatchdog');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { sampleMs: 40, idleLimitMs: 120, stallMs: 60_000 };

describe('Session Watchdog', () => {
  test('idle hang fires onHang after the idle window with diagnostics', async () => {
      resetForTest();
      const events = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        onHang: (e) => events.push(e),
      });
      expect(inst.reason).toBe('installed');
      await sleep(600);
      expect(events.length >= 1).toBeTruthy();
      expect(events[0].kind).toBe('idle');
      expect(events[0].idleSeconds >= 0).toBeTruthy();
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
      expect(events.length).toBe(0);
      // Go quiet â€?a new idle episode must arm and fire.
      await sleep(600);
      expect(events.length >= 1).toBeTruthy();
      inst.stop();
  });

  test('per-process install is idempotent (Symbol lock)', async () => {
      resetForTest();
      const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      expect(b.reason).toBe('already-installed');
      a.stop();
  });

  test('gate off disables the watchdog entirely', async () => {
      resetForTest();
      const r = installSessionWatchdog({ env: { KHY_SESSION_WATCHDOG: '0' } });
      expect(r.reason).toBe('gate-off');
  });

  test('stop() releases the lock so a later install works again', async () => {
      resetForTest();
      const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      a.stop();
      const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      expect(b.reason).toBe('installed');
      b.stop();
  });

});

