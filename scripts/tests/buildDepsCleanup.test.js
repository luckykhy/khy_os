'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const backendFormatBytes = require('../../services/backend/src/utils/formatBytes');

// The helper is ESM (both callers are .mjs), so it comes in through dynamic import.
const load = () => import('../lib/buildDepsCleanup.mjs');

/** A throwaway toolchain dir with a node_modules tree of known size. */
function fixture(bytes = 4096) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-builddeps-'));
  const nm = path.join(dir, 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'index.js'), 'x'.repeat(bytes));
  return dir;
}

const silent = { log: () => {}, warn: () => {} };

test('the keep switch is opt-in and only an explicit truthy word keeps the tree', async () => {
  const { shouldKeepBuildDeps } = await load();
  assert.equal(shouldKeepBuildDeps({}), false);
  assert.equal(shouldKeepBuildDeps({ KHY_KEEP_BUILD_DEPS: '' }), false);
  assert.equal(shouldKeepBuildDeps({ KHY_KEEP_BUILD_DEPS: '0' }), false);
  for (const word of ['1', 'true', 'on', 'yes', ' YES ']) {
    assert.equal(shouldKeepBuildDeps({ KHY_KEEP_BUILD_DEPS: word }), true, word);
  }
});

test('a successful build sweeps its own install tree and reports what it reclaimed', async () => {
  const { cleanBuildDeps } = await load();
  const dir = fixture(8192);
  const r = cleanBuildDeps({ dir, label: 't', rebuildCommand: 'npm run x', built: true, env: {}, ...silent });
  assert.equal(r.cleaned, true);
  assert.equal(r.reason, 'cleaned');
  assert.ok(r.reclaimedBytes >= 8192, 'reclaimed bytes must be measured before the removal, not after');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no build ran means no deletion: that tree belongs to whoever installed it', async () => {
  // The artifact-already-ready short circuit never runs a build. Deleting a
  // developer's working install on a no-op run would be a nasty surprise, so
  // this path only ever prints where to reclaim it explicitly.
  const { cleanBuildDeps } = await load();
  const dir = fixture();
  const r = cleanBuildDeps({ dir, label: 't', rebuildCommand: 'npm run x', built: false, env: {}, ...silent });
  assert.equal(r.cleaned, false);
  assert.equal(r.reason, 'no-build-ran');
  assert.equal(r.reclaimedBytes, 0);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the keep switch survives a successful build', async () => {
  const { cleanBuildDeps } = await load();
  const dir = fixture();
  const r = cleanBuildDeps({
    dir, label: 't', rebuildCommand: 'npm run x', built: true,
    env: { KHY_KEEP_BUILD_DEPS: '1' }, ...silent,
  });
  assert.equal(r.cleaned, false);
  assert.equal(r.reason, 'kept');
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an absent tree is a silent no-op, not an error', async () => {
  const { cleanBuildDeps } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-builddeps-'));
  const r = cleanBuildDeps({ dir, label: 't', rebuildCommand: 'npm run x', built: true, env: {}, ...silent });
  assert.equal(r.cleaned, false);
  assert.equal(r.reason, 'absent');
  assert.equal(r.status, '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every status line names the rebuild command, so a cleanup is always reversible', async () => {
  const { cleanBuildDeps } = await load();
  for (const built of [true, false]) {
    const dir = fixture();
    const lines = [];
    const r = cleanBuildDeps({
      dir, label: 't', rebuildCommand: 'npm run rebuild-me', built, env: {},
      log: (m) => lines.push(m), warn: (m) => lines.push(m),
    });
    assert.ok(r.status, 'a touched tree must always say something');
    assert.ok(lines.join('\n').includes('npm run rebuild-me'), 'built=' + built);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('measureTree skips a missing dir and counts files under one that exists', async () => {
  const { measureTree } = await load();
  assert.equal(measureTree(path.join(os.tmpdir(), 'khy-does-not-exist-' + process.pid)), null);
  const dir = fixture(1234);
  const m = measureTree(path.join(dir, 'node_modules'));
  assert.equal(m.files, 1);
  assert.equal(m.bytes, 1234);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatBytes agrees with the renderer the rest of the repo reports sizes through', async () => {
  // Two slimming reports quoting different numbers for the same tree is worse
  // than one report, so this helper must not grow its own byte formatting.
  const { formatBytes } = await load();
  for (const n of [0, 1, 999, 1024, 1536, 3271915, 191 * 1024 * 1024]) {
    assert.equal(formatBytes(n), backendFormatBytes(n), String(n));
  }
});
