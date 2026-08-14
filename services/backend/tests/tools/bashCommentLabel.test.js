'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  extractBashCommentLabel,
  extractBashCommentLabelForDisplay,
  MAX_LABEL_CHARS,
} = require('../../src/tools/bashCommentLabel');

const ON = {};
const OFF = { KHY_BASH_COMMENT_LABEL: '0' };

test('首行 # 注释 → 标签(CC parity)', () => {
  assert.strictEqual(extractBashCommentLabel('# 清理缓存\nrm -rf cache', ON), '清理缓存');
});

test('单行命令本身就是注释', () => {
  assert.strictEqual(extractBashCommentLabel('# just a note', ON), 'just a note');
});

test('多个 # 与空白被剥离', () => {
  assert.strictEqual(extractBashCommentLabel('###   build step\nmake', ON), 'build step');
});

test('shebang #! 不算标签 → undefined', () => {
  assert.strictEqual(extractBashCommentLabel('#!/bin/bash\necho hi', ON), undefined);
});

test('首行非注释 → undefined(回退动词猜测)', () => {
  assert.strictEqual(extractBashCommentLabel('npm install\n# trailing comment', ON), undefined);
});

test('空注释(# 后无内容)→ undefined', () => {
  assert.strictEqual(extractBashCommentLabel('#\nrm x', ON), undefined);
  assert.strictEqual(extractBashCommentLabel('#   \nrm x', ON), undefined);
});

test('注释前有空行/空白:trim 后仍识别', () => {
  assert.strictEqual(extractBashCommentLabel('   # 安装依赖\nnpm i', ON), '安装依赖');
});

test('门控关 KHY_BASH_COMMENT_LABEL=0 → undefined(逐字节回退)', () => {
  assert.strictEqual(extractBashCommentLabel('# 清理缓存\nrm -rf cache', OFF), undefined);
});

test('门控关 false/off/no 同回退', () => {
  for (const v of ['false', 'off', 'no', 'FALSE', 'Off']) {
    assert.strictEqual(extractBashCommentLabel('# x\ncmd', { KHY_BASH_COMMENT_LABEL: v }), undefined);
  }
});

test('空/null/undefined 命令绝不抛 → undefined', () => {
  assert.strictEqual(extractBashCommentLabel('', ON), undefined);
  assert.strictEqual(extractBashCommentLabel(null, ON), undefined);
  assert.strictEqual(extractBashCommentLabel(undefined, ON), undefined);
});

test('display 变体:超 160 字符截断 + …', () => {
  const long = '# ' + 'A'.repeat(200) + '\ncmd';
  const out = extractBashCommentLabelForDisplay(long, ON);
  assert.strictEqual(out.length, MAX_LABEL_CHARS + 1); // 160 + '…'
  assert.ok(out.endsWith('…'));
  assert.strictEqual(out.slice(0, MAX_LABEL_CHARS), 'A'.repeat(MAX_LABEL_CHARS));
});

test('display 变体:短标签原样返回不截断', () => {
  assert.strictEqual(extractBashCommentLabelForDisplay('# 短标签\ncmd', ON), '短标签');
});

test('display 变体:门控关 → undefined', () => {
  assert.strictEqual(extractBashCommentLabelForDisplay('# x\ncmd', OFF), undefined);
});
