'use strict';

/**
 * Unit tests for the shared CLI command-availability cache.
 *
 * The module's whole reason to exist is to collapse a storm of synchronous
 * `<cmd> --version` spawns (which freeze the Ink event loop) into at most one
 * probe per TTL window. These tests assert that coalescing, the `force` bypass,
 * the `KHY_CLI_DETECT_TTL_MS=0` disable switch, async `prewarm`, and the
 * failure-recording path all behave as intended — without ever touching a real
 * child process (child_process is fully mocked).
 */

const MODULE_PATH = '../src/services/gateway/adapters/_commandAvailability';

describe('_commandAvailability shared cache', () => {
  let spawnSync;
  let execFileSync;
  let execFile;
  let oldTtl;

  function load() {
    return require(MODULE_PATH);
  }

  beforeEach(() => {
    jest.resetModules();
    oldTtl = process.env.KHY_CLI_DETECT_TTL_MS;

    spawnSync = jest.fn(() => ({ error: null, status: 0 }));
    execFileSync = jest.fn(() => Buffer.from('/usr/bin/claude\n'));
    // Default: async probe succeeds.
    execFile = jest.fn((cmd, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      done(null, '', '');
    });

    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));
  });

  afterEach(() => {
    if (oldTtl === undefined) delete process.env.KHY_CLI_DETECT_TTL_MS;
    else process.env.KHY_CLI_DETECT_TTL_MS = oldTtl;
    jest.dontMock('child_process');
  });

  test('coalesces repeated checks within the TTL window into a single spawn', () => {
    const mod = load();
    mod._clearCache();

    expect(mod.isAvailable('claude')).toBe(true);
    expect(mod.isAvailable('claude')).toBe(true);
    expect(mod.isAvailable('claude')).toBe(true);

    // Three logical checks, but only the first one probed.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
  });

  test('different commands are cached independently', () => {
    const mod = load();
    mod._clearCache();

    mod.isAvailable('claude');
    mod.isAvailable('codex');
    mod.isAvailable('claude');
    mod.isAvailable('codex');

    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  test('force bypasses a fresh cache entry and re-probes', () => {
    const mod = load();
    mod._clearCache();

    mod.check('claude');
    mod.check('claude'); // cached
    expect(spawnSync).toHaveBeenCalledTimes(1);

    mod.check('claude', { force: true });
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  test('ttlMs:0 (per-call) disables caching and always re-probes', () => {
    const mod = load();
    mod._clearCache();

    mod.check('claude', { ttlMs: 0 });
    mod.check('claude', { ttlMs: 0 });
    mod.check('claude', { ttlMs: 0 });

    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  test('KHY_CLI_DETECT_TTL_MS=0 disables caching globally', () => {
    process.env.KHY_CLI_DETECT_TTL_MS = '0';
    const mod = load();
    mod._clearCache();
    expect(mod.DEFAULT_TTL_MS).toBe(0);

    mod.isAvailable('claude');
    mod.isAvailable('claude');
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  test('records the error and returns ok:false when both probe stages fail', () => {
    spawnSync = jest.fn(() => ({ error: new Error('spawn ENOENT'), status: null }));
    execFileSync = jest.fn(() => { throw new Error('which: not found'); });
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));

    const mod = load();
    mod._clearCache();

    const res = mod.check('nope-cli');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENOENT/);
    expect(mod.isAvailable('nope-cli')).toBe(false);
  });

  test('falls back to PATH lookup when --version spawn fails', () => {
    // --version errors, but `which`/`where` succeeds → available.
    spawnSync = jest.fn(() => ({ error: new Error('EPERM'), status: null }));
    execFileSync = jest.fn(() => Buffer.from('/usr/bin/claude\n'));
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));

    const mod = load();
    mod._clearCache();

    expect(mod.isAvailable('claude')).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  test('prewarm primes the cache asynchronously so a later check is a hit', async () => {
    const mod = load();
    mod._clearCache();

    const results = await mod.prewarm(['claude', 'codex']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // Async prewarm uses execFile, never the synchronous spawnSync.
    expect(spawnSync).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalled();

    // A subsequent sync check is served from cache — no new spawn.
    expect(mod.isAvailable('claude')).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('prewarm never rejects even when the command is missing', async () => {
    execFile = jest.fn((cmd, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      done(new Error('ENOENT'), '', '');
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));

    const mod = load();
    mod._clearCache();

    const results = await mod.prewarm('ghost-cli');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
  });

  test('prewarm skips commands already covered by a fresh cache entry', async () => {
    const mod = load();
    mod._clearCache();

    mod.isAvailable('claude'); // populates cache via spawnSync
    expect(spawnSync).toHaveBeenCalledTimes(1);

    await mod.prewarm(['claude']);
    // Fresh entry → prewarm should not re-probe via execFile.
    expect(execFile).not.toHaveBeenCalled();
  });

  // ── Async probe API (checkAsync / isAvailableAsync) ──────────────────────
  // These exist so the gateway's parallel init can probe CLI availability
  // without ever calling the synchronous spawnSync — the root cause of the
  // "press Enter, wait tens of seconds before the workspace responds" stall.

  test('checkAsync probes via execFile and NEVER calls synchronous spawnSync', async () => {
    const mod = load();
    mod._clearCache();

    const entry = await mod.checkAsync('claude');
    expect(entry.ok).toBe(true);
    expect(execFile).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object), expect.any(Function));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('isAvailableAsync coalesces within the TTL window into a single async probe', async () => {
    const mod = load();
    mod._clearCache();

    expect(await mod.isAvailableAsync('claude')).toBe(true);
    expect(await mod.isAvailableAsync('claude')).toBe(true);
    expect(await mod.isAvailableAsync('claude')).toBe(true);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('checkAsync force bypasses a fresh cache entry and re-probes', async () => {
    const mod = load();
    mod._clearCache();

    await mod.checkAsync('claude');
    await mod.checkAsync('claude'); // cached
    expect(execFile).toHaveBeenCalledTimes(1);

    await mod.checkAsync('claude', { force: true });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  test('checkAsync shares the cache with the sync path (async primes → sync hit)', async () => {
    const mod = load();
    mod._clearCache();

    await mod.checkAsync('claude');
    expect(execFile).toHaveBeenCalledTimes(1);

    // A subsequent synchronous check is served from the shared cache — no spawn.
    expect(mod.isAvailable('claude')).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('checkAsync falls back to PATH lookup (execFile which/where) on --version failure', async () => {
    let call = 0;
    execFile = jest.fn((cmd, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      call += 1;
      if (call === 1) return done(new Error('EPERM'), '', ''); // --version fails
      return done(null, '/usr/bin/claude\n', ''); // which/where succeeds
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));

    const mod = load();
    mod._clearCache();

    expect(await mod.isAvailableAsync('claude')).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('checkAsync records the error and returns ok:false when both async stages fail', async () => {
    execFile = jest.fn((cmd, args, opts, cb) => {
      const done = typeof opts === 'function' ? opts : cb;
      done(new Error('spawn ENOENT'), '', '');
    });
    jest.resetModules();
    jest.doMock('child_process', () => ({ spawnSync, execFileSync, execFile }));

    const mod = load();
    mod._clearCache();

    const res = await mod.checkAsync('nope-cli');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ENOENT/);
  });
});
