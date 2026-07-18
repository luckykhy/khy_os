'use strict';

/**
 * issueReport.test.js — 纯叶子 `/issue` 逻辑契约(node:test,零 IO)。
 *
 * 锁定:parseIssueArgs(labels/assignees/title/未知 flag/缺标题);parseRemoteOwnerRepo(SSH/HTTPS/
 * 去 .git/非法);buildIssueBody(回合截断/错误抽取/模板拼接/空);buildIssueUrl(URL 编码/超长信号/
 * 无 repo);门控梯;**正文绝不编造**(空 transcript 不伪造内容)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseIssueArgs,
  parseRemoteOwnerRepo,
  buildIssueBody,
  buildIssueUrl,
  isEnabled,
  DEFAULT_MAX_URL_BODY,
} = require('../../../src/services/issue/issueReport');

describe('parseIssueArgs', () => {
  test('纯标题', () => {
    const r = parseIssueArgs(['修复', '登录', 'bug']);
    assert.equal(r.title, '修复 登录 bug');
    assert.deepEqual(r.labels, []);
    assert.deepEqual(r.assignees, []);
    assert.equal(r.valid, true);
    assert.equal(r.parseError, null);
  });
  test('--label / -l 多次 + --assignee / -a', () => {
    const r = parseIssueArgs(['--label', 'bug', '-l', 'urgent', '--assignee', 'alice', '-a', 'bob', 'title', 'words']);
    assert.deepEqual(r.labels, ['bug', 'urgent']);
    assert.deepEqual(r.assignees, ['alice', 'bob']);
    assert.equal(r.title, 'title words');
    assert.equal(r.valid, true);
  });
  test('flag 缺值 → parseError', () => {
    const r = parseIssueArgs(['--label']);
    assert.equal(r.valid, false);
    assert.match(r.parseError, /--label/);
  });
  test('未知 flag → parseError', () => {
    const r = parseIssueArgs(['--bogus', 'x', 'title']);
    assert.equal(r.valid, false);
    assert.match(r.parseError, /未知参数/);
  });
  test('缺标题 → 不合法', () => {
    const r = parseIssueArgs(['--label', 'bug']);
    assert.equal(r.valid, false);
    assert.match(r.parseError, /标题/);
  });
  test('防呆:空/非数组', () => {
    assert.equal(parseIssueArgs().valid, false);
    assert.equal(parseIssueArgs(null).valid, false);
  });
});

describe('parseRemoteOwnerRepo', () => {
  test('SSH git@github.com:owner/repo.git', () => {
    const r = parseRemoteOwnerRepo('git@github.com:acme/widgets.git');
    assert.deepEqual(r, { host: 'github.com', owner: 'acme', repo: 'widgets' });
  });
  test('SSH 无 .git', () => {
    const r = parseRemoteOwnerRepo('git@gitlab.com:grp/proj');
    assert.deepEqual(r, { host: 'gitlab.com', owner: 'grp', repo: 'proj' });
  });
  test('HTTPS .git', () => {
    const r = parseRemoteOwnerRepo('https://github.com/acme/widgets.git');
    assert.deepEqual(r, { host: 'github.com', owner: 'acme', repo: 'widgets' });
  });
  test('HTTPS 带 token', () => {
    const r = parseRemoteOwnerRepo('https://x-token@github.com/acme/widgets');
    assert.deepEqual(r, { host: 'github.com', owner: 'acme', repo: 'widgets' });
  });
  test('非法 / 空 → null', () => {
    assert.equal(parseRemoteOwnerRepo(''), null);
    assert.equal(parseRemoteOwnerRepo('not-a-url'), null);
    assert.equal(parseRemoteOwnerRepo(null), null);
  });
});

describe('buildIssueBody', () => {
  function tx() {
    return [
      { role: 'user', content: '帮我修复登录' },
      { role: 'assistant', content: [{ type: 'text', text: '好的,我来看看' }] },
      { role: 'user', content: '报错了', isMeta: true }, // meta 跳过
      { role: 'assistant', content: [
        { type: 'text', text: '运行测试' },
        { type: 'tool_result', is_error: true, content: 'Error: ENOENT no such file' },
      ] },
    ];
  }
  test('汇总最近回合 + 抽取错误', () => {
    const out = buildIssueBody({ transcript: tx() });
    assert.match(out, /会话上下文/);
    assert.match(out, /帮我修复登录/);
    assert.match(out, /Recent errors/);
    assert.match(out, /ENOENT/);
    assert.doesNotMatch(out, /报错了/); // meta 被跳过
  });
  test('maxTurns 限制最近 N 回合', () => {
    const many = [];
    for (let i = 0; i < 10; i += 1) many.push({ role: 'user', content: `msg${i}` });
    const out = buildIssueBody({ transcript: many, maxTurns: 2 });
    assert.match(out, /msg9/);
    assert.match(out, /msg8/);
    assert.doesNotMatch(out, /msg0\b/);
  });
  test('每回合截断到 200 字', () => {
    const long = 'x'.repeat(500);
    const out = buildIssueBody({ transcript: [{ role: 'user', content: long }] });
    assert.match(out, /…/);
    assert.ok(!out.includes('x'.repeat(300)));
  });
  test('模板拼接 + 去 front-matter', () => {
    const tpl = '---\nname: Bug\nabout: x\n---\n## 复现步骤\n1. ...';
    const out = buildIssueBody({ transcript: tx(), template: tpl });
    assert.match(out, /复现步骤/);
    assert.doesNotMatch(out, /about: x/);
  });
  test('诚实:空 transcript → 不伪造内容', () => {
    const out = buildIssueBody({ transcript: [] });
    assert.match(out, /无可汇总/);
    assert.doesNotMatch(out, /最近回合/);
  });
  test('防呆:空入参不抛', () => {
    assert.equal(typeof buildIssueBody(), 'string');
  });
});

describe('buildIssueUrl', () => {
  test('构造 URL 编码链接', () => {
    const { url, bodyTruncated } = buildIssueUrl({
      host: 'github.com', owner: 'acme', repo: 'widgets',
      title: 'login bug', body: 'details here', labels: ['bug', 'urgent'],
    });
    assert.match(url, /^https:\/\/github\.com\/acme\/widgets\/issues\/new\?/);
    assert.match(url, /title=login%20bug/);
    assert.match(url, /labels=bug%2Curgent/);
    assert.equal(bodyTruncated, false);
  });
  test('body 超长 → 截断 + 置 bodyTruncated', () => {
    const big = 'y'.repeat(DEFAULT_MAX_URL_BODY + 100);
    const { url, bodyTruncated } = buildIssueUrl({ owner: 'a', repo: 'b', title: 't', body: big });
    assert.equal(bodyTruncated, true);
    assert.ok(url.length < big.length + 200);
  });
  test('无 owner/repo → url null', () => {
    const r = buildIssueUrl({ title: 't', body: 'b' });
    assert.equal(r.url, null);
    assert.equal(r.bodyTruncated, false);
  });
  test('默认 host github.com', () => {
    const { url } = buildIssueUrl({ owner: 'a', repo: 'b', title: 't' });
    assert.match(url, /github\.com/);
  });
});

describe('门控 isEnabled', () => {
  test('默认 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_ISSUE: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_ISSUE: v }), false);
    }
  });
});
