'use strict';
/**
 * ai-manage-daemon GC loop / reaping behavior.
 *
 * The daemon self-reaps when idle. This test pins down the exact reaping
 * decision (idle vs startup-timeout vs "stay alive"), driven through the
 * exported `startGcLoop` with injectable tick + jest fake timers, so a future
 * regression (e.g. the flapping "dies even while work is in flight" bug) is
 * caught.
 *
 * Two classes of behavior are covered:
 *   1. Reaping decisions (startup-timeout / idle / active-session / busy-probe
 *      keep it alive, session-TTL expiry).
 *   2. Fault isolation: transient uncaughtException / unhandledRejection must
 *      NOT tear down the whole stack (F2), while unknown/fatal still must.
 *
 * Safety: `os.homedir` and `process.exit` are mocked so no real file or exit
 * happens; the daemon's runtime/legacy files land in a throwaway temp dir.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let mod;
let tempHome;
let homeSpy;
let exitSpy;
let logSpy;
let errSpy;

// Deterministic fake clock base so inactivity math is exact.
const BASE = Date.parse('2026-01-01T00:00:00Z');

function freshState() {
  // Set the fake clock FIRST, then reset module state so lastActiveAt/startupAt
  // anchor to the deterministic fake base (not the real wall clock).
  jest.useFakeTimers();
  jest.setSystemTime(BASE);
  mod._resetForTests();
  logSpy.mockClear();
  errSpy.mockClear();
  exitSpy.mockClear();
}

function reapReasons() {
  const all = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' '));
  return all.filter((s) => s.includes('正在关闭守护进程') || s.includes('shutdown:'));
}

beforeAll(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-gc-'));
  // Route the legacy runtime file (os.homedir()/.khyquant) to the temp home so
  // writeRuntime()/clearRuntime() never touch the real C: drive.
  homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  mod = require('../scripts/ai-manage-daemon');
});

afterAll(() => {
  jest.useRealTimers();
  if (mod) mod._resetForTests();
  exitSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  homeSpy.mockRestore();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('ai-manage-daemon GC reaping decisions', () => {
  beforeEach(freshState);
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mod._resetForTests();
  });

  test('reaps as startup-timeout when no session was ever seen and the startup grace elapses', () => {
    mod.startGcLoop({ idleMs: 600_000, sessionTtlMs: 35_000, startupGraceMs: 10_000, tickMs: 1_000 });
    expect(mod.getState().shuttingDown).toBe(false);

    jest.advanceTimersByTime(11_000); // fires 11 ticks; inactivity hits 10_000 (startupGrace)

    expect(mod.getState().shuttingDown).toBe(true);
    expect(reapReasons().some((s) => s.includes('原因=startup-timeout') || s.includes('shutdown: startup-timeout'))).toBe(true);
  });

  test('reaps as idle when a session was previously seen, then goes quiet past idleMs', () => {
    mod.upsertSession('s1'); // seenAnySession = true
    mod.removeSession('s1'); // sessions.size back to 0, but the "seen" flag stays true
    mod.startGcLoop({ idleMs: 10_000, sessionTtlMs: 35_000, startupGraceMs: 600_000, tickMs: 1_000 });

    jest.advanceTimersByTime(11_000); // inactivity hits 10_000 (idleMs, because seen)

    expect(mod.getState().shuttingDown).toBe(true);
    expect(reapReasons().some((s) => s.includes('原因=idle') || s.includes('shutdown: idle'))).toBe(true);
  });

  test('an active (live) session keeps the daemon alive past idleMs', () => {
    mod.upsertSession('s1');
    mod.startGcLoop({ idleMs: 10_000, sessionTtlMs: 600_000, startupGraceMs: 10_000, tickMs: 1_000 });

    jest.advanceTimersByTime(30_000); // 30 ticks; the live session refreshes lastActiveAt each tick

    expect(mod.getState().shuttingDown).toBe(false);
    expect(mod.getState().sessions.size).toBe(1);
  });

  test('a busy activity probe (e.g. workflow worker mid-run) prevents startup-timeout self-kill', () => {
    // The regression this guards: a long headless task must not be reaped mid-flight.
    let busy = true;
    mod.addActivityProbe(() => busy);
    mod.startGcLoop({ idleMs: 10_000, sessionTtlMs: 35_000, startupGraceMs: 10_000, tickMs: 1_000 });

    jest.advanceTimersByTime(30_000); // no session ever seen, but the probe reports busy

    expect(mod.getState().shuttingDown).toBe(false);

    // Once the probe clears, the startup-timeout watchdog resumes and reaps.
    busy = false;
    jest.advanceTimersByTime(30_000);
    expect(mod.getState().shuttingDown).toBe(true);
  });

  test('served HTTP traffic delays startup-timeout, but does not disable reaping', () => {
    // Regression guard: a tab whose /open /ping never reaches the control port
    // (sandboxed guest view, cross-origin-restricted fetch, offline network)
    // left seenAnySession=false for the daemon's whole lifetime. The old clock
    // keyed on lastActiveAt only, so a daemon that was actively serving HTTP
    // classified itself as idle and self-terminated — the user's already-open
    // tab then failed with ERR_CONNECTION_REFUSED.
    mod.startGcLoop({ idleMs: 10_000, sessionTtlMs: 35_000, startupGraceMs: 10_000, tickMs: 1_000 });

    // 4s in, the API answers a request — but nothing ever registered a session.
    jest.advanceTimersByTime(4_000);
    mod.noteRequestActivity();
    expect(mod.getState().lastRequestAt).toBeGreaterThan(0);

    // At 10s total the un-patched daemon would have reaped (lastActiveAt is
    // still the startup instant). Serving traffic must keep it alive instead.
    jest.advanceTimersByTime(6_000);
    expect(mod.getState().shuttingDown).toBe(false);

    // Quiet again and the watchdog must still fire: the request hook delays GC,
    // it must not make the daemon immortal.
    jest.advanceTimersByTime(20_000);
    expect(mod.getState().shuttingDown).toBe(true);
    expect(reapReasons().some((s) => s.includes('原因=startup-timeout'))).toBe(true);
  });

  test('a session expires after sessionTtlMs of silence', () => {
    mod.upsertSession('s1');
    mod.startGcLoop({ idleMs: 600_000, sessionTtlMs: 10_000, startupGraceMs: 600_000, tickMs: 1_000 });

    jest.advanceTimersByTime(11_000); // past the 10s TTL

    expect(mod.getState().sessions.size).toBe(0);
  });
});

describe('ai-manage-daemon fault isolation (transient vs fatal)', () => {
  beforeEach(freshState);
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    mod._resetForTests();
  });

  test('a transient uncaughtException (ECONNRESET) does not tear down the daemon', () => {
    const err = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
    mod.handleUncaughtException(err);
    expect(mod.getState().shuttingDown).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('a transient uncaughtException (SQLITE_BUSY) does not tear down the daemon', () => {
    const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    mod.handleUncaughtException(err);
    expect(mod.getState().shuttingDown).toBe(false);
  });

  test('a transient spawn ENOENT (missing interpreter) does not tear down the daemon', () => {
    const err = Object.assign(new Error('spawn C:\\khy-os\\tools\\deepseek-eyes\\.venv\\Scripts\\python.exe ENOENT'), {
      code: 'ENOENT',
    });
    mod.handleUnhandledRejection(err);
    expect(mod.getState().shuttingDown).toBe(false);
  });

  test('an unknown uncaughtException still tears down the daemon (fail-safe)', () => {
    mod.handleUncaughtException(new Error('some unknown condition'));
    expect(mod.getState().shuttingDown).toBe(true);
  });

  test('an unknown unhandledRejection still tears down the daemon (fail-safe)', () => {
    mod.handleUnhandledRejection(new Error('some unknown condition'));
    expect(mod.getState().shuttingDown).toBe(true);
  });

  test('shutdown is idempotent (a second reaping request is a no-op)', () => {
    mod.handleUncaughtException(new Error('some unknown condition')); // first: triggers shutdown
    const shuttingDown = mod.getState().shuttingDown;
    mod.handleUncaughtException(new Error('another unknown')); // second: already shutting down
    expect(shuttingDown).toBe(true);
    expect(mod.getState().shuttingDown).toBe(true);
  });
});
