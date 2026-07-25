'use strict';

/**
 * forge.test.js — `khy forge` 处理器:用注入的 client 验证 search/clone/pull 分派与 --json。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleForge } = require('../../../src/cli/handlers/forge');

function captureStdout(fn) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = (s) => { buf += s; return true; };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = orig; })
    .then(() => buf);
}

test('forge search: 调 searchRepos 并在 --json 下输出结果', async () => {
  let calledWith = null;
  const deps = {
    searchRepos: async (o) => { calledWith = o; return {
      ok: true, platform: 'github', query: o.query,
      results: [{ fullName: 'a/b', stars: 1, language: 'JS', description: 'd', cloneUrl: 'u' }],
    }; },
  };
  const out = await captureStdout(() => handleForge('search', ['rust', 'http'], { json: true, limit: 5 }, deps));
  assert.equal(calledWith.query, 'rust http');
  assert.equal(calledWith.limit, 5);
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results[0].fullName, 'a/b');
});

test('forge search: 缺关键词 → 不调 client', async () => {
  let called = false;
  const deps = { searchRepos: async () => { called = true; return { ok: true, results: [] }; } };
  await captureStdout(() => handleForge('search', [], {}, deps));
  assert.equal(called, false);
});

test('forge clone: 透传 repo/platform/dir,--json 输出', async () => {
  let calledWith = null;
  const deps = {
    cloneRepo: async (o) => { calledWith = o; return { ok: true, url: 'https://github.com/a/b.git', dir: 'b' }; },
  };
  const out = await captureStdout(() => handleForge('clone', ['a/b'], { platform: 'github', dir: 'b', json: true }, deps));
  assert.equal(calledWith.input, 'a/b');
  assert.equal(calledWith.platform, 'github');
  assert.equal(calledWith.dir, 'b');
  assert.equal(JSON.parse(out.trim()).ok, true);
});

test('forge clone: 缺 repo → 不调 client', async () => {
  let called = false;
  const deps = { cloneRepo: async () => { called = true; return { ok: true }; } };
  await captureStdout(() => handleForge('clone', [], {}, deps));
  assert.equal(called, false);
});

test('forge recon: 透传 repo/platform/ref,--json 输出', async () => {
  let calledWith = null;
  const deps = {
    reconRepo: async (o) => { calledWith = o; return {
      ok: true, platform: 'github',
      meta: { fullName: 'a/b', stars: 9, defaultBranch: 'main' },
      tree: [{ type: 'file', name: 'README.md' }],
      keyFiles: { 'README.md': { text: 'x' } },
      hints: { isMonorepo: false, hasAgentGuide: true, buildCommands: ['npm run build'] },
    }; },
  };
  const out = await captureStdout(() => handleForge('recon', ['a/b'], { platform: 'github', ref: 'main', json: true }, deps));
  assert.equal(calledWith.input, 'a/b');
  assert.equal(calledWith.platform, 'github');
  assert.equal(calledWith.ref, 'main');
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meta.fullName, 'a/b');
});

test('forge recon: 缺 repo → 不调 client', async () => {
  let called = false;
  const deps = { reconRepo: async () => { called = true; return { ok: true }; } };
  await captureStdout(() => handleForge('recon', [], {}, deps));
  assert.equal(called, false);
});

test('forge pull: 透传目录与 remote/branch', async () => {
  let calledWith = null;
  const deps = { pullRepo: async (o) => { calledWith = o; return { ok: true, dir: o.dir }; } };
  await captureStdout(() => handleForge('pull', ['/tmp/repo'], { remote: 'origin', branch: 'main', json: true }, deps));
  assert.equal(calledWith.dir, '/tmp/repo');
  assert.equal(calledWith.remote, 'origin');
  assert.equal(calledWith.branch, 'main');
});

test('forge help → 返回 true 不抛', async () => {
  let ret;
  await captureStdout(async () => { ret = await handleForge('help', [], {}); });
  assert.equal(ret, true);
});

test('forge 未知子命令 → 返回 true 并打印帮助', async () => {
  let ret;
  const out = await captureStdout(async () => { ret = await handleForge('bogus', [], {}); });
  assert.equal(ret, true);
  assert.match(out, /khy forge/);
});

// ── phase 7:commits / code / ratelimit 分派 ──────────────────────────
test('forge commits: 透传 repo/limit/ref 并输出质量评分(--json)', async () => {
  let calledWith = null;
  const deps = { getCommits: async (o) => { calledWith = o; return { ok: true, platform: 'github', commits: [{ sha: 'a', subject: 'feat: x' }], quality: { score: 90, grade: 'A', notes: [] } }; } };
  const out = await captureStdout(() => handleForge('commits', ['a/b'], { limit: 5, ref: 'dev', json: true }, deps));
  assert.equal(calledWith.input, 'a/b');
  assert.equal(calledWith.limit, 5);
  assert.equal(calledWith.ref, 'dev');
  assert.match(out, /"grade":"A"/);
});

test('forge commits: 缺 repo → 用法提示,不调 client', async () => {
  let called = false;
  const deps = { getCommits: async () => { called = true; return { ok: true }; } };
  const out = await captureStdout(() => handleForge('commits', [], {}, deps));
  assert.equal(called, false);
  assert.match(out, /用法/);
});

test('forge code: 透传 query/repo 给 searchCode(--json)', async () => {
  let calledWith = null;
  const deps = { searchCode: async (o) => { calledWith = o; return { ok: true, platform: 'github', query: o.query, results: [] }; } };
  await captureStdout(() => handleForge('code', ['createServer'], { repo: 'a/b', json: true }, deps));
  assert.equal(calledWith.query, 'createServer');
  assert.equal(calledWith.repo, 'a/b');
});

test('forge ratelimit: 调 checkRateLimit 并渲染', async () => {
  let called = false;
  const deps = { checkRateLimit: async () => { called = true; return { ok: true, platform: 'github', rate: { core: { limit: 5000, remaining: 4999, reset: 0 }, search: { limit: 30, remaining: 30, reset: 0 }, hasToken: true } }; } };
  const out = await captureStdout(() => handleForge('ratelimit', [], {}, deps));
  assert.equal(called, true);
  assert.match(out, /速率限制/);
});
