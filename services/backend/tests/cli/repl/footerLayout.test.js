'use strict';

const { stripAnsi, truncatePlain, composePermissionFooter } = require('../../../src/cli/repl/footerLayout.js');
const { displayWidth } = require('../../../src/cli/formatters.js');

describe('footerLayout', () => {
  describe('stripAnsi', () => {
    it('removes ANSI color codes', () => {
      expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
      expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
    });

    it('returns plain text unchanged', () => {
      expect(stripAnsi('hello world')).toBe('hello world');
    });

    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    it('handles null/undefined', () => {
      expect(stripAnsi(null)).toBe('');
      expect(stripAnsi(undefined)).toBe('');
    });

    it('handles non-string input', () => {
      expect(stripAnsi(123)).toBe('123');
    });
  });

  describe('truncatePlain', () => {
    it('returns text unchanged when within limit', () => {
      expect(truncatePlain('hello', 10)).toBe('hello');
    });

    it('truncates with ellipsis when over limit', () => {
      expect(truncatePlain('hello world', 8)).toBe('hello w…');
    });

    it('returns empty string when n <= 0', () => {
      expect(truncatePlain('hello', 0)).toBe('');
      expect(truncatePlain('hello', -1)).toBe('');
    });

    it('handles n = 1', () => {
      expect(truncatePlain('hello', 1)).toBe('h');
    });

    it('handles empty string', () => {
      expect(truncatePlain('', 10)).toBe('');
    });

    it('handles null/undefined', () => {
      expect(truncatePlain(null, 10)).toBe('');
      expect(truncatePlain(undefined, 10)).toBe('');
    });

    // BUG-117: width budget is display columns, not UTF-16 code units.
    it('truncates CJK to fit the display-width budget', () => {
      const out = truncatePlain('上下文自动压缩', 5); // 7 CJK chars, width 14 > 5
      expect(displayWidth(out)).toBeLessThanOrEqual(5);
      expect(out).toBe('上下…'); // 上下(4) + …(1) = 5
    });

    it('does not overflow a 1-column budget with a full-width char', () => {
      const out = truncatePlain('中文', 1); // first char is width 2 > 1
      expect(out).toBe('…');
      expect(displayWidth(out)).toBeLessThanOrEqual(1);
    });
  });

  describe('composePermissionFooter', () => {
    it('composes a single-line footer', () => {
      const result = composePermissionFooter({
        permLeft: 'Permission: normal',
        rightPlain: 'ctx: 50%',
        cols: 80,
        dim: (s) => s,
      });
      expect(result).toContain('Permission: normal');
      expect(result).toContain('ctx: 50%');
      // Single line = exactly one segment after splitting on newline.
      expect(result.split('\n')).toHaveLength(1);
    });

    it('right-aligns the right text', () => {
      const result = composePermissionFooter({
        permLeft: 'Perm',
        rightPlain: 'info',
        cols: 40,
        dim: (s) => s,
      });
      const plain = stripAnsi(result);
      // 'info' must start where 'Perm' ends + at least one pad space: right-aligned
      // means the right text sits closer to the width budget than the left label.
      expect(plain.indexOf('info')).toBeGreaterThan(plain.indexOf('Perm'));
      // The whole footer pads out to nearly the full width.
      expect(plain.length).toBeLessThanOrEqual(39);
      expect(plain.length).toBeGreaterThanOrEqual(30);
    });

    it('truncates right text when too long', () => {
      const result = composePermissionFooter({
        permLeft: 'Perm',
        rightPlain: 'a'.repeat(100),
        cols: 40,
        dim: (s) => s,
      });
      expect(stripAnsi(result).length).toBeLessThanOrEqual(39);
    });

    it('truncates left text when too long', () => {
      const result = composePermissionFooter({
        permLeft: 'a'.repeat(100),
        rightPlain: 'info',
        cols: 40,
        dim: (s) => s,
      });
      expect(stripAnsi(result).length).toBeLessThanOrEqual(39);
    });

    it('uses identity when dim is not a function', () => {
      const result = composePermissionFooter({
        permLeft: 'Perm',
        rightPlain: 'info',
        cols: 40,
        dim: null,
      });
      expect(result).toContain('Perm');
      expect(result).toContain('info');
    });

    it('defaults cols to 80 when invalid', () => {
      const result = composePermissionFooter({
        permLeft: 'Perm',
        rightPlain: 'info',
        cols: 0,
        dim: (s) => s,
      });
      expect(stripAnsi(result).length).toBeLessThanOrEqual(80);
    });

    it('never exceeds maxFooterCols', () => {
      const result = composePermissionFooter({
        permLeft: 'a'.repeat(200),
        rightPlain: 'b'.repeat(200),
        cols: 80,
        dim: (s) => s,
      });
      expect(stripAnsi(result).length).toBeLessThanOrEqual(79);
    });

    // BUG-117: the "footer NEVER wraps" hard clamp measured by `.length`, so a
    // CJK bar of length ≤ cols but real width ~2× cols slipped through and the
    // terminal folded it onto a second line. All three cases below had
    // length=79 ≤ cols=80 yet displayWidth=98..109 > 80 before the fix.
    it('keeps a CJK right-info footer on a single line within cols', () => {
      const result = composePermissionFooter({
        permLeft: '自动批准',
        rightPlain: '上下文已用百分之九十五即将自动压缩剩余对话将触发压缩',
        cols: 80,
        dim: (s) => s,
      });
      expect(result.split('\n')).toHaveLength(1);
      expect(displayWidth(stripAnsi(result))).toBeLessThanOrEqual(79);
    });

    it('keeps a CJK left-label footer on a single line within cols', () => {
      const result = composePermissionFooter({
        permLeft: '这是很长的一段权限模式标签用于测试左段中文会不会撑破底栏',
        rightPlain: '42% ctx',
        cols: 80,
        dim: (s) => s,
      });
      expect(result.split('\n')).toHaveLength(1);
      expect(displayWidth(stripAnsi(result))).toBeLessThanOrEqual(79);
    });

    it('keeps a both-CJK footer on a single line within cols', () => {
      const result = composePermissionFooter({
        permLeft: '计划模式待确认',
        rightPlain: '上下文即将自动压缩请留意',
        cols: 80,
        dim: (s) => s,
      });
      expect(result.split('\n')).toHaveLength(1);
      expect(displayWidth(stripAnsi(result))).toBeLessThanOrEqual(79);
    });
  });
});
