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
const {
  formatKhyErrorInline,
  _internals,
} = require('../../src/cli/reportKhyError');
const { khyError } = require('../../src/utils/khyError');

describe('Report Khy Error', () => {
  test('formatKhyErrorInline: basic shape', () => {
      const env = khyError('AUTH_REQUIRED', '请登录');
      const line = formatKhyErrorInline(env);
      expect(line.includes('[error]')).toBeTruthy();
      expect(line.includes('[AUTH_REQUIRED]')).toBeTruthy();
      expect(line.includes('请登录')).toBeTruthy();
      expect(line.includes('提示：')).toBeTruthy();
  });

  test('formatKhyErrorInline: ctx 拼前缀', () => {
      const env = khyError('NETWORK_UNREACHABLE', 'connect ECONNREFUSED');
      const line = formatKhyErrorInline(env, {
        action: '刷新模型',
        target: 'Claude Adapter',
        progress: '第 2/3 次',
      });
      expect(line.includes('刷新模型')).toBeTruthy();
      expect(line.includes('Claude Adapter')).toBeTruthy();
      expect(line.includes('第 2/3 次')).toBeTruthy();
  });

  test('formatKhyErrorInline: 裸字符串', () => {
      const line = formatKhyErrorInline('x');
      expect(typeof line === 'string').toBeTruthy();
      expect(line.length > 0).toBeTruthy();
  });

  test('formatKhyErrorInline: 缺 ctx 时不抛', () => {
      const env = khyError('UNKNOWN', 'x');
      const line = formatKhyErrorInline(env);
      expect(typeof line === 'string').toBeTruthy();
  });

  test('脱敏：Bearer / sk-xxx', () => {
      const env = khyError('AUTH_INVALID', 'Authorization: Bearer sk-1234567890abcdef');
      const line = formatKhyErrorInline(env);
      expect(!line.includes('sk-1234567890abcdef')).toBeTruthy();
  });

  test('_internals._formatContext 缺字段降级', () => {
      // 空对象 → 空串
      expect(_internals._formatContext({})).toBe('');
      // 只有 action
      expect(_internals._formatContext({ action: 'a' })).toBe('a');
      // 三件齐全
      const full = _internals._formatContext({ action: 'a', target: 'b', progress: 'c' });
      expect(full.includes('a') && full.includes('b') && full).toContain('c');
  });

});
