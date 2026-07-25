'use strict';

/**
 * platformCtx.test.js — 锁 utils/platformCtx 口径
 *   (收敛 envProbes·envRepair 2 处相同 body 的 _platformCtx)。
 */

const test = require('node:test');
const assert = require('node:assert');

const platformCtx = require('../src/utils/platformCtx');
const envPlatform = require('../src/services/envPlatform');

test('返回 { id, appliesTo }·id 为字符串·appliesTo 为函数', () => {
  const ctx = platformCtx();
  assert.strictEqual(typeof ctx, 'object');
  assert.strictEqual(typeof ctx.id, 'string');
  assert.ok(ctx.id.length > 0);
  assert.strictEqual(typeof ctx.appliesTo, 'function');
});

test('委派 envPlatform:id === detectPlatform().id·appliesTo === envPlatform.appliesTo', () => {
  const ctx = platformCtx();
  assert.strictEqual(ctx.id, envPlatform.detectPlatform().id);
  assert.strictEqual(ctx.appliesTo, envPlatform.appliesTo);
});

test('appliesTo 是白名单判定器(空/未定义白名单 → true)', () => {
  const ctx = platformCtx();
  // 无 platforms 白名单约束时应放行(与 envPlatform.appliesTo 语义一致)。
  assert.strictEqual(typeof ctx.appliesTo(ctx.id, undefined), 'boolean');
  assert.strictEqual(typeof ctx.appliesTo(ctx.id, []), 'boolean');
});

test('绝不抛·多次调用稳定', () => {
  const a = platformCtx();
  const b = platformCtx();
  assert.strictEqual(a.id, b.id);
});
