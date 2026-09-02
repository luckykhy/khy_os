'use strict';

/**
 * tuiErrorAdapter.js 契约测试 —— TUI 错误推流适配层。
 */
const test = require('node:test');
const assert = require('node:assert');

const { tuiErrorOf } = require('../../src/cli/tui/tuiErrorAdapter');

test('tuiErrorOf 返回字符串，TUI 消息流可消化', () => {
  const out = tuiErrorOf(new Error('connect ECONNREFUSED'));
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length > 0);
});

test('tuiErrorOf 字符串带 severity + category + code 前缀', () => {
  const out = tuiErrorOf(Object.assign(new Error('x'), { status: 429 }));
  assert.ok(out.includes('[warn]'), 'severity 前缀');
  assert.ok(out.includes('上游服务'), 'category 中文 label');
  assert.ok(out.includes('RATE_LIMITED'), 'code');
});

test('tuiErrorOf: 有 hint 时拼上 "提示："', () => {
  const out = tuiErrorOf(Object.assign(new Error('x'), { status: 401 }));
  assert.ok(out.includes('提示：'));
});

test('tuiErrorOf: 缺 ctx 时不抛', () => {
  assert.doesNotThrow(() => tuiErrorOf(new Error('x')));
});

test('tuiErrorOf: ctx.action / target 拼入', () => {
  const out = tuiErrorOf(new Error('x'), { action: '探测模型', target: '网关' });
  assert.ok(out.includes('探测模型'));
  assert.ok(out.includes('网关'));
});

test('tuiErrorOf: 裸字符串', () => {
  const out = tuiErrorOf('just a message');
  assert.ok(typeof out === 'string');
  assert.ok(out.length > 0);
});

test('tuiErrorOf: 脱敏 Bearer / sk-xxx', () => {
  const out = tuiErrorOf(new Error('Authorization: Bearer sk-abcdef1234567890'));
  assert.ok(!out.includes('sk-abcdef1234567890'));
});