'use strict';

const {
  sanitizeToolDisplayText,
  fullSanitize,
  sanitizeToolResultObject,
  toolActionLabel,
  toolTarget,
  buildToolDisplay,
} = require('../../src/utils/toolResultSanitizer');

describe('toolResultSanitizer', () => {
  describe('sanitizeToolDisplayText', () => {
    test('returns empty for null/undefined', () => {
      expect(sanitizeToolDisplayText(null)).toBe('');
      expect(sanitizeToolDisplayText(undefined)).toBe('');
    });

    test('strips ANSI codes', () => {
      const result = sanitizeToolDisplayText('\x1b[31m红色文字\x1b[0m');
      expect(result).not.toContain('\x1b');
    });

    test('masks Bearer token', () => {
      const result = sanitizeToolDisplayText('Authorization: Bearer abc123xyz');
      expect(result).toContain('***');
      expect(result).not.toContain('abc123xyz');
    });

    test('masks OpenAI key', () => {
      const result = sanitizeToolDisplayText('sk-abcdefghijklmnopqrstuvwxyz');
      expect(result).toContain('***');
      expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    });

    test('masks named secrets', () => {
      const result = sanitizeToolDisplayText('api_key=secret123');
      expect(result).toContain('***');
      expect(result).not.toContain('secret123');
    });

    test('masks cookie header', () => {
      const result = sanitizeToolDisplayText('Set-Cookie: session=abc123');
      expect(result).toContain('***');
      expect(result).not.toContain('abc123');
    });

    test('truncates long text', () => {
      const longText = 'a'.repeat(200);
      const result = sanitizeToolDisplayText(longText, 160);
      expect(result.length).toBeLessThanOrEqual(163);
      expect(result).toContain('...');
    });

    test('does not truncate short text', () => {
      const shortText = 'short text';
      const result = sanitizeToolDisplayText(shortText, 160);
      expect(result).toBe(shortText);
    });
  });

  describe('fullSanitize', () => {
    test('does not truncate', () => {
      const longText = 'a'.repeat(200);
      const result = fullSanitize(longText);
      expect(result.length).toBe(200);
    });

    test('applies all sanitization', () => {
      const result = fullSanitize('Bearer token123');
      expect(result).toContain('***');
    });
  });

  describe('sanitizeToolResultObject', () => {
    test('sanitizes string values', () => {
      const obj = { token: 'Bearer secret123' };
      const result = sanitizeToolResultObject(obj);
      expect(result.token).toContain('***');
    });

    test('sanitizes nested objects', () => {
      const obj = { nested: { key: 'api_key=secret' } };
      const result = sanitizeToolResultObject(obj);
      expect(result.nested.key).toContain('***');
    });

    test('sanitizes arrays', () => {
      const obj = ['Bearer token123', 'normal text'];
      const result = sanitizeToolResultObject(obj);
      expect(result[0]).toContain('***');
      expect(result[1]).toBe('normal text');
    });

    test('handles non-string primitives', () => {
      const obj = { count: 42, active: true };
      const result = sanitizeToolResultObject(obj);
      expect(result.count).toBe(42);
      expect(result.active).toBe(true);
    });
  });

  describe('toolActionLabel', () => {
    test('returns Chinese label for known tools', () => {
      expect(toolActionLabel('Read')).toBe('查看文件');
      expect(toolActionLabel('Write')).toBe('写入文件');
      expect(toolActionLabel('Edit')).toBe('修改文件');
      expect(toolActionLabel('Glob')).toBe('查找文件');
      expect(toolActionLabel('Grep')).toBe('搜索代码');
      expect(toolActionLabel('shellCommand')).toBe('执行命令');
      expect(toolActionLabel('List')).toBe('查看目录');
    });

    test('returns default for unknown tools', () => {
      expect(toolActionLabel('UnknownTool')).toBe('使用 UnknownTool');
    });
  });

  describe('toolTarget', () => {
    test('returns target for Read', () => {
      expect(toolTarget('Read', { file_path: '/path/to/file' })).toBe('/path/to/file');
    });

    test('returns target for Write', () => {
      expect(toolTarget('Write', { file_path: '/path/to/file' })).toBe('/path/to/file');
    });

    test('returns target for shellCommand', () => {
      expect(toolTarget('shellCommand', { command: 'ls -la' })).toBe('ls -la');
    });

    test('returns target for Glob', () => {
      expect(toolTarget('Glob', { pattern: '**/*.js' })).toBe('**/*.js');
    });

    test('returns empty for unknown tool', () => {
      expect(toolTarget('UnknownTool', { key: 'value' })).toBe('');
    });

    test('returns empty for null args', () => {
      expect(toolTarget('Read', null)).toBe('');
    });

    test('truncates long targets', () => {
      const longPath = '/path/' + 'a'.repeat(200);
      const result = toolTarget('Read', { file_path: longPath });
      expect(result.length).toBeLessThanOrEqual(120);
      expect(result).toContain('...');
    });
  });

  describe('buildToolDisplay', () => {
    test('returns display object for success', () => {
      const result = buildToolDisplay(
        { file_path: '/test' },
        { content: 'line1\nline2\nline3' },
        true
      );
      expect(result.line_count).toBe(3);
      expect(result.error_summary).toBe('');
    });

    test('returns error summary for failure', () => {
      const result = buildToolDisplay(
        { command: 'test' },
        { content: 'Error: something went wrong' },
        false
      );
      expect(result.error_summary).toBeDefined();
      expect(result.error_summary.length).toBeGreaterThan(0);
    });

    test('handles empty content', () => {
      const result = buildToolDisplay({}, {}, true);
      expect(result.line_count).toBe(0);
    });
  });
});
