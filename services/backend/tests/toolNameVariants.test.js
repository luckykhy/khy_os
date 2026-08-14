'use strict';

/**
 * toolNameVariants.test.js — 锁 utils/toolNameVariants 口径
 *   (收敛 toolCalling·toolExecutionEngine 2 处 body 相同的 _toolNameVariants)。
 */

const test = require('node:test');
const assert = require('node:assert');

const toolNameVariants = require('../src/utils/toolNameVariants');

test('camelCase → 含 snake_case / camelCase / 全小写 / 原样', () => {
  const v = toolNameVariants('shellCommand');
  assert.ok(v.includes('shellCommand'));
  assert.ok(v.includes('shell_command'));
  assert.ok(v.includes('shellcommand'));
});

test('snake_case 入 → 含 camelCase 变体', () => {
  const v = toolNameVariants('open_app');
  assert.ok(v.includes('open_app'));
  assert.ok(v.includes('openApp'));
});

test('空/非串 → []', () => {
  assert.deepStrictEqual(toolNameVariants(''), []);
  assert.deepStrictEqual(toolNameVariants(null), []);
  assert.deepStrictEqual(toolNameVariants(undefined), []);
});

test('去重(原样即全小写时不重复)', () => {
  const v = toolNameVariants('read');
  assert.strictEqual(new Set(v).size, v.length);
});

test('空格/连字符 → 归一为下划线', () => {
  const v = toolNameVariants('web search');
  assert.ok(v.includes('web_search'));
});

test('纯:不 mutate·同输入同输出', () => {
  const a = toolNameVariants('fooBar');
  const b = toolNameVariants('fooBar');
  assert.deepStrictEqual(a, b);
});
