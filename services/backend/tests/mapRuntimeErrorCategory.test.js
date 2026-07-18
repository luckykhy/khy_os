'use strict';

/**
 * mapRuntimeErrorCategory.test.js — 锁 utils/mapRuntimeErrorCategory 口径
 *   (收敛 2 处 adapter `mapRuntimeCategory(errorType, errorText)` 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const mapRuntimeErrorCategory = require('../src/utils/mapRuntimeErrorCategory');

test('timeout type/text → stall', () => {
  assert.strictEqual(mapRuntimeErrorCategory('timeout', ''), 'stall');
  assert.strictEqual(mapRuntimeErrorCategory('', 'request timeout after 30s'), 'stall');
  assert.strictEqual(mapRuntimeErrorCategory('TIMEOUT', ''), 'stall');
});

test('network/process/cancelled type → transport', () => {
  assert.strictEqual(mapRuntimeErrorCategory('network', ''), 'transport');
  assert.strictEqual(mapRuntimeErrorCategory('process', ''), 'transport');
  assert.strictEqual(mapRuntimeErrorCategory('cancelled', ''), 'transport');
});

test('传输层正则文本 → transport', () => {
  assert.strictEqual(mapRuntimeErrorCategory('', 'ECONNRESET'), 'transport');
  assert.strictEqual(mapRuntimeErrorCategory('', 'socket hang up'), 'transport');
  assert.strictEqual(mapRuntimeErrorCategory('', 'operation was aborted'), 'transport');
  assert.strictEqual(mapRuntimeErrorCategory('', 'request canceled'), 'transport');
});

test('无 transport 分支(不含 relayApiAdapter 的 transport 文本匹配)', () => {
  // 本 util 刻意不匹配裸 'transport' 文本(那是 relay 的分叉行为)
  assert.strictEqual(mapRuntimeErrorCategory('', 'transport layer'), '');
});

test('未命中 → 空串', () => {
  assert.strictEqual(mapRuntimeErrorCategory('', ''), '');
  assert.strictEqual(mapRuntimeErrorCategory('other', 'some unrelated message'), '');
  assert.strictEqual(mapRuntimeErrorCategory(undefined, undefined), '');
});

test('timeout 优先于 transport', () => {
  assert.strictEqual(mapRuntimeErrorCategory('network', 'timeout'), 'stall');
});
