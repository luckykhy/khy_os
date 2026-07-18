'use strict';

/**
 * gitContextAsyncRefresh.test.js — 系统提示 git 上下文「stale-while-revalidate」的单测(node:test)。
 *
 * 根因:系统提示每轮注入 git 上下文,缓存(60s TTL)过期的那一轮同步跑 ~7 次 execSync git,
 * 阻塞事件循环(spinner 冻结、ESC 失灵),最坏数秒。修:门控 KHY_GIT_CONTEXT_ASYNC_REFRESH
 * (默认 on)下,过期时立即返回上一份缓存并后台非阻塞 exec 异步刷新;关 → 逐字节回退全同步采集。
 *
 * 关键不变量(确定性,不依赖计时):
 *  - 门控 on + 已有同 cwd 缓存 + 过期 → 返回**同一对象引用**(证明服务陈旧值、没跑同步采集)。
 *  - 门控 off + 同场景 → 返回**新对象**(证明跑了同步采集 = 今日行为)。
 *
 * 运行:node --test services/backend/tests/services/gitContextAsyncRefresh.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../../src/services/gitContextService');

const REPO_CWD = path.resolve(__dirname, '../../'); // services/backend — inside the Khy-OS git repo

function withGate(value, fn) {
  const saved = process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH;
  if (value === undefined) delete process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH;
  else process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH;
    else process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH = saved;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('_emptyContext:非 repo 形状固定', () => {
  const e = svc._emptyContext();
  assert.equal(e.isGitRepo, false);
  assert.equal(e.isDirty, false);
  assert.equal(e.branch, '');
  assert.equal(e.status, '');
});

test('_assembleContext:纯装配(isDirty/截断/默认 main)', () => {
  const ctx = svc._assembleContext({
    branch: 'feat/x',
    mainBranch: '',
    status: '## feat/x\n M a.js',
    recentLog: 'abc def',
    stagedDiff: '',
  });
  assert.equal(ctx.isGitRepo, true);
  assert.equal(ctx.branch, 'feat/x');
  assert.equal(ctx.mainBranch, 'main'); // 空 → 默认 main
  assert.equal(ctx.isDirty, true);      // 有非 ## 行
  // 全 ## 行 → 不脏。
  const clean = svc._assembleContext({ branch: 'm', mainBranch: 'main', status: '## main...origin/main', recentLog: '', stagedDiff: '' });
  assert.equal(clean.isDirty, false);
});

test('_assembleContext:stagedDiff 超 4000 截断', () => {
  const big = 'x'.repeat(5000);
  const ctx = svc._assembleContext({ branch: 'b', mainBranch: 'main', status: '', recentLog: '', stagedDiff: big });
  assert.ok(ctx.stagedDiff.length < 5000);
  assert.match(ctx.stagedDiff, /truncated/);
});

test('_asyncRefreshEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(withGate(undefined, () => svc._asyncRefreshEnabled()), true);
  assert.equal(withGate('off', () => svc._asyncRefreshEnabled()), false);
  assert.equal(withGate('0', () => svc._asyncRefreshEnabled()), false);
  assert.equal(withGate('false', () => svc._asyncRefreshEnabled()), false);
  assert.equal(withGate('no', () => svc._asyncRefreshEnabled()), false);
  assert.equal(withGate('on', () => svc._asyncRefreshEnabled()), true);
});

test('冷启动(同步)+ 缓存命中返回同引用', () => {
  svc.invalidateCache();
  const c1 = svc.collectGitContext(REPO_CWD);
  assert.equal(c1.isGitRepo, true);
  const c2 = svc.collectGitContext(REPO_CWD); // fresh hit
  assert.equal(c2, c1); // 同引用
});

test('门控 on:过期 → 立即返回陈旧同引用(不做同步采集)', () => {
  svc.invalidateCache();
  const cold = svc.collectGitContext(REPO_CWD);
  assert.equal(cold.isGitRepo, true);
  // ttlMs:-1 强制「过期」;门控 on → stale-while-revalidate 返回同一引用。
  const stale = withGate(undefined, () => svc.collectGitContext(REPO_CWD, { ttlMs: -1 }));
  assert.equal(stale, cold, '门控 on 应立即返回陈旧缓存同引用(非阻塞热路径)');
});

test('门控 off:过期 → 新对象(逐字节回退今日同步采集)', () => {
  svc.invalidateCache();
  const cold = svc.collectGitContext(REPO_CWD);
  const fresh = withGate('off', () => svc.collectGitContext(REPO_CWD, { ttlMs: -1 }));
  assert.notEqual(fresh, cold, '门控 off 应跑同步采集产出新对象');
  assert.equal(fresh.isGitRepo, true);
  // 形状与冷启动一致(键齐全)。
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(cold).sort());
});

test('门控 on:后台异步刷新最终更新缓存(软计时)', async () => {
  svc.invalidateCache();
  const cold = svc.collectGitContext(REPO_CWD);
  const stale = withGate(undefined, () => svc.collectGitContext(REPO_CWD, { ttlMs: -1 }));
  assert.equal(stale, cold);
  // 给后台非阻塞 git 刷新一点时间完成,随后再取应为新鲜(TTL 内)对象。
  await delay(400);
  const afterRefresh = svc.collectGitContext(REPO_CWD); // 默认 TTL,应命中刷新后的缓存
  assert.equal(afterRefresh.isGitRepo, true);
  // 刷新后缓存已更新为新对象(不再是最初的 cold 引用)。
  assert.notEqual(afterRefresh, cold, '后台刷新应已替换缓存对象');
});

test('非 git 目录 → isGitRepo:false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-nogit-'));
  try {
    svc.invalidateCache();
    const ctx = svc.collectGitContext(tmp);
    assert.equal(ctx.isGitRepo, false);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
