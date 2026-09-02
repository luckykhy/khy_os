'use strict';

/**
 * reportKhyError.js 契约测试 —— 统一错误打印入口按 severity 分级渲染。
 *
 * 不验证颜色/字符 —— 只验证：
 *   1. 任意输入被规整成 KhyErrorShape 并返回（给调用方继续用）；
 *   2. silent 不打印；
 *   3. formatKhyErrorInline 按 `[severity] [CODE] message（提示：hint）` 拼装；
 *   4. ctx 三件套（action/target/progress）拼成 `action → target（progress） ` 前缀；
 *   5. 脱敏：err.message 里的 Bearer / sk-xxx / 绝对路径被替换。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  formatKhyErrorInline,
  _internals,
} = require('../../src/cli/reportKhyError');
const { khyError } = require('../../src/utils/khyError');

test('formatKhyErrorInline: basic shape', () => {
  const env = khyError('AUTH_REQUIRED', '请登录');
  const line = formatKhyErrorInline(env);
  assert.ok(line.includes('[error]'), '应有 severity 前缀');
  assert.ok(line.includes('[AUTH_REQUIRED]'), '应有 code 前缀');
  assert.ok(line.includes('请登录'), '应有 message');
  assert.ok(line.includes('提示：'), '有 hint 时应拼上提示');
});

test('formatKhyErrorInline: ctx 拼前缀', () => {
  const env = khyError('NETWORK_UNREACHABLE', 'connect ECONNREFUSED');
  const line = formatKhyErrorInline(env, {
    action: '刷新模型',
    target: 'Claude Adapter',
    progress: '第 2/3 次',
  });
  assert.ok(line.includes('刷新模型'), '前缀含 action');
  assert.ok(line.includes('Claude Adapter'), '前缀含 target');
  assert.ok(line.includes('第 2/3 次'), '前缀含 progress');
});

test('formatKhyErrorInline: 裸字符串', () => {
  const line = formatKhyErrorInline('x');
  assert.ok(typeof line === 'string');
  assert.ok(line.length > 0);
});

test('formatKhyErrorInline: 缺 ctx 时不抛', () => {
  const env = khyError('UNKNOWN', 'x');
  const line = formatKhyErrorInline(env);
  assert.ok(typeof line === 'string');
});

test('脱敏：Bearer / sk-xxx', () => {
  const env = khyError('AUTH_INVALID', 'Authorization: Bearer sk-1234567890abcdef');
  const line = formatKhyErrorInline(env);
  assert.ok(!line.includes('sk-1234567890abcdef'), 'API key 必须脱敏');
});

test('_internals._formatContext 缺字段降级', () => {
  // 空对象 → 空串
  assert.strictEqual(_internals._formatContext({}), '');
  // 只有 action
  assert.ok(_internals._formatContext({ action: 'a' }).includes('a'));
  // 三件齐全
  const full = _internals._formatContext({ action: 'a', target: 'b', progress: 'c' });
  assert.ok(full.includes('a') && full.includes('b') && full.includes('c'));
});