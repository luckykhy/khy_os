'use strict';

// workspaceGitInit._defaultRunner 无 shell 派生传输测试。
//
// ensureWorkspaceRepo 在 repl.js 的启动阻塞路径上每次都跑 `rev-parse --show-toplevel`。
// 该 runner 历史用 execSync(带 shell → Windows cmd.exe → git 两进程);现默认改走
// spawnSync(git, argv)(单进程),门控 KHY_GIT_SHELL_FREE,含 shell 元字符 / 门关时逐字节
// 回退 execSync。本测试镜像 gitContextShellFree.test.js:验证 ON 走 spawnSync 无 execSync、
// OFF 逐字节回退、两者对同一仓库的探测结果一致。

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const path = require('path');

const MODULE_PATH = require.resolve('../../../src/services/workspaceGitInit');
const DETECTOR_PATH = require.resolve('../../../src/services/gitExecutableDetector');
const REPO_ROOT = path.resolve(__dirname, '../../../../..'); // Khy-OS 仓库根(真实 git 仓库)

// 用干净的 require 缓存重新加载 workspaceGitInit,让其模块顶部
// `const { execSync, spawnSync } = require('child_process')` 捕获到我们的 spy。
function _freshModule() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

function _withSpies(fn) {
  const realSpawnSync = cp.spawnSync;
  const realExecSync = cp.execSync;
  const calls = { spawnSyncGit: [], execSyncGit: [] };
  cp.spawnSync = function (file, args, opts) {
    // detector 与 _defaultRunner 都派生 git(detector 用 `git --version`);记录 argv。
    if (typeof file === 'string' && /git(\.exe)?$/i.test(file)) calls.spawnSyncGit.push(args);
    return realSpawnSync.call(cp, file, args, opts);
  };
  cp.execSync = function (command, opts) {
    // _defaultRunner 回退路径形如 `"git" rev-parse --show-toplevel`。
    if (typeof command === 'string' && /(^|["\s])git["\s]/.test(command) && command.includes('rev-parse')) {
      calls.execSyncGit.push(command);
    }
    return realExecSync.call(cp, command, opts);
  };
  try {
    return fn(calls);
  } finally {
    cp.spawnSync = realSpawnSync;
    cp.execSync = realExecSync;
  }
}

const _argvSeen = (calls, argv) =>
  calls.spawnSyncGit.some(
    (a) => Array.isArray(a) && a.length === argv.length && a.every((x, i) => x === argv[i])
  );

const _clearDetector = () => {
  try { require(DETECTOR_PATH).clearCache(); } catch { /* best-effort */ }
};

test('ON: _defaultRunner uses shell-free spawnSync(git, argv), no execSync git string', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  process.env.KHY_GIT_SHELL_FREE = '1';
  try {
    _clearDetector();
    _withSpies((calls) => {
      const mod = _freshModule();
      // 无注入 runner → 走 _defaultRunner。
      const out = mod._git('rev-parse --show-toplevel', REPO_ROOT);
      assert.ok(out && out.length > 0, 'rev-parse should return the repo top-level');
      assert.ok(_argvSeen(calls, ['rev-parse', '--show-toplevel']),
        'shell-free rev-parse argv should appear on spawnSync');
      assert.strictEqual(calls.execSyncGit.length, 0,
        'no execSync git rev-parse string when shell-free is on');
    });
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
    delete require.cache[MODULE_PATH];
  }
});

test('OFF: byte-reverts to execSync git string, no shell-free rev-parse argv', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  process.env.KHY_GIT_SHELL_FREE = 'off';
  try {
    _clearDetector();
    _withSpies((calls) => {
      const mod = _freshModule();
      const out = mod._git('rev-parse --show-toplevel', REPO_ROOT);
      assert.ok(out && out.length > 0);
      assert.ok(!_argvSeen(calls, ['rev-parse', '--show-toplevel']),
        'no shell-free rev-parse argv when gate off');
      assert.ok(calls.execSyncGit.length >= 1,
        'execSync git rev-parse string used when gate off');
    });
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
    delete require.cache[MODULE_PATH];
  }
});

test('parity: ON and OFF detect the same repo top-level', () => {
  const prev = process.env.KHY_GIT_SHELL_FREE;
  const run = (val) => {
    process.env.KHY_GIT_SHELL_FREE = val;
    _clearDetector();
    const mod = _freshModule();
    return mod._git('rev-parse --show-toplevel', REPO_ROOT);
  };
  try {
    assert.strictEqual(run('1'), run('off'));
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
    delete require.cache[MODULE_PATH];
  }
});

test('quoted commands (config value / commit message) fall back to execSync', () => {
  // 含单/双引号 → toGitArgv 返回 null → 逐字节 execSync 回退(不误分词)。
  const prev = process.env.KHY_GIT_SHELL_FREE;
  process.env.KHY_GIT_SHELL_FREE = '1';
  try {
    _clearDetector();
    const plan = require('../../../src/services/gitSpawnPlan');
    // 直接断言分词判定:带引号的命令无法安全分词。
    assert.strictEqual(plan.toGitArgv("config user.name 'Khy OS'"), null);
    assert.strictEqual(plan.toGitArgv('commit -m "initial commit"'), null);
    // 而热路径命令可安全分词(走无 shell)。
    assert.deepStrictEqual(plan.toGitArgv('rev-parse --show-toplevel'), ['rev-parse', '--show-toplevel']);
    assert.deepStrictEqual(plan.toGitArgv('add -A'), ['add', '-A']);
    assert.deepStrictEqual(plan.toGitArgv('branch -M main'), ['branch', '-M', 'main']);
  } finally {
    if (prev === undefined) delete process.env.KHY_GIT_SHELL_FREE; else process.env.KHY_GIT_SHELL_FREE = prev;
  }
});
