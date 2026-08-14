'use strict';

/**
 * httpError.test.js — 锁 utils/httpError 口径
 *   (收敛 5 处「造带 statusCode 的 Error」helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const httpError = require('../src/utils/httpError');

test('返回 Error 实例并挂 statusCode', () => {
  const e = httpError(404, 'not found');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.message, 'not found');
  assert.strictEqual(e.statusCode, 404);
});

test('statusCode 原样保留(含非 200 段)', () => {
  assert.strictEqual(httpError(400, 'bad').statusCode, 400);
  assert.strictEqual(httpError(500, 'boom').statusCode, 500);
  assert.strictEqual(httpError(401, 'auth').statusCode, 401);
});

test('每次返回新实例(不共享)', () => {
  const a = httpError(400, 'x');
  const b = httpError(400, 'x');
  assert.notStrictEqual(a, b);
});

test('逐输入等价原体', () => {
  const ref = (statusCode, message) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
  };
  const a = httpError(422, 'unprocessable');
  const b = ref(422, 'unprocessable');
  assert.strictEqual(a.message, b.message);
  assert.strictEqual(a.statusCode, b.statusCode);
});
