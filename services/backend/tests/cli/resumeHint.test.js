'use strict';

/**
 * resumeHint 纯叶子单测(node:test)。
 *   node --test services/backend/tests/cli/resumeHint.test.js
 *
 * 证:liveId 分支文案/着色锁定、空 liveId 返 []、renderResumeHintLines 按 tone 映射拼接、
 * 缺映射透传不抛。这是经典 REPL 与 TUI 退出提示的共同真源。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildResumeHintLines, renderResumeHintLines } = require('../../src/cli/resumeHint');

test('buildResumeHintLines: liveId 有值 → 两行,文案锁定', () => {
  const lines = buildResumeHintLines({ liveId: 'sess-123' });
  assert.equal(lines.length, 2);
  // 第一行:说明 + /resume(cyan) + 说明
  assert.deepEqual(lines[0].map((s) => s.tone), ['dim', 'cyan', 'dim']);
  assert.equal(lines[0][1].text, '/resume');
  // 第二行:说明 + khy resume <id>(cyan)
  assert.deepEqual(lines[1].map((s) => s.tone), ['dim', 'cyan']);
  assert.equal(lines[1][1].text, 'khy resume sess-123');
});

test('buildResumeHintLines: 空/缺 liveId → []', () => {
  assert.deepEqual(buildResumeHintLines({ liveId: '' }), []);
  assert.deepEqual(buildResumeHintLines({ liveId: '   ' }), []);
  assert.deepEqual(buildResumeHintLines({}), []);
  assert.deepEqual(buildResumeHintLines(), []);
});

test('buildResumeHintLines: liveId 前后空白被 trim', () => {
  const lines = buildResumeHintLines({ liveId: '  abc  ' });
  assert.equal(lines[1][1].text, 'khy resume abc');
});

test('renderResumeHintLines: 按 tone 映射着色并拼接', () => {
  const lines = buildResumeHintLines({ liveId: 'x1' });
  const out = renderResumeHintLines(lines, {
    dim: (s) => `<d>${s}</d>`,
    cyan: (s) => `<c>${s}</c>`,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0], '<d>  完整对话已保存，下次启动输入 </d><c>/resume</c><d> 即可还原完整上下文</d>');
  assert.equal(out[1], '<d>  或指定会话: </d><c>khy resume x1</c>');
});

test('renderResumeHintLines: 缺 tone 映射 → 原文透传,绝不抛', () => {
  const lines = buildResumeHintLines({ liveId: 'x1' });
  const out = renderResumeHintLines(lines); // 无 toneFns
  assert.equal(out[0], '  完整对话已保存，下次启动输入 /resume 即可还原完整上下文');
  assert.equal(out[1], '  或指定会话: khy resume x1');
});

test('renderResumeHintLines: 空/非数组入参 → []', () => {
  assert.deepEqual(renderResumeHintLines([]), []);
  assert.deepEqual(renderResumeHintLines(null), []);
  assert.deepEqual(renderResumeHintLines(undefined), []);
});
