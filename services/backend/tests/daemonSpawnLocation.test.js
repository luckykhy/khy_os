'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveDaemonSpawnLocation } = require('../src/services/daemonSpawnLocation');

const BUNDLE_ROOT = '/opt/py/site-packages/khy_os/bundled/services/backend/src';
const DATA_HOME = '/home/u/.khy';

test('win32 + gate on + valid dataHome ≠ root → cwd moves out of bundle, KHYQUANT_ROOT pinned', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
  });
  assert.strictEqual(out.cwd, DATA_HOME);
  assert.deepStrictEqual(out.envPatch, { KHYQUANT_ROOT: BUNDLE_ROOT });
});

test('non-win32 (linux) → unchanged: cwd stays root, empty envPatch', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'linux', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
  });
  assert.strictEqual(out.cwd, BUNDLE_ROOT);
  assert.deepStrictEqual(out.envPatch, {});
});

test('non-win32 (darwin) → unchanged', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'darwin', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: true,
  });
  assert.strictEqual(out.cwd, BUNDLE_ROOT);
  assert.deepStrictEqual(out.envPatch, {});
});

test('win32 + gate OFF → unchanged (escape hatch)', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome: DATA_HOME, gateEnabled: false,
  });
  assert.strictEqual(out.cwd, BUNDLE_ROOT);
  assert.deepStrictEqual(out.envPatch, {});
});

test('win32 + no dataHome (null / empty) → unchanged', () => {
  for (const dataHome of [null, '', '   ', undefined]) {
    const out = resolveDaemonSpawnLocation({
      platform: 'win32', resolvedRoot: BUNDLE_ROOT, dataHome, gateEnabled: true,
    });
    assert.strictEqual(out.cwd, BUNDLE_ROOT);
    assert.deepStrictEqual(out.envPatch, {});
  }
});

test('win32 + dataHome === resolvedRoot → unchanged (nothing to gain)', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'win32', resolvedRoot: DATA_HOME, dataHome: DATA_HOME, gateEnabled: true,
  });
  assert.strictEqual(out.cwd, DATA_HOME);
  assert.deepStrictEqual(out.envPatch, {});
});

test('junk / undefined input → does not throw, falls back to empty-root unchanged shape', () => {
  for (const bad of [undefined, null, 42, 'str', {}, { platform: 123 }]) {
    let out;
    assert.doesNotThrow(() => { out = resolveDaemonSpawnLocation(bad); });
    assert.strictEqual(typeof out.cwd, 'string');
    assert.deepStrictEqual(out.envPatch, {});
  }
});

test('win32 relocation with no resolvedRoot → moves cwd but pins nothing', () => {
  const out = resolveDaemonSpawnLocation({
    platform: 'win32', resolvedRoot: '', dataHome: DATA_HOME, gateEnabled: true,
  });
  assert.strictEqual(out.cwd, DATA_HOME);
  assert.deepStrictEqual(out.envPatch, {});
});
