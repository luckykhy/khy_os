'use strict';

// feedbackDoc 叶子契约测试(node:test)。
// 覆盖:门控开关、参数解析(类别 flag 三形态 + 自由文本)、类别标签、
// 反馈文档构造(标题/正文/环境段)、空文本 invalid、文件名安全化、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  feedbackEnabled,
  categoryLabel,
  parseFeedbackArgs,
  buildFeedbackDoc,
  buildFeedbackFilename,
} = require('../../src/cli/feedbackDoc');

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(feedbackEnabled({}), true);
  assert.strictEqual(feedbackEnabled({ KHY_FEEDBACK: '' }), true);
  assert.strictEqual(feedbackEnabled({ KHY_FEEDBACK: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(feedbackEnabled({ KHY_FEEDBACK: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('类别标签映射(未知/缺省 → 其他)', () => {
  assert.strictEqual(categoryLabel('bug'), '缺陷');
  assert.strictEqual(categoryLabel('idea'), '建议');
  assert.strictEqual(categoryLabel('feature'), '建议');
  assert.strictEqual(categoryLabel('praise'), '好评');
  assert.strictEqual(categoryLabel('other'), '其他');
  assert.strictEqual(categoryLabel('weird'), '其他');
  assert.strictEqual(categoryLabel(undefined), '其他');
});

test('parseFeedbackArgs:自由文本、缺省类别 other', () => {
  const r = parseFeedbackArgs(['编辑', '后', '光标', '跳了']);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.category, 'other');
  assert.strictEqual(r.text, '编辑 后 光标 跳了');
});

test('parseFeedbackArgs:--category / -c / --category= 三形态', () => {
  assert.deepStrictEqual(parseFeedbackArgs(['--category', 'bug', '崩了']), {
    valid: true, category: 'bug', text: '崩了',
  });
  assert.deepStrictEqual(parseFeedbackArgs(['-c', 'idea', '加个开关']), {
    valid: true, category: 'idea', text: '加个开关',
  });
  assert.deepStrictEqual(parseFeedbackArgs(['--category=praise', '很好用']), {
    valid: true, category: 'praise', text: '很好用',
  });
  // 未知类别 → other
  assert.strictEqual(parseFeedbackArgs(['-c', 'zzz', 'x']).category, 'other');
});

test('parseFeedbackArgs:空 / 只有 flag → invalid', () => {
  assert.strictEqual(parseFeedbackArgs([]).valid, false);
  assert.strictEqual(parseFeedbackArgs(['--category', 'bug']).valid, false);
  assert.strictEqual(parseFeedbackArgs(['   ']).valid, false);
  assert.strictEqual(parseFeedbackArgs(undefined).valid, false);
});

test('buildFeedbackDoc:标题含类别键 + 正文 + 环境段', () => {
  const { title, body } = buildFeedbackDoc({
    text: '编辑后光标跳到顶部',
    category: 'bug',
    version: '0.1.146',
    platform: 'linux 5.15.0',
    stamp: '2026-07-01T00:00:00.000Z',
  });
  assert.strictEqual(title, '[feedback][bug] 编辑后光标跳到顶部');
  assert.match(body, /^# 反馈（缺陷）/);
  assert.match(body, /编辑后光标跳到顶部/);
  assert.match(body, /## 环境/);
  assert.match(body, /- khy 版本: 0\.1\.146/);
  assert.match(body, /- 平台: linux 5\.15\.0/);
  assert.match(body, /- 时间: 2026-07-01T00:00:00\.000Z/);
});

test('buildFeedbackDoc:缺环境字段 → 省略环境段;空文本 → 占位', () => {
  const { title, body } = buildFeedbackDoc({ text: '', category: 'idea' });
  assert.strictEqual(title, '[feedback][idea]');
  assert.match(body, /# 反馈（建议）/);
  assert.match(body, /（未填写反馈内容）/);
  assert.doesNotMatch(body, /## 环境/);
});

test('buildFeedbackDoc:长标题截断到 72 带省略号', () => {
  const long = 'x'.repeat(200);
  const { title } = buildFeedbackDoc({ text: long, category: 'other' });
  // 前缀 '[feedback][other] ' + 71 char + '…'
  assert.ok(title.endsWith('…'));
  assert.ok(title.includes('x'.repeat(71)));
});

test('buildFeedbackFilename:时间戳安全化,缺 → draft', () => {
  assert.strictEqual(buildFeedbackFilename('2026-07-01T00:00:00.000Z'), 'feedback-2026-07-01T00-00-00-000Z.md');
  assert.strictEqual(buildFeedbackFilename(''), 'feedback-draft.md');
  assert.strictEqual(buildFeedbackFilename(undefined), 'feedback-draft.md');
  // 不安全字符替换为 -
  assert.strictEqual(buildFeedbackFilename('a/b\\c'), 'feedback-a-b-c.md');
});

test('绝不抛:各入口坏输入', () => {
  assert.doesNotThrow(() => parseFeedbackArgs(null));
  assert.doesNotThrow(() => buildFeedbackDoc(null));
  assert.doesNotThrow(() => buildFeedbackDoc(undefined));
  assert.doesNotThrow(() => buildFeedbackFilename(null));
  assert.doesNotThrow(() => categoryLabel(null));
});
