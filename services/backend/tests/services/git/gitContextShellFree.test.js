'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const path = require('path');

const SERVICE_PATH = require.resolve('../../../src/services/gitContextService');
const REPO_ROOT = path.resolve(__dirname, '../../../../..'); // Khy-OS repo root (a real git repo)

// 用干净的 require 缓存重新加载 gitContextService,让其在模块顶部
// `const { execSync, spawnSync } = require('child_process')` 捕获到我们的 spy。
function _freshService() {
  delete require.cache[SERVICE_PATH];
  return require(SERVICE_PATH);
}

function _withSpies(fn) {
  const realSpawnSync = cp.spawnSync;
  const realExecSync = cp.execSync;
  const calls = { spawnSyncGit: [], execSyncGit: [] };
  cp.spawnSync = function (file, args, opts) {
    if (file === 'git') calls.spawnSyncGit.push(args);
    return realSpawnSync.call(cp, file, args, opts);
  };
  cp.execSync = function (command, opts) {
    if (typeof command === 'string' && command.startsWith('git ')) calls.execSyncGit.push(command);
    return realExecSync.call(cp, command, opts);
  };
  try {
    return fn(calls);
  } finally {
    cp.spawnSync = realSpawnSync;
    cp.execSync = realExecSync;
  }
}

test('ON: uses shell-free spawnSync(git, argv), no execSync git strings', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  process.env.KHY_GIT_SHELL_FREE = '1';
  try {
    _withSpies((calls) => {
      const svc = _freshService();
      const ctx = svc.collectGitContext(REPO_ROOT, { force: true });
      assert.strictEqual(ctx.isGitRepo, true, 'repo root should be detected as a git repo');
      assert.ok(calls.spawnSyncGit.length >= 4, `expected several spawnSync git calls, got ${calls.spawnSyncGit.length}`);
      assert.strictEqual(calls.execSyncGit.length, 0, 'no execSync git strings when shell-free is on');
      // argv 应是数组形态(无 shell 中介)
      assert.ok(Array.isArray(calls.spawnSyncGit[0]));
      assert.deepStrictEqual(calls.spawnSyncGit[0], ['rev-parse', '--show-toplevel']);
    });
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
  }
});

test('OFF: byte-reverts to execSync git strings, no spawnSync git', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  process.env.KHY_GIT_SHELL_FREE = 'off';
  try {
    _withSpies((calls) => {
      const svc = _freshService();
      const ctx = svc.collectGitContext(REPO_ROOT, { force: true });
      assert.strictEqual(ctx.isGitRepo, true);
      assert.strictEqual(calls.spawnSyncGit.length, 0, 'no spawnSync git when gate off');
      assert.ok(calls.execSyncGit.length >= 4, `expected execSync git strings, got ${calls.execSyncGit.length}`);
      assert.ok(calls.execSyncGit[0].startsWith('git rev-parse --show-toplevel'));
    });
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
  }
});

test('parity: ON and OFF produce identical context fields', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  const collect = (val) => {
    process.env.KHY_GIT_SHELL_FREE = val;
    const svc = _freshService();
    return svc.collectGitContext(REPO_ROOT, { force: true });
  };
  try {
    const on = collect('1');
    const off = collect('off');
    // branch / mainBranch / isDirty / isGitRepo 必须一致(同一仓库、同一时刻)。
    assert.strictEqual(on.isGitRepo, off.isGitRepo);
    assert.strictEqual(on.branch, off.branch);
    assert.strictEqual(on.mainBranch, off.mainBranch);
    assert.strictEqual(on.isDirty, off.isDirty);
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
    delete require.cache[SERVICE_PATH]; // 还原正常单例给后续测试
  }
});
