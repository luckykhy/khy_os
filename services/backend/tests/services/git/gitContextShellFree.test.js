'use strict';
const cp = require('child_process');
const path = require('path');
const SERVICE_PATH = require.resolve('../../../src/services/gitContextService');
const REPO_ROOT = path.resolve(__dirname, '../../../../..'); // Khy-OS repo root (a real git repo)
// 用干净�?require 缓存重新加载 gitContextService,让其在模块顶�?
// `const { execSync, spawnSync } = require('child_process')` 捕获到我们的 spy�?
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

describe('Git Context Shell Free', () => {
  test('ON: uses shell-free spawnSync(git, argv), no execSync git strings', () => {
      const prev = process.env.KHY_GIT_SHELL_FREE;
      process.env.KHY_GIT_SHELL_FREE = '1';
      try {
        _withSpies((calls) => {
          const svc = _freshService();
          const ctx = svc.collectGitContext(REPO_ROOT, { force: true });
          expect(ctx.isGitRepo).toBe(true, 'repo root should be detected as a git repo');
          expect(calls.spawnSyncGit.length >= 4).toBeTruthy();
          expect(calls.execSyncGit.length).toBe(0, 'no execSync git strings when shell-free is on');
          // argv 应是数组形�?�?shell 中介)
          expect(Array.isArray(calls.spawnSyncGit[0]).toBeTruthy());
          expect(calls.spawnSyncGit[0]).toEqual(['rev-parse', '--show-toplevel']);
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
          expect(ctx.isGitRepo).toBe(true);
          expect(calls.spawnSyncGit.length).toBe(0, 'no spawnSync git when gate off');
          expect(calls.execSyncGit.length >= 4).toBeTruthy();
          expect(calls.execSyncGit[0].startsWith('git rev-parse --show-toplevel').toBeTruthy());
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
        // branch / mainBranch / isDirty / isGitRepo 必须一�?同一仓库、同一时刻)�?
        expect(on.isGitRepo).toBe(off.isGitRepo);
        expect(on.branch).toBe(off.branch);
        expect(on.mainBranch).toBe(off.mainBranch);
        expect(on.isDirty).toBe(off.isDirty);
      } finally {
        if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
        delete require.cache[SERVICE_PATH]; // 还原正常单例给后续测�?
      }
  });

});

