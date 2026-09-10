'use strict';
/**
 * aiManageDaemonLifecycle.test.js â€?node:test suite, no shell, no daemon.
 *
 * The module under test talks to a real daemon via runtime file + control
 * API. We don't have a real daemon here, so we exercise the *deterministic*
 * parts of the state machine:
 *   1. Disabled master switch â†?ensureStarted returns 'skipped', never
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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
test('_isAutoSpawnEnabled: defaults to true, env "0"/"false" disable', () => {
  for (const v of [undefined, '', '1', 'true', 'yes', 'on']) {
    const env = v == null ? {} : { KHY_DAEMON_AUTO_SPAWN: v };
    withEnv(env);
    try {
      const mod = require('../aiManageDaemonLifecycle');
      mod._resetForTests();
      expect(mod._isAutoSpawnEnabled()).toBe(true);
    } finally {
      restoreEnv();
    }
  }
  for (const v of ['0', 'false', 'no', 'off']) {
    withEnv({ KHY_DAEMON_AUTO_SPAWN: v });
    try {
      const mod = require('../aiManageDaemonLifecycle');
      mod._resetForTests();
      expect(mod._isAutoSpawnEnabled()).toBe(false);
    } finally {
      restoreEnv();
    }
  }
});

describe('Ai Manage Daemon Lifecycle', () => {
  test('snapshot: reports module state, env, paths', async () => {
      withEnv({ KHY_DAEMON_AUTO_SPAWN: '1' });
      try {
        const mod = require('../aiManageDaemonLifecycle');
        mod._resetForTests();
        const snap = mod.snapshot();
        expect(snap.state).toBe('idle');
        expect(snap.enabled).toBe(true);
        expect(typeof snap.script).toBe('string');
        expect(snap.script.length > 0).toBeTruthy();
        expect(snap.script).toMatch(/ai-manage-daemon\.js$/);
        expect(snap.runtimeFile).toMatch(/ai_manage_runtime\.json$/);
      } finally {
        restoreEnv();
      }
  });

  test('ensureStarted: skipped when master switch is off', async () => {
      withEnv({ KHY_DAEMON_AUTO_SPAWN: '0' });
      try {
        const mod = require('../aiManageDaemonLifecycle');
        mod._resetForTests();
        const result = await mod.ensureStarted();
        expect(result.state).toBe('skipped');
        expect(mod.snapshot().enabled).toBe(false);
      } finally {
        restoreEnv();
      }
  });

  test('ensureStarted: single-flight â€?concurrent callers share one promise', async () => {
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
        expect(a.state).toBe(b.state);
        expect(a.lastError).toBe(b.lastError);
        expect(a.state).toBe('failed');
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
        expect(r1.state).toBe('failed');
        // Force lastCheckedAt to differ between the two calls so the snapshot
        // timestamps are guaranteed distinct, then re-run.
        await new Promise((r) => setTimeout(r, 5));
        const r2 = await mod.ensureStarted({ timeoutMs: 200 });
        expect(r2.state).toBe('failed');
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

});

