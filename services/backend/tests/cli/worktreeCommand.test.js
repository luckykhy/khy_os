/**
 * Unit tests for the `/worktree` main-REPL dispatcher.
 *
 * The dispatcher delegates all git work to `worktreeManager` and is fully
 * dependency-injected, so these tests mock that manager plus the cwd-bookkeeping
 * surface (env / chdir / onCwdChange) and assert the DUAL cwd source stays in sync
 * on every enter/exit. No real git repo is touched.
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  runWorktreeCommand,
  __resetForTest,
  __stateForTest,
} = require('../../src/cli/repl/worktreeCommand');

// Build a fresh set of injectable deps + capture surfaces for a single case.
function makeHarness(overrides = {}) {
  const calls = [];
  const out = {
    info: (m) => calls.push(['info', m]),
    success: (m) => calls.push(['success', m]),
    warn: (m) => calls.push(['warn', m]),
    error: (m) => calls.push(['error', m]),
  };
  const env = { KHYQUANT_CWD: '/repo/root' };
  const chdirTargets = [];
  const cwdChanges = [];

  const wm = {
    getGitRoot: () => '/repo/root',
    isInsideWorktree: () => false,
    createWorktree: () => ({
      name: 'demo',
      branch: 'khy-worktree/demo',
      path: '/repo/root/.khy/worktrees/demo',
    }),
    removeWorktree: () => ({ removed: true }),
    keepWorktree: () => ({ kept: true }),
    listWorktrees: () => [],
    ...(overrides.worktreeManager || {}),
  };

  const deps = {
    worktreeManager: wm,
    env,
    chdir: (d) => chdirTargets.push(d),
    cwd: () => env.KHYQUANT_CWD || '/repo/root',
    out,
    onCwdChange: (d) => cwdChanges.push(d),
  };

  return { deps, env, calls, chdirTargets, cwdChanges, wm };
}

function statuses(calls, kind) {
  return calls.filter(([k]) => k === kind).map(([, m]) => m);
}

beforeEach(() => __resetForTest());

test('enter: 创建 worktree 并双向同步 cwd（KHYQUANT_CWD + chdir + onCwdChange），保存返回根', async () => {
  const h = makeHarness();
  const res = await runWorktreeCommand('enter demo', h.deps);

  assert.strictEqual(res.status, 'entered');
  assert.strictEqual(res.path, '/repo/root/.khy/worktrees/demo');
  // Both cwd sources switched to the worktree path.
  assert.strictEqual(h.env.KHYQUANT_CWD, '/repo/root/.khy/worktrees/demo');
  assert.deepStrictEqual(h.chdirTargets, ['/repo/root/.khy/worktrees/demo']);
  assert.deepStrictEqual(h.cwdChanges, ['/repo/root/.khy/worktrees/demo']);
  // Return root captured for a later exit.
  assert.strictEqual(__stateForTest().returnCwd, '/repo/root');
});

test('enter: 非 git 仓库 → 友好降级，不切 cwd', async () => {
  const h = makeHarness({ worktreeManager: { getGitRoot: () => null } });
  const res = await runWorktreeCommand('enter', h.deps);

  assert.strictEqual(res.status, 'not-git');
  assert.strictEqual(h.env.KHYQUANT_CWD, '/repo/root');
  assert.deepStrictEqual(h.chdirTargets, []);
  assert.ok(statuses(h.calls, 'warn').length >= 1);
});

test('enter: 已在隔离工作区内 → 拒绝再开', async () => {
  const h = makeHarness({ worktreeManager: { isInsideWorktree: () => true } });
  const res = await runWorktreeCommand('enter', h.deps);

  assert.strictEqual(res.status, 'already-inside');
  assert.deepStrictEqual(h.chdirTargets, []);
});

test('enter: createWorktree 抛错 → 转友好错误，不崩', async () => {
  const h = makeHarness({
    worktreeManager: {
      createWorktree: () => { throw new Error('boom'); },
    },
  });
  const res = await runWorktreeCommand('enter', h.deps);

  assert.strictEqual(res.status, 'error');
  assert.match(res.error, /boom/);
  assert.ok(statuses(h.calls, 'error').length >= 1);
});

test('exit keep: 保留 worktree 并还原到进入前的根（双向同步）', async () => {
  // First enter to populate _returnCwd, then exit.
  const enter = makeHarness();
  await runWorktreeCommand('enter demo', enter.deps);

  // Simulate the session now sitting inside the worktree.
  const h = makeHarness({
    worktreeManager: {
      isInsideWorktree: () => true,
      keepWorktree: () => ({ kept: true }),
    },
  });
  h.env.KHYQUANT_CWD = '/repo/root/.khy/worktrees/demo';
  const res = await runWorktreeCommand('exit keep', h.deps);

  assert.strictEqual(res.status, 'kept');
  assert.strictEqual(res.returnedTo, '/repo/root');
  // Restored both cwd sources to the saved return root.
  assert.strictEqual(h.env.KHYQUANT_CWD, '/repo/root');
  assert.deepStrictEqual(h.chdirTargets, ['/repo/root']);
  assert.deepStrictEqual(h.cwdChanges, ['/repo/root']);
  // Return root cleared after exit.
  assert.strictEqual(__stateForTest().returnCwd, null);
});

test('exit remove: 有未提交改动且未 --force → 阻止删除，cwd 不变', async () => {
  await runWorktreeCommand('enter demo', makeHarness().deps);

  const h = makeHarness({
    worktreeManager: {
      isInsideWorktree: () => true,
      removeWorktree: () => ({ removed: false, uncommittedChanges: ['a.txt'] }),
    },
  });
  h.env.KHYQUANT_CWD = '/repo/root/.khy/worktrees/demo';
  const res = await runWorktreeCommand('exit remove', h.deps);

  assert.strictEqual(res.status, 'blocked');
  assert.deepStrictEqual(res.uncommittedChanges, ['a.txt']);
  // Still inside the worktree — no cwd restore happened.
  assert.strictEqual(h.env.KHYQUANT_CWD, '/repo/root/.khy/worktrees/demo');
  assert.deepStrictEqual(h.chdirTargets, []);
});

test('exit remove --force: 强制删除并还原 cwd', async () => {
  await runWorktreeCommand('enter demo', makeHarness().deps);

  let forceSeen = null;
  const h = makeHarness({
    worktreeManager: {
      isInsideWorktree: () => true,
      removeWorktree: (_p, opts) => { forceSeen = opts.force; return { removed: true }; },
    },
  });
  h.env.KHYQUANT_CWD = '/repo/root/.khy/worktrees/demo';
  const res = await runWorktreeCommand('exit remove --force', h.deps);

  assert.strictEqual(res.status, 'removed');
  assert.strictEqual(forceSeen, true);
  assert.strictEqual(res.returnedTo, '/repo/root');
  assert.strictEqual(h.env.KHYQUANT_CWD, '/repo/root');
  assert.deepStrictEqual(h.chdirTargets, ['/repo/root']);
});

test('exit: 当前不在隔离工作区 → 友好提示', async () => {
  const h = makeHarness({ worktreeManager: { isInsideWorktree: () => false } });
  const res = await runWorktreeCommand('exit', h.deps);

  assert.strictEqual(res.status, 'not-in-worktree');
  assert.deepStrictEqual(h.chdirTargets, []);
});

test('list: 透传 worktreeManager.listWorktrees', async () => {
  const h = makeHarness({
    worktreeManager: {
      listWorktrees: () => [
        { path: '/repo/root/.khy/worktrees/a', branch: 'khy-worktree/a' },
      ],
    },
  });
  const res = await runWorktreeCommand('list', h.deps);

  assert.strictEqual(res.status, 'list');
  assert.strictEqual(res.items.length, 1);
});

test('status: 报告是否在隔离工作区及当前路径', async () => {
  const h = makeHarness({ worktreeManager: { isInsideWorktree: () => true } });
  h.env.KHYQUANT_CWD = '/repo/root/.khy/worktrees/demo';
  const res = await runWorktreeCommand('status', h.deps);

  assert.strictEqual(res.status, 'status');
  assert.strictEqual(res.inside, true);
  assert.strictEqual(res.path, '/repo/root/.khy/worktrees/demo');
});

test('bare / 未知子命令 → 用法', async () => {
  const h1 = makeHarness();
  assert.strictEqual((await runWorktreeCommand('', h1.deps)).status, 'usage');

  const h2 = makeHarness();
  assert.strictEqual((await runWorktreeCommand('frobnicate', h2.deps)).status, 'usage');
});
