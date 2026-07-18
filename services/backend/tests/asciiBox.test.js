'use strict';

/**
 * asciiBox.test.js — 锁盒式基元 boxRow/boxRule 的口径。
 *
 * 这是 diskAnalyzeReport / upstreamStudyReport 两处 `_row`/`_rule` 收敛后的
 * 单一真源;此测同时是逐字节回退的护栏:若填充/截断/分隔线规则漂移,两份
 * 报告输出会一起变,此测先红。
 */

const test = require('node:test');
const assert = require('node:assert');

const { boxRow, boxRule } = require('../src/services/asciiBox');

test('boxRow: 右侧补空格到 width,包边框', () => {
  assert.strictEqual(boxRow('hi', 5), '│ hi    │');
  assert.strictEqual(boxRow('', 3), '│     │');
});

test('boxRow: 超宽截断到 width', () => {
  assert.strictEqual(boxRow('abcdef', 3), '│ abc │');
});

test('boxRow: null/undefined → 空串填充', () => {
  assert.strictEqual(boxRow(null, 2), '│    │');
  assert.strictEqual(boxRow(undefined, 2), '│    │');
});

test('boxRule: 无 label → 纯分隔线(width+2 根横线)', () => {
  assert.strictEqual(boxRule('', 4), `├${'─'.repeat(6)}┤`);
  assert.strictEqual(boxRule(undefined, 4), `├${'─'.repeat(6)}┤`);
});

test('boxRule: 有 label → ├─ label ───┤ 填满 width+2', () => {
  const out = boxRule('X', 6);
  assert.ok(out.startsWith('├─ X '), out);
  assert.ok(out.endsWith('┤'), out);
  // 可视长度 = 1(├) + (width+2) 内部 + 1(┤)
  assert.strictEqual([...out].length, 1 + (6 + 2) + 1);
});

test('boxRule: 极窄 label 溢出时 fill 不为负(Math.max 0)', () => {
  const out = boxRule('verylonglabel', 2);
  assert.ok(out.startsWith('├─ verylonglabel '), out);
  assert.ok(out.endsWith('┤'), out);
});

test('纯函数:同输入同输出', () => {
  assert.strictEqual(boxRow('x', 4), boxRow('x', 4));
  assert.strictEqual(boxRule('y', 4), boxRule('y', 4));
});
