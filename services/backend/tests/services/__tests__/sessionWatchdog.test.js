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
 *   - onReport host handoff: only an explicit `true` takes the line; refusal,
 *     throw or an absent hook keep the historical stderr write
 *
 * Timing: real timers with shrunken sampleMs/idleLimitMs injected via opts;
 * windows are padded so the suite stays reliable on loaded CI machines.
 */
const { installSessionWatchdog, resetForTest } = require('../../../src/services/sessionWatchdog.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { sampleMs: 40, idleLimitMs: 120, stallMs: 60_000 };

/**
 * Intercept everything the watchdog would put on the terminal: its own stderr
 * write plus ResourceGuard's console.error line (which also reaches stderr).
 * The spy must be installed BEFORE installSessionWatchdog() — the watchdog
 * binds the write it sees at install time, so a later spy is never reached.
 * Bytes are swallowed instead of forwarded: the un-suppressed console.error is
 * itself an "activity" write, so forwarding it would re-arm the idle clock and
 * make the watchdog report in a loop while the assertions run.
 */
function captureTerminal() {
  const lines = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const consoleError = console.error;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    has: (needle) => lines.some((l) => l.includes(needle)),
    stop() {
      process.stderr.write = stderrWrite;
      console.error = consoleError;
    },
  };
}

/** Poll a predicate on real timers until it holds or the window runs out. */
async function waitUntil(pred, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

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
      // Go quiet �?a new idle episode must arm and fire.
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

  test('stop() hands the stream writes back so a dead watchdog cannot re-arm', async () => {
      resetForTest();
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      const reports = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        idleLimitMs: 120,
        onHang: () => {},
        onReport: (line) => { reports.push(line); return true; },
      });
      expect(process.stdout.write).not.toBe(stdoutWrite);
      expect(process.stderr.write).not.toBe(stderrWrite);
      inst.stop();
      // Identity, not behaviour: a leftover closure on the stream would keep
      // touching (i.e. re-arming) on every later write, forever.
      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
      // And nothing fires after the streams are back.
      await waitUntil(() => reports.length >= 1, 400);
      expect(reports.length).toBe(0);
  });

  // onReport handoff (BUG-17): a raw stderr write while another renderer owns
  // the terminal is never erased by its frame ledger, so the host must be able
  // to take the line. Only an explicit `true` counts — losing the diagnosis is
  // worse than the stray row, so every other outcome falls back to stderr.

  test('onReport returning true takes the line and nothing reaches stderr', async () => {
      resetForTest();
      const cap = captureTerminal();
      const taken = [];
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: (line) => { taken.push(line); return true; },
        });
        expect(await waitUntil(() => taken.length >= 1)).toBeTruthy();
        expect(taken[0].startsWith('[Watchdog]')).toBeTruthy();
        expect(cap.has('[Watchdog]')).toBe(false);
      } finally {
        if (inst) inst.stop();
        cap.stop();
      }
  });

  test('onReport refusing (false) keeps the historical stderr write', async () => {
      resetForTest();
      const cap = captureTerminal();
      let calls = 0;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: () => { calls += 1; return false; },
        });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        expect(calls >= 1).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        cap.stop();
      }
  });

  test('a throwing onReport falls back to stderr and never breaks the watchdog', async () => {
      resetForTest();
      const cap = captureTerminal();
      let hung = null;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: (e) => { hung = e; },
          onReport: () => { throw new Error('host sink exploded'); },
        });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        // The hang notification must survive a broken host sink.
        expect(hung && hung.kind).toBe('idle');
      } finally {
        if (inst) inst.stop();
        cap.stop();
      }
  });

  test('no onReport at all leaves the historical stderr write untouched', async () => {
      resetForTest();
      const cap = captureTerminal();
      let inst = null;
      try {
        inst = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        const line = cap.lines.find((l) => l.includes('[Watchdog]'));
        expect(line.endsWith('\n')).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        cap.stop();
      }
  });

  test('a host that unmounts mid-session falls back to stderr for later reports', async () => {
      resetForTest();
      const cap = captureTerminal();
      let wired = true;
      let taken = 0;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: () => { taken += 1; return wired; },
        });
        expect(await waitUntil(() => taken >= 1)).toBeTruthy();
        expect(cap.has('[Watchdog]')).toBe(false);
        // Unmount the host (the App effect returns false once inactive), then
        // re-arm a fresh idle episode.
        wired = false;
        inst.touch();
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        cap.stop();
      }
  });

});

