'use strict';

/**
 * forgeClient.test.js — 薄 IO 层:用注入的 axios / execFile 验证
 *  - 搜索经 forgeCore 构造请求并归一,token 进请求但绝不进返回值;
 *  - 克隆走 execFile('git', ['clone','--', url]),危险输入在构造阶段就被拒;
 *  - clone URL 绝不内嵌 token。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../../../src/services/forge/forgeClient');

test('searchRepos: 用注入 axios,返回归一结果且不回显 token', async () => {
  process.env.GITHUB_TOKEN = 'SECRET-TOKEN';
  let captured = null;
  const axios = async (cfg) => { captured = cfg; return {
    status: 200,
    data: { items: [{ full_name: 'a/b', name: 'b', owner: { login: 'a' }, html_url: 'h', clone_url: 'c', stargazers_count: 3 }] },
  }; };
  const res = await client.searchRepos({ platform: 'github', query: 'rust', limit: 2 }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.platform, 'github');
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].fullName, 'a/b');
  // token 进了请求头…
  assert.equal(captured.headers.Authorization, 'Bearer SECRET-TOKEN');
  // …但绝不出现在返回值里(序列化全文不含密钥)
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN'));
  delete process.env.GITHUB_TOKEN;
});

test('searchRepos: HTTP 错误 → ok:false 且不抛', async () => {
  const axios = async () => ({ status: 403, data: { message: 'rate limited' } });
  const res = await client.searchRepos({ platform: 'github', query: 'x' }, { axios });
  assert.equal(res.ok, false);
  assert.match(res.error, /rate limited/);
});

test('searchRepos: 缺关键词 → ok:false', async () => {
  const res = await client.searchRepos({ platform: 'github', query: '' }, { axios: async () => ({}) });
  assert.equal(res.ok, false);
});

test('cloneRepo: 走 execFile git clone -- <url>,URL 无 token', async () => {
  let gitArgs = null;
  const execFile = (cmd, args, opts, cb) => {
    gitArgs = { cmd, args };
    cb(null, 'Cloning into ...', '');
    return { stderr: null };
  };
  const res = await client.cloneRepo({ input: 'torvalds/linux', platform: 'github', dir: 'linux' }, { execFile });
  assert.equal(res.ok, true);
  assert.equal(gitArgs.cmd, 'git');
  assert.equal(gitArgs.args[0], 'clone');
  // `--` 必须在 url 之前,杜绝选项注入
  const dashIdx = gitArgs.args.indexOf('--');
  assert.ok(dashIdx >= 0);
  assert.equal(gitArgs.args[dashIdx + 1], 'https://github.com/torvalds/linux.git');
  assert.equal(gitArgs.args[dashIdx + 2], 'linux');
  assert.equal(res.url, 'https://github.com/torvalds/linux.git');
});

test('cloneRepo: depth 浅克隆参数透传', async () => {
  let gitArgs = null;
  const execFile = (cmd, args, opts, cb) => { gitArgs = args; cb(null, '', ''); return { stderr: null }; };
  await client.cloneRepo({ input: 'a/b', depth: 1 }, { execFile });
  assert.ok(gitArgs.includes('--depth'));
  assert.equal(gitArgs[gitArgs.indexOf('--depth') + 1], '1');
});

test('cloneRepo: 危险输入(ext::)被构造阶段拒绝,git 从不被调用', async () => {
  let called = false;
  const execFile = () => { called = true; return { stderr: null }; };
  const res = await client.cloneRepo({ input: 'ext::sh -c "evil"' }, { execFile });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test('cloneRepo: git 失败 → ok:false 带 stderr', async () => {
  const execFile = (cmd, args, opts, cb) => { cb(new Error('exit 128'), '', 'fatal: repo not found'); return { stderr: null }; };
  const res = await client.cloneRepo({ input: 'no/such' }, { execFile });
  assert.equal(res.ok, false);
  assert.match(res.error, /not found/);
});

test('pullRepo: git -C <dir> pull,remote/branch 经安全校验', async () => {
  let gitArgs = null;
  const execFile = (cmd, args, opts, cb) => { gitArgs = args; cb(null, 'Already up to date.', ''); return { stderr: null }; };
  const res = await client.pullRepo({ dir: '/tmp/repo', remote: 'origin', branch: 'main' }, { execFile });
  assert.equal(res.ok, true);
  assert.deepEqual(gitArgs, ['-C', '/tmp/repo', 'pull', 'origin', 'main']);
});

test('pullRepo: 不安全 remote 被丢弃(不追加进 argv)', async () => {
  let gitArgs = null;
  const execFile = (cmd, args, opts, cb) => { gitArgs = args; cb(null, '', ''); return { stderr: null }; };
  await client.pullRepo({ dir: '/tmp/repo', remote: 'origin; rm -rf x' }, { execFile });
  assert.deepEqual(gitArgs, ['-C', '/tmp/repo', 'pull']);
});

test('_readToken: 按平台读 env,缺失返回空串', () => {
  delete process.env.GITEE_TOKEN;
  assert.equal(client._readToken('gitee'), '');
  process.env.GITEE_TOKEN = 'g';
  assert.equal(client._readToken('gitee'), 'g');
  delete process.env.GITEE_TOKEN;
});

// ══ recon IO:元数据 / 目录 / 文件 / reconRepo 编排 ═══════════════════════

function _b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

test('getRepoMeta: 注入 axios 归一元数据,token 不回显', async () => {
  process.env.GITHUB_TOKEN = 'META-SECRET';
  let cap = null;
  const axios = async (cfg) => { cap = cfg; return { status: 200, data: { full_name: 'a/b', default_branch: 'main', stargazers_count: 7, license: { spdx_id: 'MIT' } } }; };
  const res = await client.getRepoMeta({ input: 'a/b', platform: 'github' }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.meta.fullName, 'a/b');
  assert.equal(res.meta.stars, 7);
  assert.equal(cap.headers.Authorization, 'Bearer META-SECRET');
  assert.ok(!JSON.stringify(res).includes('META-SECRET'));
  delete process.env.GITHUB_TOKEN;
});

test('getRepoMeta: 缺 input → ok:false;HTTP 404 → ok:false 不抛', async () => {
  const r1 = await client.getRepoMeta({ input: '' }, { axios: async () => ({}) });
  assert.equal(r1.ok, false);
  const r2 = await client.getRepoMeta({ input: 'a/b', platform: 'github' }, { axios: async () => ({ status: 404, data: { message: 'Not Found' } }) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Not Found/);
});

test('listContents: 归一目录条目', async () => {
  const axios = async () => ({ status: 200, data: [
    { type: 'file', name: 'README.md', path: 'README.md', size: 1 },
    { type: 'dir', name: 'packages', path: 'packages' },
  ] });
  const res = await client.listContents({ input: 'a/b', platform: 'github' }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 2);
  assert.equal(res.entries[1].type, 'dir');
});

test('getFile: github base64 解码', async () => {
  const axios = async () => ({ status: 200, data: { content: _b64('# Title'), encoding: 'base64' } });
  const res = await client.getFile({ input: 'a/b', platform: 'github', path: 'README.md' }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.text, '# Title');
});

test('getFile: 非法路径在构造阶段被拒,axios 从不被调用', async () => {
  let called = false;
  const axios = async () => { called = true; return { status: 200, data: {} }; };
  const res = await client.getFile({ input: 'a/b', platform: 'github', path: '../../etc/passwd' }, { axios });
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test('reconRepo: 从宽到窄编排——元数据→目录→只读存在的关键文件→洞见', async () => {
  process.env.GITHUB_TOKEN = 'RECON-SECRET';
  const fetchedPaths = [];
  const axios = async (cfg) => {
    const url = cfg.url;
    if (/\/repos\/a\/b$/.test(url)) {
      return { status: 200, data: { full_name: 'a/b', default_branch: 'main', stargazers_count: 42, license: { spdx_id: 'MIT' } } };
    }
    if (/\/contents\/$/.test(url)) {
      return { status: 200, data: [
        { type: 'file', name: 'README.md', path: 'README.md' },
        { type: 'file', name: 'package.json', path: 'package.json' },
        { type: 'dir', name: 'packages', path: 'packages' },
        { type: 'file', name: 'nope.txt', path: 'nope.txt' },   // 非关键文件,绝不拉取
      ] };
    }
    if (/contents\/README\.md/.test(url)) { fetchedPaths.push('README.md'); return { status: 200, data: { content: _b64('# A'), encoding: 'base64' } }; }
    if (/contents\/package\.json/.test(url)) { fetchedPaths.push('package.json'); return { status: 200, data: { content: _b64(JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'tsc' } })), encoding: 'base64' } }; }
    return { status: 404, data: { message: 'nf' } };
  };
  const res = await client.reconRepo({ input: 'a/b', platform: 'github' }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.meta.stars, 42);
  assert.equal(res.tree.length, 4);
  // 只精读了存在的关键文件,绝不碰 nope.txt
  assert.deepEqual(fetchedPaths.sort(), ['README.md', 'package.json']);
  assert.ok(Object.keys(res.keyFiles).includes('README.md'));
  assert.equal(res.hints.isMonorepo, true);
  assert.ok(res.hints.buildCommands.includes('npm run build'));
  // token 绝不进返回值
  assert.ok(!JSON.stringify(res).includes('RECON-SECRET'));
  delete process.env.GITHUB_TOKEN;
});

test('reconRepo: 元数据失败即早返回 ok:false', async () => {
  const axios = async () => ({ status: 404, data: { message: 'Not Found' } });
  const res = await client.reconRepo({ input: 'a/b', platform: 'github' }, { axios });
  assert.equal(res.ok, false);
});

test('reconRepo: 缺 input → ok:false', async () => {
  const res = await client.reconRepo({ input: '' }, { axios: async () => ({}) });
  assert.equal(res.ok, false);
});

// ── getCommits / searchCode / checkRateLimit(phase 7)─────────────────
test('getCommits: 注入 axios → 归一提交 + 质量评分;token 不回显', async () => {
  process.env.GITHUB_TOKEN = 'COMMIT-SECRET';
  let captured = null;
  const axios = async (cfg) => { captured = cfg; return { status: 200, data: [
    { sha: 'a1', html_url: 'u1', commit: { message: 'feat: x', author: { name: 'Al', date: 'd' } } },
    { sha: 'b2', html_url: 'u2', commit: { message: 'wip', author: { name: 'Bo', date: 'd' } } },
  ] }; };
  const res = await client.getCommits({ input: 'a/b', platform: 'github', limit: 5 }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 2);
  assert.equal(res.quality.conventional, 1);
  assert.ok(res.quality.score >= 0 && res.quality.score <= 100);
  // token 进了请求头但绝不进返回值
  assert.equal(captured.headers.Authorization, 'Bearer COMMIT-SECRET');
  assert.ok(!JSON.stringify(res).includes('COMMIT-SECRET'));
  delete process.env.GITHUB_TOKEN;
});

test('getCommits: HTTP 错误 → ok:false;缺 input → ok:false', async () => {
  const bad = await client.getCommits({ input: 'a/b', platform: 'github' }, { axios: async () => ({ status: 404, data: { message: 'Not Found' } }) });
  assert.equal(bad.ok, false);
  const none = await client.getCommits({ input: '' }, { axios: async () => ({}) });
  assert.equal(none.ok, false);
});

test('searchCode: github 归一结果;非 github → 清晰不支持提示', async () => {
  const axios = async () => ({ status: 200, data: { items: [
    { name: 'x.js', path: 'src/x.js', repository: { full_name: 'a/b' }, html_url: 'u' },
  ] } });
  const ok = await client.searchCode({ query: 'createServer', platform: 'github' }, { axios });
  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].repo, 'a/b');

  const ge = await client.searchCode({ query: 'x', platform: 'gitee' }, { axios });
  assert.equal(ge.ok, false);
  assert.ok(/仅支持 github/.test(ge.error));
});

test('searchCode: 401/403 给出配置 GITHUB_TOKEN 的可操作提示', async () => {
  const res = await client.searchCode({ query: 'x', platform: 'github' }, { axios: async () => ({ status: 403, data: { message: 'rate limited' } }) });
  assert.equal(res.ok, false);
  assert.ok(/GITHUB_TOKEN/.test(res.error));
});

test('checkRateLimit: github 归一配额;非 github → 不支持', async () => {
  const axios = async () => ({ status: 200, data: { resources: {
    core: { limit: 5000, remaining: 4998, reset: 1700000000, used: 2 },
    search: { limit: 30, remaining: 30, reset: 1700000000, used: 0 },
  } } });
  const res = await client.checkRateLimit({ platform: 'github' }, { axios });
  assert.equal(res.ok, true);
  assert.equal(res.rate.core.remaining, 4998);
  assert.equal(res.rate.hasToken, true);

  const gl = await client.checkRateLimit({ platform: 'gitlab' }, { axios });
  assert.equal(gl.ok, false);
});
