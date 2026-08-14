'use strict';

/**
 * reqUserId.test.js — 锁 utils/reqUserId 口径
 *   (收敛 4 处 ai-backend 路由「从 req.user 取 id」helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const reqUserId = require('../src/utils/reqUserId');

test('优先 req.user.id', () => {
  assert.strictEqual(reqUserId({ user: { id: 'u1', userId: 'u2' } }), 'u1');
  assert.strictEqual(reqUserId({ user: { id: 7 } }), 7);
});

test('id nullish 时回退 userId', () => {
  assert.strictEqual(reqUserId({ user: { id: null, userId: 'u2' } }), 'u2');
  assert.strictEqual(reqUserId({ user: { userId: 'u9' } }), 'u9');
});

test('id=0 是有效值(不回退·!= null 语义)', () => {
  assert.strictEqual(reqUserId({ user: { id: 0, userId: 'u2' } }), 0);
});

test('req.user 缺失 → falsy', () => {
  assert.strictEqual(reqUserId({}), undefined);
  assert.strictEqual(reqUserId({ user: null }), null);
});

test('逐输入等价原体', () => {
  const ref = (req) => req.user && (req.user.id != null ? req.user.id : req.user.userId);
  const cases = [
    { user: { id: 'a', userId: 'b' } },
    { user: { id: null, userId: 'b' } },
    { user: { id: 0 } },
    { user: {} },
    {},
    { user: null },
  ];
  for (const c of cases) assert.strictEqual(reqUserId(c), ref(c));
});
