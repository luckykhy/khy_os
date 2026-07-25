'use strict';

/**
 * Integration test for KhyOsRunner.start()'s spawn-failure path.
 *
 * When QEMU is not installed, spawn() fails asynchronously with ENOENT on the
 * child process 'error' event. The bug this guards against: start() used to plow
 * on into _connectWithRetry(), grinding through all 60 retries against a serial
 * port that can never come up, then rejecting with a MISLEADING
 * "could not connect to KHY OS serial port ... after 60 attempts" error that
 * buried the real cause ("QEMU not found — install QEMU").
 *
 * These use a real (un-mocked) spawn of a guaranteed-missing executable so the
 * actual async-ENOENT control flow is exercised. No network, no real QEMU, and
 * the bogus binary never runs. An explicit `qemu` path keeps _ensureRuntimeQemu
 * from probing/provisioning so the spawn is reached deterministically.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const RUNNER_PATH = path.resolve(
  __dirname, '..', '..', '..',
  'platform', 'packages', 'shared', 'src', 'runtime', 'khyos', 'KhyOsRunner',
);
const { KhyOsRunner } = require(RUNNER_PATH);

const ISO = '/tmp/fake-khy-os.iso';
// A path that cannot exist on any host → spawn ENOENT, deterministically.
const MISSING_QEMU = path.join('/nonexistent-khyos', 'qemu-system-x86_64-DOES-NOT-EXIST');

describe('KhyOsRunner.start() — QEMU spawn failure', () => {
  test('rejects with the actionable "install QEMU" cause, not the serial timeout', async () => {
    const runner = new KhyOsRunner({ isoPath: ISO, qemu: MISSING_QEMU });

    let err;
    try {
      await runner.start();
      assert.fail('start() should have rejected when QEMU is missing');
    } catch (e) {
      err = e;
    }

    // The real cause is surfaced…
    assert.match(err.message, /not found — install QEMU to run KHY OS/);
    assert.match(err.message, /KHY_QEMU/);
    // …with an actionable, platform-specific install hint (no dead end).
    if (process.platform === 'win32') {
      // qemu is pinned EXPLICITLY here (and no portable QEMU is pinned), so
      // auto-download is not armed — the hint must give the install + PATH path
      // and must NOT falsely promise a download that will never be attempted.
      assert.match(err.message, /add it to PATH/);
      assert.doesNotMatch(err.message, /auto-download/i);
    } else if (process.platform === 'darwin') {
      assert.match(err.message, /brew install qemu/);
    } else {
      assert.match(err.message, /apt-get install qemu-system-x86/);
    }
    // …and the misleading secondary error is gone.
    assert.doesNotMatch(err.message, /could not connect to KHY OS serial port/);
    assert.doesNotMatch(err.message, /after \d+ attempts/);

    assert.equal(runner.running, false);
    try { await runner.stop(); } catch { /* ignore */ }
  });

  test('does NOT emit a duplicate \'error\' event during startup (single report)', async () => {
    const runner = new KhyOsRunner({ isoPath: ISO, qemu: MISSING_QEMU });

    const emitted = [];
    runner.on('error', (e) => emitted.push(e));

    await assert.rejects(() => runner.start(), /install QEMU/);

    // The spawn failure is routed through the start() rejection only — emitting it
    // too would make callers (CLI/web) that surface BOTH channels report it twice.
    assert.equal(emitted.length, 0, 'spawn failure must not also fire the error event');
    try { await runner.stop(); } catch { /* ignore */ }
  });

  test('bails fast — well under the full 60-retry serial backoff', async () => {
    // 60 retries × 50ms ≈ 3s of doomed connects was the old worst case. The
    // short-circuit should reject in a small fraction of that. Generous bound to
    // stay non-flaky on slow CI while still proving we no longer grind all retries.
    const runner = new KhyOsRunner({ isoPath: ISO, qemu: MISSING_QEMU });
    const t0 = Date.now();
    await assert.rejects(() => runner.start(), /install QEMU/);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `expected fast bail, took ${elapsed}ms`);
    try { await runner.stop(); } catch { /* ignore */ }
  });
});
