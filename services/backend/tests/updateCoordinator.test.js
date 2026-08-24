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

describe('updateCoordinator provenance', () => {
  function provenanceGit(overrides = {}) {
    const values = {
      'rev-parse --show-toplevel': 'C:/repo',
      'log -1 --format=%H%n%cI%n%D':
        'aaa\n2026-08-24T15:07:17+08:00\nHEAD -> main, origin/main, origin/HEAD',
      'status --porcelain -uno': '',
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

  function repoFs() {
    return {
      existsSync(file) {
        // 只认源码仓；.portable/BUILD-INFO.json 一律不存在，避免走便携分支
        return /services[\\/]backend[\\/]package\.json$/.test(file);
      },
      readFileSync(file) {
        if (/package\.json$/.test(file)) return '{"version":"1.1.11"}';
        throw new Error('not readable');
      },
    };
  }

  test('reads commit time and upstream from the live worktree, never over the network', () => {
    const git = provenanceGit();
    const p = coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    });
    assert.equal(p.kind, 'git');
    assert.equal(p.version, '1.1.11');
    assert.equal(p.commit, 'aaa');
    assert.equal(p.updatedAt, '2026-08-24T15:07:17+08:00');
    assert.equal(p.source, 'origin/main');
    assert.equal(p.dirty, false);
    // 启动路径绝不能 fetch：一次网络往返会把首屏卡在离线超时上
    assert.ok(!git.calls.some(call => call.startsWith('fetch')));
  });

  test('spends exactly one git spawn beyond locating the repo', () => {
    // 每次 spawn 在 Windows 上都是一次 CreateProcess，直接计入启动首屏。
    // 这条断言把「一次 git log 拿齐 SHA/时间/来源」钉成契约。
    const git = provenanceGit();
    coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    });
    assert.deepEqual(git.calls, [
      'rev-parse --show-toplevel',
      'log -1 --format=%H%n%cI%n%D',
    ]);
  });

  test('prefers a remote ref and strips HEAD aliases from the decoration', () => {
    const git = provenanceGit({
      'log -1 --format=%H%n%cI%n%D':
        'aaa\n2026-08-24T15:07:17+08:00\nHEAD -> feature/x, origin/feature/x, gitee/feature/x',
    });
    assert.equal(coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    }).source, 'origin/feature/x');
  });

  test('falls back to the local branch when no remote ref points at the commit', () => {
    // 本地领先于 origin 时装饰里没有远程引用；标 origin/main 会是谎报
    const git = provenanceGit({
      'log -1 --format=%H%n%cI%n%D': 'aaa\n2026-08-24T15:07:17+08:00\nHEAD -> main',
    });
    assert.equal(coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    }).source, 'main');
  });

  test('reports no source at all on a detached HEAD', () => {
    const git = provenanceGit({
      'log -1 --format=%H%n%cI%n%D': 'aaa\n2026-08-24T15:07:17+08:00\nHEAD',
    });
    assert.equal(coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    }).source, null);
  });

  test('skips the worktree scan unless dirtiness is explicitly requested', () => {
    // git status 要遍历工作树（本仓实测约为 git log 的两倍多），
    // 默认关闭才能让启动首屏只付一次 spawn 的代价
    const off = provenanceGit({ 'status --porcelain -uno': ' M a.js' });
    const quiet = coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: off.run, memoryOnly: true,
    });
    assert.equal(quiet.dirty, false);
    assert.ok(!off.calls.some(call => call.startsWith('status')));

    const on = provenanceGit({ 'status --porcelain -uno': ' M a.js' });
    const probed = coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: on.run, memoryOnly: true, includeDirty: true,
    });
    assert.equal(probed.dirty, true);
    // -uno：未跟踪的嵌套仓库/草稿不该让横幅永久报「有未提交改动」
    assert.ok(on.calls.includes('status --porcelain -uno'));
  });

  test('shows checkedAt only when the snapshot matches the running commit', () => {
    coordinator.writeState(coordinator.blankState({
      current: { version: '1.1.11', commit: 'aaa' },
      checkedAt: 4242,
    }), { memoryOnly: true });
    const fresh = coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: provenanceGit().run, memoryOnly: true,
    });
    assert.equal(fresh.checkedAt, 4242);
    assert.equal(fresh.stateStale, false);
  });

  test('degrades a snapshot left behind by another branch instead of trusting it', () => {
    coordinator.writeState(coordinator.blankState({
      current: { version: '1.1.0', commit: 'oldsha' },
      checkedAt: 4242,
    }), { memoryOnly: true });
    const p = coordinator.getSourceProvenance({
      cwd: 'C:/repo', fs: repoFs(), git: provenanceGit().run, memoryOnly: true,
    });
    assert.equal(p.checkedAt, null);
    assert.equal(p.stateStale, true);
    // 实时 Git 信息仍然可用——降级只丢弃不可信的检查时间
    assert.equal(p.updatedAt, '2026-08-24T15:07:17+08:00');
  });

  test('returns a blank record instead of throwing when git is unavailable', () => {
    const p = coordinator.getSourceProvenance({
      cwd: 'C:/repo',
      fs: repoFs(),
      git: () => { throw new Error('git not found'); },
      memoryOnly: true,
    });
    assert.equal(p.kind, null);
    assert.equal(p.commit, '');
    assert.equal(coordinator.formatProvenance(p), '');
  });

  test('formats time literally from the ISO string without shifting timezone', () => {
    // %cI 自带提交时区偏移；按字面截取才能与 git log 逐字对上，
    // 也让输出不随运行机器的时区漂移
    const text = coordinator.formatProvenance({
      updatedAt: '2026-08-24T15:07:17+08:00',
      source: 'origin/main',
      shortCommit: '41b074f',
    });
    assert.equal(text, '2026-08-24 15:07 · origin/main@41b074f');
  });

  test('marks uncommitted changes and tolerates missing fields', () => {
    assert.equal(
      coordinator.formatProvenance({
        updatedAt: '2026-08-24T15:07:17+08:00',
        source: 'main',
        shortCommit: 'abc1234',
        dirty: true,
      }),
      '2026-08-24 15:07 · main@abc1234（有未提交改动）'
    );
    assert.equal(coordinator.formatProvenance({ source: 'origin/main' }), 'origin/main');
    assert.equal(coordinator.formatProvenance({ updatedAt: 'not-a-date' }), '');
    assert.equal(coordinator.formatProvenance(null), '');
    assert.equal(coordinator.formatProvenance(undefined), '');
  });
});

describe('updateCoordinator provenance async', () => {
  // 与同步版同构的桩：git.run 返回同步字符串（runGitAsync 注入分支会
  // Promise.resolve 包一层并兼容 {stdout}|string）。
  function provenanceGit(overrides = {}) {
    const values = {
      'rev-parse --show-toplevel': 'C:/repo',
      'log -1 --format=%H%n%cI%n%D':
        'aaa\n2026-08-24T15:07:17+08:00\nHEAD -> main, origin/main, origin/HEAD',
      'status --porcelain -uno': '',
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

  function repoFs() {
    return {
      existsSync(file) {
        return /services[\\/]backend[\\/]package\.json$/.test(file);
      },
      readFileSync(file) {
        if (/package\.json$/.test(file)) return '{"version":"1.1.11"}';
        throw new Error('not readable');
      },
    };
  }

  test('async 版与同步版输出同形；git 命令序列一致', async () => {
    const git = provenanceGit();
    const p = await coordinator.getSourceProvenanceAsync({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    });
    assert.equal(p.kind, 'git');
    assert.equal(p.version, '1.1.11');
    assert.equal(p.commit, 'aaa');
    assert.equal(p.updatedAt, '2026-08-24T15:07:17+08:00');
    assert.equal(p.source, 'origin/main');
    assert.equal(p.dirty, false);
    assert.deepEqual(git.calls, [
      'rev-parse --show-toplevel',
      'log -1 --format=%H%n%cI%n%D',
    ]);
  });

  test('异步路径绝不抛（git 失败 → blank/空字段），供横幅 fail-soft', async () => {
    const git = provenanceGit({
      'rev-parse --show-toplevel': new Error('no git'),
    });
    const p = await coordinator.getSourceProvenanceAsync({
      cwd: 'C:/repo', fs: repoFs(), git: git.run, memoryOnly: true,
    });
    assert.equal(p.kind, null);
    assert.equal(p.commit, '');
    assert.ok(!p.updatedAt);
  });
});
