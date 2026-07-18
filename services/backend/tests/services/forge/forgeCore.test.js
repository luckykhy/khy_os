'use strict';

/**
 * forgeCore.test.js — 纯叶子:forge 查找/拉取的确定性逻辑(零 IO,确定性)。
 *
 * 重点验收:
 *  - 注入防护 isSafeRepoArg / assertSafeRepoArg / buildCloneUrl:拒绝 ext:: / 前导 - /
 *    空白 / shell 元字符(安全核心,git 参数注入的红线)。
 *  - 三家 forge 的 buildSearchRequest 端点 + token 落点(github 头 / gitee 查询参 / gitlab 头)。
 *  - parseSearchResults 把三家原始响应归一成统一 shape,且 fail-soft 绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fc = require('../../../src/services/forge/forgeCore');

// ── 门控 ────────────────────────────────────────────────────────────
test('isEnabled: 默认开;0/false/off/no 关', () => {
  assert.equal(fc.isEnabled({}), true);
  assert.equal(fc.isEnabled({ KHY_FORGE: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(fc.isEnabled({ KHY_FORGE: v }), false, `KHY_FORGE=${v} 应关`);
  }
});

// ── 平台归一 ────────────────────────────────────────────────────────
test('normalizePlatform: 命中→规范 id,否则 null', () => {
  assert.equal(fc.normalizePlatform('GitHub'), 'github');
  assert.equal(fc.normalizePlatform('gitee'), 'gitee');
  assert.equal(fc.normalizePlatform('gitlab'), 'gitlab');
  assert.equal(fc.normalizePlatform('bitbucket'), null);
  assert.equal(fc.normalizePlatform(''), null);
});

test('inferPlatform / resolvePlatform: URL 推断 + 默认 github', () => {
  assert.equal(fc.inferPlatform('https://gitee.com/a/b'), 'gitee');
  assert.equal(fc.inferPlatform('https://gitlab.com/a/b'), 'gitlab');
  assert.equal(fc.inferPlatform('https://github.com/a/b'), 'github');
  assert.equal(fc.inferPlatform('owner/repo'), null);
  // 显式优先 → 推断 → 默认
  assert.equal(fc.resolvePlatform('gitlab', 'https://github.com/a/b'), 'gitlab');
  assert.equal(fc.resolvePlatform('', 'https://gitee.com/a/b'), 'gitee');
  assert.equal(fc.resolvePlatform('', 'owner/repo'), 'github');
});

// ── slug 解析 ───────────────────────────────────────────────────────
test('parseRepoSlug: URL / git@ / slug → owner/repo', () => {
  assert.equal(fc.parseRepoSlug('git@github.com:torvalds/linux.git'), 'torvalds/linux');
  assert.equal(fc.parseRepoSlug('https://github.com/torvalds/linux.git'), 'torvalds/linux');
  assert.equal(fc.parseRepoSlug('https://gitlab.com/group/sub/proj'), 'group/sub/proj');
  assert.equal(fc.parseRepoSlug('owner/repo'), 'owner/repo');
  assert.equal(fc.parseRepoSlug(''), '');
});

// ── 注入防护(安全核心) ─────────────────────────────────────────────
test('isSafeRepoArg: 放行安全形态', () => {
  assert.equal(fc.isSafeRepoArg('torvalds/linux'), true);
  assert.equal(fc.isSafeRepoArg('https://github.com/a/b.git'), true);
  assert.equal(fc.isSafeRepoArg('http://gitlab.com/a/b'), true);
  assert.equal(fc.isSafeRepoArg('ssh://git@github.com/a/b.git'), true);
  assert.equal(fc.isSafeRepoArg('git@github.com:a/b.git'), true);
});

test('isSafeRepoArg: 拒绝危险输入(git 参数/命令注入红线)', () => {
  assert.equal(fc.isSafeRepoArg('ext::sh -c "touch /tmp/pwned"'), false); // 任意命令执行
  assert.equal(fc.isSafeRepoArg('--upload-pack=evil'), false);            // 选项注入
  assert.equal(fc.isSafeRepoArg('-oProxyCommand=evil'), false);
  assert.equal(fc.isSafeRepoArg('a b'), false);                           // 空白
  assert.equal(fc.isSafeRepoArg('file:///etc/passwd'), false);            // 本地 transport
  assert.equal(fc.isSafeRepoArg('fd::17/foo'), false);
  assert.equal(fc.isSafeRepoArg('https://h/a;rm -rf x'), false);          // shell 元字符
  assert.equal(fc.isSafeRepoArg('https://h/a`whoami`'), false);
  assert.equal(fc.isSafeRepoArg('https://h/$(evil)'), false);
  assert.equal(fc.isSafeRepoArg(''), false);
});

test('assertSafeRepoArg: 危险输入 throw,安全输入返回原值', () => {
  assert.equal(fc.assertSafeRepoArg(' torvalds/linux '), 'torvalds/linux');
  assert.throws(() => fc.assertSafeRepoArg('ext::sh -c evil'), /不安全|不合法/);
  assert.throws(() => fc.assertSafeRepoArg('--foo'), /不安全|不合法/);
});

// ── clone URL ───────────────────────────────────────────────────────
test('buildCloneUrl: slug→平台 host,URL 原样,绝不内嵌 token', () => {
  assert.equal(fc.buildCloneUrl('torvalds/linux', 'github'), 'https://github.com/torvalds/linux.git');
  assert.equal(fc.buildCloneUrl('o/r', 'gitee'), 'https://gitee.com/o/r.git');
  assert.equal(fc.buildCloneUrl('o/r', 'gitlab', { ssh: true }), 'git@gitlab.com:o/r.git');
  // 已是 URL → 原样(不改协议、无 token 注入点)
  assert.equal(fc.buildCloneUrl('https://github.com/a/b.git', 'github'), 'https://github.com/a/b.git');
  // 危险输入在构造阶段就被拦
  assert.throws(() => fc.buildCloneUrl('ext::evil', 'github'));
});

// ── 搜索请求 ────────────────────────────────────────────────────────
test('clampLimit: 1..50,默认 10', () => {
  assert.equal(fc.clampLimit(undefined), 10);
  assert.equal(fc.clampLimit(0), 10);
  assert.equal(fc.clampLimit(3), 3);
  assert.equal(fc.clampLimit(999), 50);
  assert.equal(fc.clampLimit('abc'), 10);
});

test('buildSearchRequest: github → 头部 Bearer token', () => {
  const req = fc.buildSearchRequest('github', 'rust http', { limit: 3, token: 'SECRET' });
  assert.equal(req.url, 'https://api.github.com/search/repositories');
  assert.equal(req.params.q, 'rust http');
  assert.equal(req.params.per_page, 3);
  assert.equal(req.headers.Authorization, 'Bearer SECRET');
});

test('buildSearchRequest: gitee → access_token 查询参数', () => {
  const req = fc.buildSearchRequest('gitee', 'x', { token: 'T' });
  assert.equal(req.url, 'https://gitee.com/api/v5/search/repositories');
  assert.equal(req.params.access_token, 'T');
  assert.equal(req.params.q, 'x');
});

test('buildSearchRequest: gitlab → PRIVATE-TOKEN 头,search 参数', () => {
  const req = fc.buildSearchRequest('gitlab', 'x', { token: 'T' });
  assert.equal(req.url, 'https://gitlab.com/api/v4/projects');
  assert.equal(req.headers['PRIVATE-TOKEN'], 'T');
  assert.equal(req.params.search, 'x');
});

test('buildSearchRequest: 无 token 不带鉴权;空 query/未知平台 → null', () => {
  const req = fc.buildSearchRequest('github', 'x', {});
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(fc.buildSearchRequest('github', '', {}), null);
  assert.equal(fc.buildSearchRequest('bitbucket', 'x', {}), null);
});

// ── 搜索响应归一 ────────────────────────────────────────────────────
test('parseSearchResults: github items → 统一 shape', () => {
  const body = { items: [{
    full_name: 'torvalds/linux', name: 'linux', owner: { login: 'torvalds' },
    description: 'kernel', stargazers_count: 100, language: 'C',
    html_url: 'https://github.com/torvalds/linux', clone_url: 'https://github.com/torvalds/linux.git',
  }] };
  const out = fc.parseSearchResults('github', body);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    platform: 'github', fullName: 'torvalds/linux', owner: 'torvalds', name: 'linux',
    description: 'kernel', stars: 100, language: 'C',
    url: 'https://github.com/torvalds/linux', cloneUrl: 'https://github.com/torvalds/linux.git',
  });
});

test('parseSearchResults: gitee 顶层数组 → cloneUrl 由 html_url 派生', () => {
  const out = fc.parseSearchResults('gitee', [
    { full_name: 'x/y', name: 'y', html_url: 'https://gitee.com/x/y', stargazers_count: 2 },
  ]);
  assert.equal(out[0].cloneUrl, 'https://gitee.com/x/y.git');
  assert.equal(out[0].stars, 2);
});

test('parseSearchResults: gitlab 数组 → http_url_to_repo', () => {
  const out = fc.parseSearchResults('gitlab', [
    { path_with_namespace: 'g/p', path: 'p', star_count: 5,
      web_url: 'https://gitlab.com/g/p', http_url_to_repo: 'https://gitlab.com/g/p.git' },
  ]);
  assert.equal(out[0].fullName, 'g/p');
  assert.equal(out[0].cloneUrl, 'https://gitlab.com/g/p.git');
  assert.equal(out[0].stars, 5);
});

test('parseSearchResults: fail-soft 绝不抛', () => {
  assert.deepEqual(fc.parseSearchResults('github', null), []);
  assert.deepEqual(fc.parseSearchResults('github', {}), []);
  assert.deepEqual(fc.parseSearchResults('bitbucket', { items: [{}] }), []);
  assert.deepEqual(fc.parseSearchResults('github', { items: [null, 'x'] }), []);
});

test('确定性:同输入多次调用结果一致', () => {
  const a = fc.buildSearchRequest('github', 'q', { limit: 5 });
  const b = fc.buildSearchRequest('github', 'q', { limit: 5 });
  assert.deepEqual(a, b);
});

// ══ recon(从宽到窄侦察):三端点请求 + 归一 + 关键文件 + 确定性洞见 ════════

// ── 路径防护(contents/file 路径拼进 REST URL,安全核心)──────────────
test('isSafeReconPath: 顶层空串放行;穿越/绝对/危险字符拒绝', () => {
  assert.equal(fc.isSafeReconPath(''), true);
  assert.equal(fc.isSafeReconPath('README.md'), true);
  assert.equal(fc.isSafeReconPath('packages/core/package.json'), true);
  assert.equal(fc.isSafeReconPath('../etc/passwd'), false);     // 目录穿越
  assert.equal(fc.isSafeReconPath('/etc/passwd'), false);       // 绝对路径
  assert.equal(fc.isSafeReconPath('a b'), false);               // 空白
  assert.equal(fc.isSafeReconPath('a;rm -rf x'), false);        // shell 元字符
  assert.equal(fc.isSafeReconPath('a`whoami`'), false);
  assert.equal(fc.isSafeReconPath('a?b#c'), false);             // 会破坏 URL
});

// ── 元数据请求(三家端点 + token 落点)─────────────────────────────────
test('buildRepoMetaRequest: 三家端点 + token 落点', () => {
  const gh = fc.buildRepoMetaRequest('github', 'a/b', { token: 'T' });
  assert.equal(gh.url, 'https://api.github.com/repos/a/b');
  assert.equal(gh.headers.Authorization, 'Bearer T');
  const ge = fc.buildRepoMetaRequest('gitee', 'a/b', { token: 'T' });
  assert.equal(ge.url, 'https://gitee.com/api/v5/repos/a/b');
  assert.equal(ge.params.access_token, 'T');
  const gl = fc.buildRepoMetaRequest('gitlab', 'a/b', { token: 'T' });
  assert.equal(gl.url, 'https://gitlab.com/api/v4/projects/a%2Fb');
  assert.equal(gl.headers['PRIVATE-TOKEN'], 'T');
  // 未知平台 → null;非法 slug → throw
  assert.equal(fc.buildRepoMetaRequest('bitbucket', 'a/b'), null);
  assert.throws(() => fc.buildRepoMetaRequest('github', 'noslash'));
});

test('parseRepoMeta: github/gitlab → 统一 shape;fail-soft', () => {
  const gh = fc.parseRepoMeta('github', {
    full_name: 'a/b', description: 'd', default_branch: 'main', stargazers_count: 9,
    forks_count: 2, open_issues_count: 1, language: 'Go', license: { spdx_id: 'MIT' },
    topics: ['x'], html_url: 'h', clone_url: 'c', pushed_at: 't',
  });
  assert.equal(gh.fullName, 'a/b');
  assert.equal(gh.stars, 9);
  assert.equal(gh.license, 'MIT');
  assert.equal(gh.defaultBranch, 'main');
  assert.deepEqual(gh.topics, ['x']);
  const gl = fc.parseRepoMeta('gitlab', { path_with_namespace: 'g/p', star_count: 5, http_url_to_repo: 'u', default_branch: 'dev' });
  assert.equal(gl.fullName, 'g/p');
  assert.equal(gl.stars, 5);
  assert.equal(gl.cloneUrl, 'u');
  assert.equal(gl.defaultBranch, 'dev');
  assert.equal(fc.parseRepoMeta('github', null), null);
  assert.equal(fc.parseRepoMeta('bitbucket', {}), null);
});

// ── 目录请求 + 归一 ────────────────────────────────────────────────────
test('buildContentsRequest: github contents / gitlab tree;路径防护 throw', () => {
  const gh = fc.buildContentsRequest('github', 'a/b', '', { token: 'T' });
  assert.equal(gh.url, 'https://api.github.com/repos/a/b/contents/');
  assert.equal(gh.headers.Authorization, 'Bearer T');
  const gl = fc.buildContentsRequest('gitlab', 'a/b', 'src', { ref: 'main' });
  assert.equal(gl.url, 'https://gitlab.com/api/v4/projects/a%2Fb/repository/tree');
  assert.equal(gl.params.path, 'src');
  assert.equal(gl.params.ref, 'main');
  assert.equal(gl.params.per_page, 100);
  assert.throws(() => fc.buildContentsRequest('github', 'a/b', '../evil'));
});

test('parseContents: github 数组 + gitlab tree(type 归一)', () => {
  const gh = fc.parseContents('github', [
    { type: 'file', name: 'README.md', path: 'README.md', size: 10 },
    { type: 'dir', name: 'packages', path: 'packages' },
    null, 'x',
  ]);
  assert.equal(gh.length, 2);
  assert.equal(gh[0].type, 'file');
  assert.equal(gh[1].type, 'dir');
  const gl = fc.parseContents('gitlab', [
    { type: 'tree', name: 'src', path: 'src' },
    { type: 'blob', name: 'go.mod', path: 'go.mod' },
  ]);
  assert.equal(gl[0].type, 'dir');   // tree → dir
  assert.equal(gl[1].type, 'file');  // blob → file
  assert.deepEqual(fc.parseContents('github', null), []);
});

// ── 文件请求 + 归一(base64 解码 / raw 文本)─────────────────────────────
test('buildFileRequest: github contents / gitlab raw;空路径 throw', () => {
  const gh = fc.buildFileRequest('github', 'a/b', 'README.md', { ref: 'main' });
  assert.equal(gh.url, 'https://api.github.com/repos/a/b/contents/README.md');
  assert.equal(gh.params.ref, 'main');
  const gl = fc.buildFileRequest('gitlab', 'a/b', 'src/main.go', { ref: 'main' });
  assert.equal(gl.url, 'https://gitlab.com/api/v4/projects/a%2Fb/repository/files/src%2Fmain.go/raw');
  assert.equal(gl.params.ref, 'main');
  assert.throws(() => fc.buildFileRequest('github', 'a/b', ''));
  assert.throws(() => fc.buildFileRequest('github', 'a/b', '../../etc/passwd'));
});

test('parseFileContent: github base64 解码 / gitlab raw 文本 / 封顶', () => {
  const b64 = Buffer.from('# Hello', 'utf8').toString('base64');
  assert.deepEqual(fc.parseFileContent('github', { content: b64, encoding: 'base64' }), { text: '# Hello', truncated: false });
  assert.deepEqual(fc.parseFileContent('gitlab', 'raw text body'), { text: 'raw text body', truncated: false });
  const big = 'x'.repeat(100);
  const r = fc.parseFileContent('gitlab', big, { maxBytes: 10 });
  assert.equal(r.text.length, 10);
  assert.equal(r.truncated, true);
  // 畸形不抛
  assert.deepEqual(fc.parseFileContent('github', null), { text: '', truncated: false });
});

// ── 关键文件挑选(大小写不敏感、去重、封顶、只取 file)───────────────────
test('pickKeyFiles: 只挑存在的关键文件,忽略目录,大小写不敏感', () => {
  const picks = fc.pickKeyFiles([
    { type: 'file', name: 'readme.md', path: 'readme.md' },   // 小写也命中
    { type: 'file', name: 'CLAUDE.md', path: 'CLAUDE.md' },
    { type: 'file', name: 'package.json', path: 'package.json' },
    { type: 'dir', name: 'README.md', path: 'README.md' },    // 目录不算
    { type: 'file', name: 'random.txt', path: 'random.txt' }, // 非关键文件
  ]);
  const names = picks.map((p) => p.name);
  assert.ok(names.includes('readme.md'));
  assert.ok(names.includes('CLAUDE.md'));
  assert.ok(names.includes('package.json'));
  assert.ok(!names.includes('random.txt'));
  assert.deepEqual(fc.pickKeyFiles(null), []);
});

// ── 确定性洞见(我「看到 packages/ 就知道 monorepo」那套判断的代码化)──
test('deriveReconHints: monorepo / agent 指南 / 构建·部署命令', () => {
  const h = fc.deriveReconHints({
    tree: [
      { type: 'dir', name: 'packages' },
      { type: 'dir', name: '.claude' },
      { type: 'file', name: 'package.json' },
      { type: 'file', name: 'Dockerfile' },
    ],
    keyFiles: {
      'CLAUDE.md': { text: '# agent guide' },
      'package.json': { text: JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'tsc', deploy: 'sh deploy.sh' } }) },
    },
  });
  assert.equal(h.isMonorepo, true);
  assert.equal(h.hasAgentGuide, true);   // 既有 CLAUDE.md 又有 .claude/
  assert.equal(h.hasDocker, true);
  assert.equal(h.packageManager, 'npm');
  assert.ok(h.buildCommands.includes('npm run build'));
  assert.ok(h.buildCommands.includes('npm run deploy'));
  assert.ok(h.deployHints.some((d) => /Docker/.test(d)));
});

test('deriveReconHints: Rust/Python/Go 项目笔记;畸形 package.json 不抛', () => {
  const rust = fc.deriveReconHints({ tree: [{ type: 'file', name: 'Cargo.toml' }], keyFiles: {} });
  assert.ok(rust.notes.some((n) => /Rust/.test(n)));
  const bad = fc.deriveReconHints({ keyFiles: { 'package.json': { text: '{ not json' } } });
  assert.ok(bad.notes.some((n) => /解析失败/.test(n)));
  // 全空不抛
  assert.doesNotThrow(() => fc.deriveReconHints());
  assert.doesNotThrow(() => fc.deriveReconHints({}));
});

test('recon 确定性:同输入多次调用一致', () => {
  const a = fc.buildContentsRequest('github', 'a/b', 'src', { ref: 'main' });
  const b = fc.buildContentsRequest('github', 'a/b', 'src', { ref: 'main' });
  assert.deepEqual(a, b);
});

// ── commits 请求 + 提交质量评估(phase 7)─────────────────────────────
test('buildCommitsRequest: 三家端点 + token 落点 + ref/path 参数', () => {
  const gh = fc.buildCommitsRequest('github', 'a/b', { limit: 5, ref: 'dev', path: 'src', token: 'T' });
  assert.equal(gh.url, 'https://api.github.com/repos/a/b/commits');
  assert.equal(gh.headers.Authorization, 'Bearer T');
  assert.deepEqual(gh.params, { per_page: 5, sha: 'dev', path: 'src' });

  const ge = fc.buildCommitsRequest('gitee', 'a/b', { ref: 'dev', token: 'T' });
  assert.equal(ge.url, 'https://gitee.com/api/v5/repos/a/b/commits');
  assert.equal(ge.params.access_token, 'T');
  assert.equal(ge.params.sha, 'dev');

  const gl = fc.buildCommitsRequest('gitlab', 'a/b', { ref: 'dev', token: 'T' });
  assert.equal(gl.url, 'https://gitlab.com/api/v4/projects/a%2Fb/repository/commits');
  assert.equal(gl.headers['PRIVATE-TOKEN'], 'T');
  assert.equal(gl.params.ref_name, 'dev');
});

test('buildCommitsRequest: limit 夹取 [1,100];未知平台/不安全路径', () => {
  assert.equal(fc.buildCommitsRequest('github', 'a/b', { limit: 9999 }).params.per_page, 100);
  assert.equal(fc.buildCommitsRequest('github', 'a/b', { limit: 0 }).params.per_page, fc.COMMITS_DEFAULT_LIMIT);
  assert.equal(fc.buildCommitsRequest('bitbucket', 'a/b'), null);
  assert.throws(() => fc.buildCommitsRequest('github', 'a/b', { path: '../etc' }));
});

test('parseCommits: github/gitee/gitlab 归一 + 合并标记;脏数据不抛', () => {
  const gh = fc.parseCommits('github', [
    { sha: 'abc', html_url: 'u', commit: { message: 'feat: x\n\nbody', author: { name: 'Al', date: '2024-01-01' } }, author: { login: 'al' } },
  ]);
  assert.deepEqual(gh[0], { sha: 'abc', message: 'feat: x\n\nbody', subject: 'feat: x', author: 'Al', date: '2024-01-01', url: 'u', isMerge: false });

  const gl = fc.parseCommits('gitlab', [{ id: 'z9', message: 'Merge branch x', author_name: 'Bo', created_at: 't', web_url: 'w' }]);
  assert.equal(gl[0].sha, 'z9');
  assert.equal(gl[0].isMerge, true);

  assert.deepEqual(fc.parseCommits('github', null), []);
  assert.deepEqual(fc.parseCommits('github', [null, 'x', {}]), []);
});

test('evaluateCommitQuality: 规范度 + 笼统 + 合并排除 + 等级', () => {
  const q = fc.evaluateCommitQuality([
    { subject: 'feat(api): add endpoint', isMerge: false },
    { subject: 'fix: handle null', isMerge: false },
    { subject: 'wip', isMerge: false },
    { subject: 'Merge pull request #1', isMerge: true },
  ]);
  assert.equal(q.total, 4);
  assert.equal(q.scored, 3);          // merge 不计入分母
  assert.equal(q.merges, 1);
  assert.equal(q.conventional, 2);
  assert.equal(q.vague, 1);
  assert.ok(q.score >= 0 && q.score <= 100);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(q.grade));
  assert.ok(q.notes.some((n) => /Conventional Commits/.test(n)));
});

test('evaluateCommitQuality: 全规范 → 高分 A;全笼统 → 低分;空 → N/A 不抛', () => {
  const good = fc.evaluateCommitQuality([
    { subject: 'feat: a' }, { subject: 'fix: b' }, { subject: 'docs: c' },
  ]);
  assert.equal(good.conventional, 3);
  assert.equal(good.grade, 'A');

  const bad = fc.evaluateCommitQuality([{ subject: 'update' }, { subject: 'wip' }, { subject: 'fix' }]);
  assert.ok(bad.score < 55);

  const empty = fc.evaluateCommitQuality([]);
  assert.equal(empty.grade, 'N/A');
  assert.doesNotThrow(() => fc.evaluateCommitQuality(null));
});

test('evaluateCommitQuality: 主题过长扣分', () => {
  const long = 'feat: ' + 'x'.repeat(80);
  const q = fc.evaluateCommitQuality([{ subject: long }]);
  assert.equal(q.tooLong, 1);
  assert.ok(q.notes.some((n) => /超过/.test(n)));
});

// ── 代码搜索 + 速率限制(仅 github)─────────────────────────────────
test('buildCodeSearchRequest: github 端点 + repo 限定符 + token;非 github → null', () => {
  const r = fc.buildCodeSearchRequest('github', 'createServer', { repo: 'a/b', limit: 5, token: 'T' });
  assert.equal(r.url, 'https://api.github.com/search/code');
  assert.equal(r.params.q, 'createServer repo:a/b');
  assert.equal(r.params.per_page, 5);
  assert.equal(r.headers.Authorization, 'Bearer T');
  assert.equal(fc.buildCodeSearchRequest('gitee', 'x'), null);
  assert.equal(fc.buildCodeSearchRequest('gitlab', 'x'), null);
  assert.equal(fc.buildCodeSearchRequest('github', ''), null);
});

test('buildCodeSearchRequest: 不安全 repo 不拼 repo: 限定符', () => {
  const r = fc.buildCodeSearchRequest('github', 'x', { repo: 'bad repo;rm' });
  assert.equal(r.params.q, 'x');     // 不安全 slug 被忽略,绝不拼进查询
});

test('parseCodeSearchResults: github items 归一;非 github / 空 → []', () => {
  const out = fc.parseCodeSearchResults('github', { items: [
    { name: 'x.js', path: 'src/x.js', repository: { full_name: 'a/b' }, html_url: 'u' },
  ] });
  assert.deepEqual(out[0], { repo: 'a/b', path: 'src/x.js', name: 'x.js', url: 'u' });
  assert.deepEqual(fc.parseCodeSearchResults('gitlab', { items: [] }), []);
  assert.deepEqual(fc.parseCodeSearchResults('github', null), []);
});

test('buildRateLimitRequest + parseRateLimit: github only', () => {
  const req = fc.buildRateLimitRequest('github', { token: 'T' });
  assert.equal(req.url, 'https://api.github.com/rate_limit');
  assert.equal(req.headers.Authorization, 'Bearer T');
  assert.equal(fc.buildRateLimitRequest('gitee'), null);

  const rate = fc.parseRateLimit('github', { resources: {
    core: { limit: 5000, remaining: 4999, reset: 1700000000, used: 1 },
    search: { limit: 30, remaining: 29, reset: 1700000000, used: 1 },
  } });
  assert.equal(rate.core.remaining, 4999);
  assert.equal(rate.search.limit, 30);
  assert.equal(rate.hasToken, true);   // limit>60 → 已鉴权信号

  const anon = fc.parseRateLimit('github', { rate: { limit: 60, remaining: 60, reset: 0, used: 0 } });
  assert.equal(anon.hasToken, false);
  assert.equal(fc.parseRateLimit('gitlab', {}), null);
  assert.equal(fc.parseRateLimit('github', null), null);
});
