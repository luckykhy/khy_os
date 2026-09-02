'use strict';

/**
 * classifyKhyError.js 契约测试 —— 任意错误 → KhyError 七件套的归类契约。
 *
 * 优先级链：
 *   1. 已是 KhyError        → 原样透传
 *   2. HTTP status code      → STATUS_TABLE
 *   3. Node 原生 errno       → ERRNO_TABLE
 *   4. err.name              → NAME_TABLE
 *   5. err.message 关键词    → MESSAGE_TABLE
 *   6. 兜底                  → UNKNOWN
 *
 * 每个优先级都要单独验证 —— 防止有人改 verify 顺序而没察觉。
 */
const test = require('node:test');
const assert = require('node:assert');

const { classifyKhyError, ensureKhyError } = require('../../src/utils/classifyKhyError');
const { khyError } = require('../../src/utils/khyError');

test('① 已是 KhyError：原样透传', () => {
  const orig = khyError('AUTH_REQUIRED', '请登录');
  const out = classifyKhyError(orig);
  assert.strictEqual(out, orig, '原样返回引用');
});

test('② HTTP 401 → auth / error', () => {
  const err = Object.assign(new Error('x'), { status: 401 });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'AUTH_REQUIRED');
  assert.strictEqual(out.category, 'auth');
  assert.strictEqual(out.severity, 'error');
});

test('② HTTP 429 → upstream / warn', () => {
  const err = Object.assign(new Error('x'), { status: 429 });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'RATE_LIMITED');
  assert.strictEqual(out.category, 'upstream');
  assert.strictEqual(out.severity, 'warn');
});

test('② HTTP 500 → upstream / warn', () => {
  const err = Object.assign(new Error('x'), { status: 500 });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'UPSTREAM_5XX');
  assert.strictEqual(out.category, 'upstream');
  assert.strictEqual(out.severity, 'warn');
});

test('② axios shape：err.response.status', () => {
  const err = Object.assign(new Error('x'), {
    response: { status: 413, data: { message: 'context too long' } },
  });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'CONTEXT_TOO_LONG');
  assert.strictEqual(out.category, 'upstream');
});

test('③ errno ENOENT → io / error', () => {
  const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'IO_FAILED');
  assert.strictEqual(out.category, 'io');
  assert.strictEqual(out.severity, 'error');
});

test('③ errno ECONNREFUSED → network / error', () => {
  const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'NETWORK_UNREACHABLE');
  assert.strictEqual(out.category, 'network');
});

test('③ errno EADDRINUSE → config / warn', () => {
  const err = Object.assign(new Error('port in use'), { code: 'EADDRINUSE' });
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'PORT_IN_USE');
  assert.strictEqual(out.category, 'config');
  assert.strictEqual(out.severity, 'warn');
});

test('④ err.name=SyntaxError → internal / fatal', () => {
  const err = new SyntaxError('Unexpected token');
  const out = classifyKhyError(err);
  assert.strictEqual(out.category, 'internal');
  assert.strictEqual(out.severity, 'fatal');
});

test('⑤ message 关键词 "rate limit exceeded" → upstream / warn', () => {
  const err = new Error('rate limit exceeded');
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'RATE_LIMITED');
  assert.strictEqual(out.category, 'upstream');
});

test('⑤ message 关键词 "CORS blocked" → network / error', () => {
  const err = new Error('CORS blocked by browser');
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'CORS_BLOCKED');
  assert.strictEqual(out.category, 'network');
});

test('⑤ message 关键词 "context too long" → upstream / warn', () => {
  const err = new Error('prompt is too long for the context window');
  const out = classifyKhyError(err);
  assert.strictEqual(out.code, 'CONTEXT_TOO_LONG');
});

test('⑥ 裸字符串 "x" → unknown / error 兜底', () => {
  const out = classifyKhyError('x');
  assert.strictEqual(out.category, 'unknown');
  assert.strictEqual(out.severity, 'error');
});

test('⑥ null / undefined → unknown / error 兜底', () => {
  const out = classifyKhyError(null);
  assert.strictEqual(out.category, 'unknown');
  assert.strictEqual(out.severity, 'error');
});

test('err.code 优先：未登记的 code 保留原值', () => {
  const out = classifyKhyError(Object.assign(new Error('x'), { code: 'CUSTOM_NOT_REGISTERED' }));
  assert.strictEqual(out.code, 'CUSTOM_NOT_REGISTERED');
});

test('fallbackCode 仅在 err.code 缺失时使用', () => {
  const out = classifyKhyError(new Error('x'), { fallbackCode: 'MY_DOMAIN_ERR' });
  assert.strictEqual(out.code, 'MY_DOMAIN_ERR');
});

test('extra 参数允许覆盖最终输出', () => {
  const err = new Error('x');
  const out = classifyKhyError(err, { extra: { category: 'user', severity: 'warn' } });
  assert.strictEqual(out.category, 'user');
  assert.strictEqual(out.severity, 'warn');
});

test('ensureKhyError 永远返回带 category+severity 的实例', () => {
  const out = ensureKhyError(Object.assign(new Error('x'), { status: 503 }));
  assert.strictEqual(out.category, 'upstream');
  assert.strictEqual(out.severity, 'warn');
  assert.ok(out.code);
});