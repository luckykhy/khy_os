'use strict';
/**
 * stripAnsi.test.js — 锁 utils/stripAnsi 口径(收敛 5 处裸参 SGR-剥离 helper 的护栏)。
 */
const stripAnsi = require('../src/utils/stripAnsi');

describe('Strip Ansi', () => {
  test('剥离 SGR 颜色码,保留可见文本', () => {
      expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
      expect(stripAnsi('\x1b[1;32mbold green\x1b[0m tail')).toBe('bold green tail');
  });

  test('无 ANSI 原样返回', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
      expect(stripAnsi('')).toBe('');
  });

  test('仅剥 …m 形 SGR,不动其他控制序列(与原体一致)', () => {
      // [2026-09-22] 本条预期已随修复反转:/u65e7 body 只认纯数字/分号参数的 SGR,
      // 非 SGR 的 CSI 一律漏剥,导致可见残骸(用户所见 `1m`)。现 body 委托
      // cli/ansiSanitizer 做完整覆盖。病灶链路见 .khy/feedback/structured-output-20260922/。
      expect(stripAnsi('\x1b[2Akeep')).toBe('keep');
  });

  test('裸参:非字符串抛(与被收敛五簇假定字符串输入一致)', () => {
      expect(() => stripAnsi(null)).toThrow();
      expect(() => stripAnsi(42)).toThrow();
  });

});
