'use strict';

/**
 * shellTimeoutClamp 测试 —— clamp 而非拒绝:弱模型把 timeout 调到 600000 想绕 60s 空闲超时,
 * 应被封顶到 60000 正常运行,而非撞 schema max 报不透明的 `Invalid tool parameters`。
 */

const test = require('node:test');
const assert = require('node:assert');

const { clampTimeoutParams, CEIL_MS, FLOOR_MS } = require('../src/services/shellTimeoutClamp');

const ON = { KHY_SHELL_TIMEOUT_CLAMP: '1' };
const OFF = { KHY_SHELL_TIMEOUT_CLAMP: '0' };

test('常量:上限 60000 / 下限 1000', () => {
  assert.strictEqual(CEIL_MS, 60000);
  assert.strictEqual(FLOOR_MS, 1000);
});

test('超上限 → 封顶 60000', () => {
  const out = clampTimeoutParams({ command: 'x', timeout: 600000 }, ON);
  assert.strictEqual(out.timeout, 60000);
  assert.strictEqual(out.command, 'x');
});

test('低于下限 → 提到 1000', () => {
  const out = clampTimeoutParams({ timeout: 10 }, ON);
  assert.strictEqual(out.timeout, 1000);
});

test('idleTimeout 同样被 clamp', () => {
  const out = clampTimeoutParams({ idleTimeout: 999999 }, ON);
  assert.strictEqual(out.idleTimeout, 60000);
});

test('区间内数值不动', () => {
  const out = clampTimeoutParams({ timeout: 30000 }, ON);
  assert.strictEqual(out.timeout, 30000);
});

test('非数值 timeout 不动', () => {
  const out = clampTimeoutParams({ timeout: 'abc', command: 'y' }, ON);
  assert.strictEqual(out.timeout, 'abc');
});

test('无需改动时返回同一对象引用(零拷贝)', () => {
  const inp = { command: 'z' };
  const out = clampTimeoutParams(inp, ON);
  assert.strictEqual(out, inp);
});

test('门关 → 逐字节透传(schema max 仍是唯一守门)', () => {
  const inp = { timeout: 600000 };
  const out = clampTimeoutParams(inp, OFF);
  assert.strictEqual(out, inp);
  assert.strictEqual(out.timeout, 600000);
});

test('绝不抛:坏输入返回原样', () => {
  for (const bad of [null, undefined, 42, 'str']) {
    assert.doesNotThrow(() => clampTimeoutParams(bad, ON));
    assert.strictEqual(clampTimeoutParams(bad, ON), bad);
  }
});

test('浮点 timeout 被 floor 后 clamp', () => {
  const out = clampTimeoutParams({ timeout: 61000.7 }, ON);
  assert.strictEqual(out.timeout, 60000);
});
