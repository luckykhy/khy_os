'use strict';

/**
 * Regression: gateway CLI-adapter detection must never freeze the event loop.
 *
 * The gateway's parallel init (`_doInit`) prefers `adapter.detectAsync(true)`
 * over the synchronous `detect(true)`, and races each probe against a timeout.
 * But that protection is defeated if `detectAsync` internally calls the
 * synchronous `spawnSync('<cmd> --version')` — a blocking spawn cannot be
 * interrupted by the timeout, and three of them back-to-back freeze the Ink
 * TUI for the sum of their latencies (the "press Enter, wait tens of seconds
 * before the workspace responds" stall, pronounced on macOS where first-run
 * Gatekeeper assessment makes each probe slow).
 *
 * These tests pin the contract: every CLI adapter exposes `detectAsync`, and it
 * resolves CLI existence through the shared cache's ASYNC probe (`checkAsync` /
 * `isAvailableAsync`, backed by execFile) — never the synchronous spawnSync.
 */

const AVAIL_PATH = '../src/services/gateway/adapters/_commandAvailability';

describe('CLI adapter detectAsync is non-blocking (no spawnSync storm)', () => {
  let avail;

  beforeEach(() => {
    jest.resetModules();
    avail = require(AVAIL_PATH);
    avail._clearCache();
    // Pretend every CLI is present so detection takes the "available" path.
    jest.spyOn(avail, 'checkAsync').mockResolvedValue({ ok: true, error: '', at: Date.now() });
    jest.spyOn(avail, 'isAvailableAsync').mockResolvedValue(true);
    // The synchronous entry points must NOT be reached on the async path.
    jest.spyOn(avail, 'check').mockImplementation(() => {
      throw new Error('synchronous check() must not run on the detectAsync path');
    });
    jest.spyOn(avail, 'isAvailable').mockImplementation(() => {
      throw new Error('synchronous isAvailable() must not run on the detectAsync path');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('claudeAdapter.detectAsync resolves via the async probe', async () => {
    const adapter = require('../src/services/gateway/adapters/claudeAdapter');
    expect(typeof adapter.detectAsync).toBe('function');
    const ok = await adapter.detectAsync(true);
    expect(ok).toBe(true);
    expect(avail.isAvailableAsync).toHaveBeenCalledWith('claude', { force: true });
    expect(avail.isAvailable).not.toHaveBeenCalled();
  });

  test('codexAdapter.detectAsync (CLI mode) resolves via the async probe', async () => {
    const prev = process.env.CODEX_MODE;
    process.env.CODEX_MODE = 'cli';
    jest.resetModules();
    // Re-acquire the cache module the freshly-required adapter will use, and
    // re-install the async spies on it.
    avail = require(AVAIL_PATH);
    avail._clearCache();
    jest.spyOn(avail, 'checkAsync').mockResolvedValue({ ok: true, error: '', at: Date.now() });
    jest.spyOn(avail, 'check').mockImplementation(() => {
      throw new Error('synchronous check() must not run on the detectAsync path');
    });
    try {
      const adapter = require('../src/services/gateway/adapters/codexAdapter');
      expect(typeof adapter.detectAsync).toBe('function');
      const ok = await adapter.detectAsync(true);
      expect(ok).toBe(true);
      expect(avail.checkAsync).toHaveBeenCalledWith('codex', { force: true });
      expect(avail.check).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CODEX_MODE;
      else process.env.CODEX_MODE = prev;
    }
  });

  test('cliToolAdapter.detectAsync resolves via the async probe', async () => {
    const adapter = require('../src/services/gateway/adapters/cliToolAdapter');
    expect(typeof adapter.detectAsync).toBe('function');
    const ok = await adapter.detectAsync(true);
    expect(ok).toBe(true);
    expect(avail.isAvailableAsync).toHaveBeenCalled();
    expect(avail.isAvailable).not.toHaveBeenCalled();
  });
});
