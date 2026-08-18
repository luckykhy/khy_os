'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const coordinator = require('../src/services/updateCoordinator');

function gitFixture(overrides = {}) {
  const values = {
    'rev-parse --show-toplevel': 'C:/repo',
    'rev-parse HEAD': 'aaa',
    'symbolic-ref --short -q HEAD': 'main',
    'fetch --prune': '',
    'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': 'origin/main',
    'status --porcelain -uall': '',
    'rev-list --left-right --count HEAD...origin/main': '0 1',
    'rev-parse origin/main': 'bbb',
    ...overrides,
  };
  const calls = [];
  return {
    calls,
    run(args) {
      const key = args.join(' ');
      calls.push(key);
      if (!(key in values)) throw new Error(`unexpected git: ${key}`);
      const value = values[key];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function sourceFs() {
  return {
    existsSync(file) {
      return /services[\\/]backend[\\/]package\.json$/.test(file);
    },
    readFileSync(file) {
      if (/package\.json$/.test(file)) return '{"version":"1.1.10"}';
      throw new Error('not portable');
    },
  };
}

beforeEach(() => coordinator._resetForTests());

describe('updateCoordinator', () => {
  test('normalizes channels and defaults invalid input to stable', () => {
    assert.equal(coordinator.normalizeChannel('PREVIEW'), 'preview');
    assert.equal(coordinator.normalizeChannel('unknown'), 'stable');
  });

  test('detects a source checkout and compares commits after fetch', async () => {
    const git = gitFixture();
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo/services/backend',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
      now: () => 100,
    });
    assert.equal(state.state, 'available');
    assert.equal(state.channel, 'dev');
    assert.equal(state.current.commit, 'aaa');
    assert.equal(state.target.commit, 'bbb');
    assert.ok(git.calls.includes('fetch --prune'));
  });

  test('dirty source checkout is blocked and never merged', async () => {
    const git = gitFixture({ 'status --porcelain -uall': ' M file.js' });
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
    });
    assert.equal(state.state, 'blocked');
    assert.equal(state.blockedReason, 'dirty-worktree');
    const applied = await coordinator.applyUpdate({ state, git: git.run, memoryOnly: true });
    assert.equal(applied.success, false);
    assert.ok(!git.calls.some(call => call.startsWith('merge ')));
  });

  test('staged git update rechecks and applies the exact fast-forward target', async () => {
    const git = gitFixture({ 'merge --ff-only bbb': '' });
    const available = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
    });
    const staged = await coordinator.stageUpdate({ state: available, memoryOnly: true });
    assert.equal(staged.state, 'staged');
    const applied = await coordinator.applyUpdate({ state: staged, git: git.run, memoryOnly: true });
    assert.equal(applied.state, 'applied');
    assert.equal(applied.pendingRestart, true);
    assert.equal(applied.appliedProcessId, process.pid);
    assert.ok(git.calls.includes('merge --ff-only bbb'));
  });

  test('confirms a pending restart when the running commit matches', async () => {
    const git = gitFixture({ 'rev-parse origin/main': 'bbb' });
    coordinator.writeState(coordinator.blankState({
      state: 'applied',
      channel: 'dev',
      pendingRestart: true,
      target: { version: '1.1.10', commit: 'aaa' },
      checkedAt: 1,
    }), { memoryOnly: true });
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
      now: () => 100,
      migrations: { runMigrations: async () => ({ ran: [], skipped: [] }) },
      integrity: {
        rebuildAndVerify: () => ({ verification: { verified: true } }),
      },
    });
    assert.equal(state.pendingRestart, false);
    assert.equal(state.lastApplied.target.commit, 'aaa');
    assert.equal(state.current.commit, 'aaa');
  });

  test('does not confirm restart inside the process that applied the update', async () => {
    const git = gitFixture();
    coordinator.writeState(coordinator.blankState({
      state: 'applied',
      channel: 'dev',
      pendingRestart: true,
      appliedProcessId: process.pid,
      target: { version: '1.1.10', commit: 'aaa' },
      checkedAt: 1,
    }), { memoryOnly: true });
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
      now: () => 100,
    });
    assert.equal(state.pendingRestart, true);
    assert.equal(state.appliedProcessId, process.pid);
    assert.equal(state.lastApplied, null);
  });

  test('keeps a pending restart when the running commit differs', async () => {
    const git = gitFixture();
    coordinator.writeState(coordinator.blankState({
      state: 'applied',
      channel: 'dev',
      pendingRestart: true,
      target: { version: '1.1.10', commit: 'bbb' },
    }), { memoryOnly: true });
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
      now: () => 100,
    });
    assert.equal(state.pendingRestart, true);
  });

  test('package network failure is indeterminate instead of up to date', async () => {
    const selfUpdate = {
      _detectInstalledPackage: () => 'khy-os',
      _readInstalledVersion: () => '1.0.0',
      _npmGlobalVersion: () => '',
      NPM_PACKAGE: '@khy-os/khy-os',
      checkUpdate: async () => ({
        success: true,
        indeterminate: true,
        current: '1.0.0',
        notice: 'offline',
      }),
    };
    const state = await coordinator.checkUpdate({
      fs: { existsSync: () => false },
      git: () => { throw new Error('not git'); },
      selfUpdate,
      exec: () => '',
      force: true,
      memoryOnly: true,
    });
    assert.equal(state.state, 'idle');
    assert.equal(state.indeterminate, true);
    assert.equal(state.error, 'offline');
  });

  test('post-apply migration failure marks update failed and restores integrity baseline', async () => {
    const previous = { version: 1, files: { 'old.js': 'hash' } };
    let restored = null;
    const state = coordinator.blankState({
      state: 'staged',
      source: { type: 'package', packages: null },
      target: { version: '2.0.0', commit: null },
      stagedPath: 'fixture',
    });
    const applied = await coordinator.applyUpdate({
      state,
      memoryOnly: true,
      applyPackage: async () => ({ success: true, changed: true }),
      migrations: { runMigrations: async () => ({ ran: [], skipped: ['2.0.0'] }) },
      integrity: {
        loadManifest: () => previous,
        rebuildAndVerify: () => { throw new Error('must not verify'); },
        restoreManifest: value => { restored = value; },
      },
    });
    assert.equal(applied.state, 'failed');
    assert.match(applied.error, /migrations failed/);
    assert.deepEqual(restored, previous);
  });

  test('post-apply migration and integrity success is recorded before applied', async () => {
    const state = coordinator.blankState({
      state: 'staged',
      source: { type: 'package', packages: null },
      target: { version: '2.0.0', commit: null },
      stagedPath: 'fixture',
    });
    const applied = await coordinator.applyUpdate({
      state,
      memoryOnly: true,
      applyPackage: async () => ({ success: true, changed: true }),
      migrations: { runMigrations: async () => ({ ran: ['2.0.0'], skipped: [] }) },
      integrity: {
        loadManifest: () => null,
        rebuildAndVerify: () => ({ verification: { verified: true } }),
        restoreManifest: () => {},
      },
    });
    assert.equal(applied.state, 'applied');
    assert.deepEqual(applied.result.postApply.migrations.ran, ['2.0.0']);
    assert.equal(applied.result.postApply.integrity.verified, true);
  });

  test('deferred portable post-apply failure schedules rollback before clearing restart state', async t => {
    const root = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'khy-deferred-update-'));
    const resultPath = require('path').join(root, 'swap.json');
    require('fs').writeFileSync(resultPath, JSON.stringify({ success: true }));
    t.after(() => require('fs').rmSync(root, { recursive: true, force: true }));
    const git = gitFixture({ 'rev-parse HEAD': 'bbb' });
    const prior = coordinator.blankState({
      state: 'applied',
      pendingRestart: true,
      appliedProcessId: -1,
      source: { type: 'portable', root: 'C:/old' },
      current: { version: '1.1.10', commit: 'aaa' },
      target: { version: '1.1.10', commit: 'bbb' },
      result: {
        success: true,
        deferred: true,
        detail: { resultPath, live: 'C:/live', backup: 'C:/backup' },
      },
    });
    coordinator.writeState(prior, { memoryOnly: true });
    let rollbackDetail = null;
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo',
      fs: sourceFs(),
      git: git.run,
      force: true,
      memoryOnly: true,
      migrations: { runMigrations: async () => ({ ran: [], skipped: ['2.0.0'] }) },
      integrity: { rebuildAndVerify: () => ({ verification: { verified: true } }) },
      scheduleDeferredRollback: detail => {
        rollbackDetail = detail;
        return { scheduled: true, resultPath: 'C:/rollback.json' };
      },
    });
    assert.equal(state.state, 'failed');
    assert.equal(state.pendingRestart, false);
    assert.equal(state.rollbackPendingRestart, true);
    assert.equal(state.appliedProcessId, process.pid);
    assert.equal(rollbackDetail.backup, 'C:/backup');
    assert.match(state.error, /migrations failed/);
  });

  test('failed deferred swap is recorded even when the old version remains active', async t => {
    const root = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'khy-deferred-failed-'));
    const resultPath = require('path').join(root, 'swap.json');
    require('fs').writeFileSync(resultPath, JSON.stringify({ success: false, error: 'rename denied' }));
    t.after(() => require('fs').rmSync(root, { recursive: true, force: true }));
    const git = gitFixture({ 'rev-parse HEAD': 'aaa' });
    coordinator.writeState(coordinator.blankState({
      state: 'applied',
      pendingRestart: true,
      appliedProcessId: -1,
      current: { version: '1.1.10', commit: 'aaa' },
      target: { version: '1.1.10', commit: 'bbb' },
      result: { success: true, deferred: true, detail: { resultPath } },
    }), { memoryOnly: true });
    const state = await coordinator.checkUpdate({
      cwd: 'C:/repo', fs: sourceFs(), git: git.run, force: true, memoryOnly: true,
    });
    assert.equal(state.state, 'failed');
    assert.equal(state.pendingRestart, false);
    assert.match(state.error, /rename denied/);
  });

  test('skip suppresses the same target but preserves it in state', () => {
    const skipped = coordinator.skipUpdate({
      state: coordinator.blankState({
        state: 'available',
        target: { version: '2.0.0', commit: null },
      }),
      memoryOnly: true,
    });
    assert.equal(skipped.state, 'idle');
    assert.equal(skipped.skippedTarget, '2.0.0');
  });
});
