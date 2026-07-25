'use strict';

/**
 * toolErrorDetails.test.js —— ToolError 新增 details 字段的加性行为(向后兼容)。
 * 关键不变量:不设 details 时 toStructuredResult() 形状逐字节不变(无 details 键)。
 * node:test(既有 tests/services/toolError.test.js 是 jest,二者并存)。
 */

const test = require('node:test');
const assert = require('node:assert');

const { ToolError } = require('../src/services/toolError');

test('不设 details → 结构化结果无 details 键(向后兼容)', () => {
  const r = new ToolError('TIMEOUT', 'timed out').toStructuredResult();
  assert.equal(r.success, false);
  assert.deepEqual(Object.keys(r.error).sort(), ['code', 'hint', 'message', 'recoverable', 'retryable']);
  assert.equal('details' in r.error, false);
});

test('显式 details → 出现在结构化结果', () => {
  const r = new ToolError('EXECUTION_ERROR', 'boom', {
    details: { exitCode: 2, syscall: 'spawn' },
  }).toStructuredResult();
  assert.deepEqual(r.error.details, { exitCode: 2, syscall: 'spawn' });
});

test('非对象 details → 归一为 null(不污染形状)', () => {
  const e = new ToolError('EXECUTION_ERROR', 'x', { details: 'nope' });
  assert.equal(e.details, null);
  assert.equal('details' in e.toStructuredResult().error, false);
});

test('fromGenericError: 从 errno/syscall/code/path 自动提取 details', () => {
  const orig = new Error('ENOENT: no such file');
  orig.code = 'ENOENT';
  orig.errno = -2;
  orig.syscall = 'open';
  orig.path = '/tmp/missing';
  const wrapped = ToolError.fromGenericError(orig);
  assert.equal(wrapped.code, 'RESOURCE_NOT_FOUND'); // 既有推断不变
  assert.deepEqual(wrapped.details, { code: 'ENOENT', errno: -2, syscall: 'open', path: '/tmp/missing' });
  const r = wrapped.toStructuredResult();
  assert.equal(r.error.details.code, 'ENOENT');
});

test('fromGenericError: 无结构化字段 → details 为 null,结果无 details 键', () => {
  const wrapped = ToolError.fromGenericError(new Error('plain failure'));
  assert.equal(wrapped.details, null);
  assert.equal('details' in wrapped.toStructuredResult().error, false);
});

test('fromGenericError: 自定义 errorName 进入 details', () => {
  const orig = new TypeError('bad type');
  const wrapped = ToolError.fromGenericError(orig);
  assert.equal(wrapped.details && wrapped.details.errorName, 'TypeError');
});

test('fromGenericError: options.details 显式覆盖自动提取', () => {
  const orig = new Error('x');
  orig.code = 'ENOENT';
  const wrapped = ToolError.fromGenericError(orig, { details: { custom: 1 } });
  assert.deepEqual(wrapped.details, { custom: 1 });
});

test('既有 toStructuredResult 字段保持不变(回归)', () => {
  const r = new ToolError('PERMISSION_DENIED', 'No access', { retryable: false }).toStructuredResult();
  assert.equal(r.error.code, 'PERMISSION_DENIED');
  assert.equal(r.error.message, 'No access');
  assert.equal(r.error.retryable, false);
  assert.equal(r.error.recoverable, true);
  assert.ok(r.error.hint);
});
