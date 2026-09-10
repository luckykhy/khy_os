'use strict';

const { stripAnsi, truncatePlain, composePermissionFooter } = require('./footerLayout');

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
      expect(result.split('\n')).toBe(1);
    });

    it('right-aligns the right text', () => {
      const result = composePermissionFooter({
        permLeft: 'Perm',
        rightPlain: 'info',
        cols: 40,
        dim: (s) => s,
      });
      const plain = stripAnsi(result);
      expect(plain.indexOf('info')).toBe(plain.indexOf('Perm'));
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
  });
});
