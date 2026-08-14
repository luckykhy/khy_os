'use strict';

/**
 * prCommentsFormat.test.js — `/pr-comments` 纯叶子的确定性单测 (node:test)。
 *
 * 覆盖：门控开关、三类评论分组、COMMENTED-空体评审被过滤、作者字段两形态
 * (author.login / user.login)、长体截断、空评论、坏输入 → null、绝不抛。
 * 所有事实由参数传入——叶子零 IO。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  prCommentsEnabled,
  formatPrComments,
  REVIEW_STATE_LABELS,
} = require('../../src/cli/prCommentsFormat');

describe('prCommentsFormat.prCommentsEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(prCommentsEnabled({}), true);
    assert.equal(prCommentsEnabled(), true);
  });
  test('off values disable', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      assert.equal(prCommentsEnabled({ KHY_PR_COMMENTS: v }), false);
    }
  });
  test('unknown value stays on', () => {
    assert.equal(prCommentsEnabled({ KHY_PR_COMMENTS: 'yes' }), true);
  });
});

describe('prCommentsFormat.formatPrComments', () => {
  const sample = {
    prNumber: 42,
    title: '修复登录',
    url: 'https://github.com/x/y/pull/42',
    comments: [{ author: { login: 'alice' }, body: '看起来不错' }],
    reviews: [
      { author: { login: 'bob' }, state: 'APPROVED', body: 'LGTM' },
      // COMMENTED + 空体 = 行内评论载体，应被过滤。
      { author: { login: 'carol' }, state: 'COMMENTED', body: '' },
    ],
    reviewComments: [
      { user: { login: 'dave' }, path: 'src/a.js', line: 10, body: '这里要判空' },
    ],
  };

  test('renders header, url, counts and all three groups', () => {
    const out = formatPrComments(sample, {});
    assert.ok(out.includes('PR #42 修复登录'));
    assert.ok(out.includes('https://github.com/x/y/pull/42'));
    // 评审计数应为 1（COMMENTED 空体被过滤）。
    assert.ok(out.includes('讨论 1·评审 1·行内 1'));
    assert.ok(out.includes('@alice'));
    assert.ok(out.includes('看起来不错'));
    assert.ok(out.includes('@bob'));
    assert.ok(out.includes('已批准'));
    assert.ok(out.includes('@dave'));
    assert.ok(out.includes('src/a.js:10'));
    assert.ok(out.includes('这里要判空'));
    // carol 的空 COMMENTED 评审不出现。
    assert.ok(!out.includes('@carol'));
  });

  test('empty PR → 暂无评论', () => {
    const out = formatPrComments(
      { prNumber: 7, title: '空', comments: [], reviews: [], reviewComments: [] },
      {},
    );
    assert.ok(out.includes('PR #7'));
    assert.ok(out.includes('暂无评论'));
  });

  test('long body is clipped with ellipsis', () => {
    const long = 'x'.repeat(2000);
    const out = formatPrComments(
      { prNumber: 1, comments: [{ author: { login: 'a' }, body: long }], reviews: [], reviewComments: [] },
      {},
    );
    assert.ok(out.includes('…'));
    assert.ok(!out.includes('x'.repeat(2000)));
  });

  test('review-comment original_line fallback when line missing', () => {
    const out = formatPrComments(
      {
        prNumber: 2,
        comments: [],
        reviews: [],
        reviewComments: [{ user: { login: 'e' }, path: 'f.py', original_line: 5, body: 'hi' }],
      },
      {},
    );
    assert.ok(out.includes('f.py:5'));
  });

  test('gate off → null (byte-identical fallback: command not taken over)', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(formatPrComments(sample, { KHY_PR_COMMENTS: v }), null);
    }
  });

  test('bad input → null', () => {
    assert.equal(formatPrComments(null, {}), null);
    assert.equal(formatPrComments(undefined, {}), null);
    assert.equal(formatPrComments('nope', {}), null);
    assert.equal(formatPrComments(42, {}), null);
  });

  test('never throws on hostile input', () => {
    assert.doesNotThrow(() =>
      formatPrComments(
        { prNumber: 9, comments: [null, {}, { author: 42 }], reviews: [undefined], reviewComments: [{}] },
        {},
      ),
    );
    const out = formatPrComments(
      { prNumber: 9, comments: [null, {}], reviews: [], reviewComments: [{}] },
      {},
    );
    assert.ok(out.includes('未知'));
  });

  test('author string form and user.login form both resolve', () => {
    const out = formatPrComments(
      {
        prNumber: 3,
        comments: [{ author: 'plainname', body: 'a' }],
        reviews: [],
        reviewComments: [{ user: { login: 'inlineuser' }, path: 'p', line: 1, body: 'b' }],
      },
      {},
    );
    assert.ok(out.includes('@plainname'));
    assert.ok(out.includes('@inlineuser'));
  });

  test('REVIEW_STATE_LABELS covers common states', () => {
    assert.equal(REVIEW_STATE_LABELS.APPROVED, '已批准');
    assert.equal(REVIEW_STATE_LABELS.CHANGES_REQUESTED, '请求修改');
    assert.equal(REVIEW_STATE_LABELS.DISMISSED, '已忽略');
  });
});
