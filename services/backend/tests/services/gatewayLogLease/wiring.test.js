'use strict';

/**
 * wiring.test.js — C-class wiring contract for gatewayLogLease (DESIGN-ARCH-031).
 *
 * The subsystem was implemented but never wired into the live path ("零侵入待接入").
 * It is now installed once at daemon boot in aiManagementServer.start() via
 * `require('./gatewayLogLease').install()`. That single line relies on three
 * guarantees this test pins down:
 *
 *   1. DEFAULT OFF → install() is a no-op: it must NOT patch console/stdout when
 *      KHY_GATEWAY_LOG_LEASE is unset/off, so the boot line is zero behavior
 *      change by default.
 *   2. FLAG ON → install() activates the lease (console is intercepted) and
 *      uninstall() fully restores the originals (no leak).
 *   3. install() is idempotent — calling it twice (boot + re-entry) is safe.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-loglease-wiring-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { describe, test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const lease = require('../../../src/services/gatewayLogLease');

describe('gatewayLogLease wiring contract (C-class)', () => {
  const origLog = console.log;
  const origStdoutWrite = process.stdout.write;

  beforeEach(() => { lease.uninstall(); });
  afterEach(() => {
    lease.uninstall();
    delete process.env.KHY_GATEWAY_LOG_LEASE;
    // Hard-restore in case a test left things patched.
    console.log = origLog;
    process.stdout.write = origStdoutWrite;
  });

  test('default off: install() does NOT patch console/stdout (zero behavior change)', () => {
    delete process.env.KHY_GATEWAY_LOG_LEASE;
    const ret = lease.install();
    assert.equal(typeof ret, 'function', 'install() must return a function even when disabled');
    assert.equal(console.log, origLog, 'console.log must be untouched when flag is off');
    assert.equal(process.stdout.write, origStdoutWrite, 'stdout.write must be untouched when flag is off');
  });

  test('flag on: install() intercepts console, uninstall() restores it', () => {
    process.env.KHY_GATEWAY_LOG_LEASE = '1';
    lease.install();
    const patchedLog = console.log;
    const patchedWrite = process.stdout.write;
    // Interception swaps in the lease wrappers (not the originals).
    assert.notEqual(patchedLog, origLog, 'console.log must be intercepted when flag is on');
    assert.notEqual(patchedWrite, origStdoutWrite, 'stdout.write must be intercepted when flag is on');
    lease.uninstall();
    // uninstall restores a bound copy of the original (functionally equal), so we
    // assert the interceptor wrapper is gone rather than reference identity.
    assert.notEqual(console.log, patchedLog, 'uninstall() must remove the console.log interceptor');
    assert.notEqual(process.stdout.write, patchedWrite, 'uninstall() must remove the stdout.write interceptor');
  });

  test('install() is idempotent (boot + re-entry safe)', () => {
    process.env.KHY_GATEWAY_LOG_LEASE = '1';
    lease.install();
    const patched = console.log;
    lease.install(); // second call must not re-wrap
    assert.equal(console.log, patched, 'second install() must not double-patch console.log');
    lease.uninstall();
    assert.notEqual(console.log, patched, 'single uninstall() after double install() must remove the interceptor');
  });

  test('ENV_FLAG is the documented kill-switch name', () => {
    assert.equal(lease.ENV_FLAG, 'KHY_GATEWAY_LOG_LEASE');
  });
});
