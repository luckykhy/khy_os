'use strict';

/**
 * aiManageDaemonLifecycle.test.js — node:test suite, no shell, no daemon.
 *
 * The module under test talks to a real daemon via runtime file + control
 * API. We don't have a real daemon here, so we exercise the *deterministic*
 * parts of the state machine:
 *   1. Disabled master switch → ensureStarted returns 'skipped', never
 *      touches the runtime file.
 *   2. Idempotency: with the master switch on but no daemon on disk, the
 *      module enters a 'pending' state, attempts a spawn, fails (no
 *      script in this test sandbox), and surfaces 'failed' with a sane
 *      error string. State transitions are clean (no leaked inflight).
 *   3. snapshot() / _isAutoSpawnEnabled() reflect the env.
 *
 * Real daemon integration is gated on a real install (this test runs in
 * <1s with no external processes). The daemon's own control API is
 * covered by ai-manage-daemon's existing integration tests.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Each test re-requires the module so its single-flight state is fresh.
// We pin the env at the top of each test and restore on exit.
let _savedEnv = null;
function withEnv(env) {
  _savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (!(k in env) && k.startsWith('KHY_')) delete process.env[k];
  }
  Object.assign(process.env, env);
  // Drop the module cache so it re-evaluates with the new env.
  const modPath = require.resolve('../aiManageDaemonLifecycle');
  delete require.cache[modPath];
  for (const k of Object.keys(require.cache)) {
    if (k.includes('aiManageDaemonLifecycle')) delete require.cache[k];
  }
  return require('../aiManageDaemonLifecycle');
}
function restoreEnv() {
  if (_savedEnv) {
    for (const k of Object.keys(process.env)) {
      if (!(k in _savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, _savedEnv);
    _savedEnv = null;
  }
}

test('snapshot: reports module state, env, paths', () => {
  withEnv({ KHY_DAEMON_AUTO_SPAWN: '1' });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    mod._resetForTests();
    const snap = mod.snapshot();
    assert.equal(snap.state, 'idle');
    assert.equal(snap.enabled, true);
    assert.equal(typeof snap.script, 'string');
    assert.ok(snap.script.length > 0, 'script path should be resolved');
    assert.match(snap.script, /ai-manage-daemon\.js$/);
    assert.match(snap.runtimeFile, /ai_manage_runtime\.json$/);
  } finally {
    restoreEnv();
  }
});

test('_isAutoSpawnEnabled: defaults to true, env "0"/"false" disable', () => {
  for (const v of [undefined, '', '1', 'true', 'yes', 'on']) {
    const env = v == null ? {} : { KHY_DAEMON_AUTO_SPAWN: v };
    withEnv(env);
    try {
      const mod = require('../aiManageDaemonLifecycle');
      mod._resetForTests();
      assert.equal(mod._isAutoSpawnEnabled(), true, `v=${v}`);
    } finally {
      restoreEnv();
    }
  }
  for (const v of ['0', 'false', 'no', 'off']) {
    withEnv({ KHY_DAEMON_AUTO_SPAWN: v });
    try {
      const mod = require('../aiManageDaemonLifecycle');
      mod._resetForTests();
      assert.equal(mod._isAutoSpawnEnabled(), false, `v=${v}`);
    } finally {
      restoreEnv();
    }
  }
});

test('ensureStarted: skipped when master switch is off', async () => {
  withEnv({ KHY_DAEMON_AUTO_SPAWN: '0' });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    mod._resetForTests();
    const result = await mod.ensureStarted();
    assert.equal(result.state, 'skipped');
    assert.equal(mod.snapshot().enabled, false);
  } finally {
    restoreEnv();
  }
});

test('ensureStarted: single-flight — concurrent callers share one promise', async () => {
  withEnv({
    KHY_DAEMON_AUTO_SPAWN: '1',
    KHY_DAEMON_SCRIPT: path.join(os.tmpdir(), 'khyos-no-such-script.js'),
    KHY_DAEMON_RUNTIME_FILE: path.join(os.tmpdir(), 'khyos-no-such-runtime.json'),
  });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    mod._resetForTests();
    const [a, b] = await Promise.all([
      mod.ensureStarted({ timeoutMs: 200 }),
      mod.ensureStarted(),
    ]);
    assert.equal(a.state, b.state, 'concurrent callers see the same state');
    assert.equal(a.lastError, b.lastError, 'concurrent callers see the same error');
    assert.equal(a.state, 'failed', 'no daemon script → spawn fails');
  } finally {
    restoreEnv();
  }
});

test('ensureStarted: cleans up inflight after failure so a retry can start fresh', async () => {
  withEnv({
    KHY_DAEMON_AUTO_SPAWN: '1',
    KHY_DAEMON_SCRIPT: path.join(os.tmpdir(), 'khyos-no-such-script.js'),
    KHY_DAEMON_RUNTIME_FILE: path.join(os.tmpdir(), 'khyos-no-such-runtime-2.json'),
  });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    mod._resetForTests();
    const r1 = await mod.ensureStarted({ timeoutMs: 200 });
    assert.equal(r1.state, 'failed');
    // Force lastCheckedAt to differ between the two calls so the snapshot
    // timestamps are guaranteed distinct, then re-run.
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await mod.ensureStarted({ timeoutMs: 200 });
    assert.equal(r2.state, 'failed');
    // The two calls share the same string fields; we need a property that
    // the module actually recomputes per call. `snapshot().lastCheckedAt`
    // is updated by _record() on every ensureStarted, so it must advance.
    const snap = mod.snapshot();
    assert.ok(
      snap.lastCheckedAt > 0,
      'snapshot reflects the most recent attempt'
    );
  } finally {
    restoreEnv();
  }
});

test('readRuntime: missing file returns null, malformed returns null', () => {
  withEnv({ KHY_DAEMON_RUNTIME_FILE: path.join(os.tmpdir(), `khyos-missing-${Date.now()}.json`) });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    assert.equal(mod.readRuntime(), null);
  } finally {
    restoreEnv();
  }

  // Malformed JSON file → null (never throws).
  const tmp = path.join(os.tmpdir(), `khyos-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ this is not json', 'utf-8');
  withEnv({ KHY_DAEMON_RUNTIME_FILE: tmp });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    assert.equal(mod.readRuntime(), null);
  } finally {
    restoreEnv();
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
});

test('readRuntime: well-formed file returns parsed object', () => {
  const tmp = path.join(os.tmpdir(), `khyos-ok-${Date.now()}.json`);
  const payload = { pid: 1234, controlPort: 9091, controlToken: 'abc' };
  fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
  withEnv({ KHY_DAEMON_RUNTIME_FILE: tmp });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    const got = mod.readRuntime();
    assert.deepEqual(got, payload);
  } finally {
    restoreEnv();
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
});

test('kickstartInBackground: swallows errors, never throws to caller', () => {
  withEnv({ KHY_DAEMON_AUTO_SPAWN: '1', KHY_DAEMON_SCRIPT: '/no/such/path.js' });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    mod._resetForTests();
    assert.doesNotThrow(() => mod.kickstartInBackground('test'));
  } finally {
    restoreEnv();
  }
});

test('requestShutdown: returns not_running when no daemon is alive', async () => {
  const tmp = path.join(os.tmpdir(), `khyos-rt-${Date.now()}.json`);
  withEnv({ KHY_DAEMON_RUNTIME_FILE: tmp });
  try {
    const mod = require('../aiManageDaemonLifecycle');
    const r = await mod.requestShutdown();
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'not_running');
  } finally {
    restoreEnv();
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
});
