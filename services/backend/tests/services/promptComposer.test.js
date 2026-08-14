'use strict';

/**
 * promptComposer.test.js — /prompt 撰写纯叶子(node:test)。
 *
 * 覆盖:buildComposerSeed(顶部 #! 指引 + 初始正文)、stripComposerSentinels(剥 #! 行 / trim / CRLF)、
 * isBlankPrompt、种子→剥离往返、确定性、绝不抛。零 IO。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SENTINEL,
  buildComposerSeed,
  stripComposerSentinels,
  isBlankPrompt,
} = require('../../src/services/promptComposer');

test('SENTINEL 为 #!', () => {
  assert.equal(SENTINEL, '#!');
});

test('buildComposerSeed:含 #! 指引行 + 初始正文', () => {
  const seed = buildComposerSeed('帮我写邮件');
  assert.ok(seed.includes(`${SENTINEL} `), '含哨兵指引行');
  assert.ok(seed.includes('帮我写邮件'), '含初始正文');
  // 指引行都以 #! 起头
  const guideLines = seed.split('\n').filter((l) => l.startsWith(SENTINEL));
  assert.ok(guideLines.length >= 1);
});

test('buildComposerSeed:无初始正文也不抛,仍含指引', () => {
  const seed = buildComposerSeed();
  assert.ok(seed.includes(SENTINEL));
  assert.doesNotThrow(() => buildComposerSeed(null));
  assert.doesNotThrow(() => buildComposerSeed(42));
});

test('stripComposerSentinels:剥掉 #! 行,保留正文,整体 trim', () => {
  const raw = `${SENTINEL} 说明一\n${SENTINEL} 说明二\n\n这是正文第一行\n这是正文第二行\n`;
  assert.equal(stripComposerSentinels(raw), '这是正文第一行\n这是正文第二行');
});

test('stripComposerSentinels:容 CRLF', () => {
  const raw = `${SENTINEL} 指引\r\n\r\n正文\r\n`;
  assert.equal(stripComposerSentinels(raw), '正文');
});

test('stripComposerSentinels:仅 # 开头(非 #!)的行保留', () => {
  const raw = `${SENTINEL} 指引\n# 这是 markdown 标题\n正文`;
  const out = stripComposerSentinels(raw);
  assert.ok(out.includes('# 这是 markdown 标题'), 'markdown # 标题不被当哨兵剥除');
  assert.ok(!out.includes('指引'));
});

test('stripComposerSentinels:全是指引 / 空 → 空串', () => {
  assert.equal(stripComposerSentinels(`${SENTINEL} a\n${SENTINEL} b\n`), '');
  assert.equal(stripComposerSentinels(''), '');
  assert.equal(stripComposerSentinels('   \n  \n'), '');
});

test('往返:种子经编辑器留下正文 → 剥离只得正文', () => {
  const seed = buildComposerSeed('');
  const edited = `${seed}\n用户实际写的长提示词。`;
  assert.equal(stripComposerSentinels(edited), '用户实际写的长提示词。');
});

test('isBlankPrompt:trim 后空 → true', () => {
  assert.equal(isBlankPrompt(''), true);
  assert.equal(isBlankPrompt('   \n\t '), true);
  assert.equal(isBlankPrompt('x'), false);
  assert.equal(isBlankPrompt(null), true);
});

test('确定性:同输入 → 同输出', () => {
  const raw = `${SENTINEL} g\n\n正文`;
  assert.equal(stripComposerSentinels(raw), stripComposerSentinels(raw));
  assert.equal(buildComposerSeed('a'), buildComposerSeed('a'));
});

test('绝不抛:坏输入', () => {
  assert.doesNotThrow(() => stripComposerSentinels(undefined));
  assert.doesNotThrow(() => stripComposerSentinels(42));
  assert.doesNotThrow(() => stripComposerSentinels({}));
  assert.doesNotThrow(() => isBlankPrompt({}));
});
