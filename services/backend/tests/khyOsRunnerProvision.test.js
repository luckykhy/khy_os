'use strict';

/**
 * Tests for KhyOsRunner's run-path QEMU auto-provisioning (_ensureRuntimeQemu).
 *
 * On a fresh Windows host there is no qemu-system-x86_64 on PATH; rather than
 * dead-ending at spawn ENOENT, the runner downloads a pinned portable QEMU
 * (mirroring the build toolchain). These exercise that decision tree through the
 * injected `spawnSync` + `ensurePortableQemu` seams — NO real QEMU, network, or
 * child process is touched. Each case asserts both the resolved `this.qemu` and
 * the fail-soft contract (any failure → keep the default name so start()'s ENOENT
 * branch still emits the actionable "install QEMU" hint).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const RUNNER_PATH = path.resolve(
  __dirname, '..', '..', '..',
  'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', 'KhyOsRunner',
);
const { KhyOsRunner } = require(RUNNER_PATH);

const ISO = '/tmp/fake-khy-os.iso';

// Neutralize an ambient KHY_QEMU so the no-override cases below see the bare
// default name (otherwise a dev machine with KHY_QEMU set would mark every
// runner "explicit" and skip the probe/provision path under test).
let savedKhyQemu;
beforeEach(() => {
  savedKhyQemu = process.env.KHY_QEMU;
  delete process.env.KHY_QEMU;
});
afterEach(() => {
  if (savedKhyQemu === undefined) delete process.env.KHY_QEMU;
  else process.env.KHY_QEMU = savedKhyQemu;
});

/** A spawnSync seam: succeeds (status 0) only for executables in `present`. */
function spawnSyncFor(present) {
  const seen = [];
  const fn = (exe, args) => {
    seen.push({ exe, args });
    if (present.includes(exe)) return { status: 0, error: null, stdout: 'QEMU emulator version 9.0.0' };
    const err = new Error('spawn ENOENT');
    err.code = 'ENOENT';
    return { status: null, error: err };
  };
  fn.seen = seen;
  return fn;
}

describe('KhyOsRunner._ensureRuntimeQemu', () => {
  test('explicit KHY_QEMU/opts.qemu override → never probes, never provisions', async () => {
    let provisioned = false;
    const runner = new KhyOsRunner({
      isoPath: ISO,
      qemu: '/custom/qemu-system-x86_64',
      spawnSync: spawnSyncFor([]), // would report "missing" if consulted
      ensurePortableQemu: async () => { provisioned = true; return { systemBin: '/dl/q.exe' }; },
    });
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, '/custom/qemu-system-x86_64');
    assert.equal(provisioned, false);
    assert.equal(runner._spawnSync.seen.length, 0); // override short-circuits before probe
  });

  test('system QEMU present on PATH → used as-is, no download', async () => {
    let provisioned = false;
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor(['qemu-system-x86_64']),
      ensurePortableQemu: async () => { provisioned = true; return { systemBin: '/dl/q.exe' }; },
    });
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, 'qemu-system-x86_64');
    assert.equal(provisioned, false);
    assert.equal(runner._spawnSync.seen.length, 1); // probed once, succeeded
  });

  test('absent on PATH but installed off-PATH → locate & use it, no download', async () => {
    // Windows installer / winget put qemu-system-x86_64.exe in C:\Program Files\qemu
    // without touching PATH: the PATH probe fails, but the injected locator finds the
    // off-PATH binary; a re-probe of that path succeeds → use it, skip the download.
    const OFF_PATH = 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe';
    let provisioned = false;
    let located = 0;
    const runner = new KhyOsRunner({
      isoPath: ISO,
      // PATH probe misses the default name, but succeeds for the located off-PATH exe.
      spawnSync: spawnSyncFor([OFF_PATH]),
      locateSystemQemu: () => { located += 1; return OFF_PATH; },
      ensurePortableQemu: async () => { provisioned = true; return { systemBin: '/dl/q.exe' }; },
    });
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, OFF_PATH);
    assert.equal(located, 1);            // locator consulted after the PATH miss
    assert.equal(provisioned, false);    // download skipped — no portable copy fetched
  });

  test('locator returns a path that fails re-probe → fall through to portable download', async () => {
    // A stale/broken well-known hit must not be trusted: re-probe gates it, and a
    // failing re-probe falls through to the portable-download path (no regression).
    let provisioned = false;
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]), // nothing probes OK, including the located path
      locateSystemQemu: () => 'C:\\stale\\qemu-system-x86_64.exe',
      ensurePortableQemu: async () => {
        provisioned = true;
        return { systemBin: 'C:\\khyos\\qemu\\qemu-system-x86_64.exe', dir: 'C:\\khyos\\qemu' };
      },
    });
    await runner._ensureRuntimeQemu();
    assert.equal(provisioned, true);
    assert.equal(runner.qemu, 'C:\\khyos\\qemu\\qemu-system-x86_64.exe');
  });

  test('locator throws → fail-soft, fall through to portable download', async () => {
    let provisioned = false;
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]),
      locateSystemQemu: () => { throw new Error('boom'); },
      ensurePortableQemu: async () => { provisioned = true; return { systemBin: '/dl/q.exe' }; },
    });
    await runner._ensureRuntimeQemu(); // must not reject
    assert.equal(provisioned, true);
  });

  test('absent on PATH → provision portable QEMU, repoint this.qemu, emit status', async () => {
    const events = [];
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]), // ENOENT
      ensurePortableQemu: async ({ onProgress }) => {
        onProgress({ downloaded: 10, total: 100, done: false });
        onProgress({ downloaded: 100, total: 100, done: true });
        return { systemBin: 'C:\\khyos\\qemu\\qemu-system-x86_64.exe', imgBin: null, dir: 'C:\\khyos\\qemu' };
      },
    });
    runner.on('status', (s) => events.push(s));
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, 'C:\\khyos\\qemu\\qemu-system-x86_64.exe');
    assert.equal(events.length, 2);
    assert.equal(events[0].phase, 'provisioning-qemu');
    assert.equal(events[0].downloaded, 10);
    assert.equal(events[1].done, true);
  });

  test('provisioner returns null (offline/unpinned) → keep default name (degrade)', async () => {
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]),
      ensurePortableQemu: async () => null,
    });
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, 'qemu-system-x86_64'); // unchanged → ENOENT hint later
  });

  test('provisioner throws → fail-soft, keep default name', async () => {
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]),
      ensurePortableQemu: async () => { throw new Error('network down'); },
    });
    await runner._ensureRuntimeQemu(); // must not reject
    assert.equal(runner.qemu, 'qemu-system-x86_64');
  });

  test('provisioner returns object without systemBin → keep default name', async () => {
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: spawnSyncFor([]),
      ensurePortableQemu: async () => ({ systemBin: null, dir: '/x' }),
    });
    await runner._ensureRuntimeQemu();
    assert.equal(runner.qemu, 'qemu-system-x86_64');
  });
});

describe('KhyOsRunner._probeExecutable', () => {
  test('true only on status 0 with no error', () => {
    const runner = new KhyOsRunner({ isoPath: ISO, spawnSync: spawnSyncFor(['qemu-system-x86_64']) });
    assert.equal(runner._probeExecutable('qemu-system-x86_64'), true);
    assert.equal(runner._probeExecutable('nope'), false);
  });

  test('a throwing spawnSync is swallowed → false (never crashes a boot)', () => {
    const runner = new KhyOsRunner({
      isoPath: ISO,
      spawnSync: () => { throw new Error('EACCES'); },
    });
    assert.equal(runner._probeExecutable('whatever'), false);
  });
});
