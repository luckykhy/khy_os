'use strict';

const {
  isEnabled,
  detectEnvCorruption,
  repairEnvLines,
} = require('../../src/services/configRepairPolicy');

describe('configRepairPolicy', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isEnabled({ KHY_CONFIG_REPAIR: '1' })).toBe(true);
      expect(isEnabled({ KHY_CONFIG_REPAIR: 'true' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_CONFIG_REPAIR: '0' })).toBe(false);
      expect(isEnabled({ KHY_CONFIG_REPAIR: 'false' })).toBe(false);
      expect(isEnabled({ KHY_CONFIG_REPAIR: 'off' })).toBe(false);
      expect(isEnabled({ KHY_CONFIG_REPAIR: 'no' })).toBe(false);
    });
  });

  describe('detectEnvCorruption', () => {
    test('returns safe when disabled', () => {
      const result = detectEnvCorruption(['KEY=value'], { env: { KHY_CONFIG_REPAIR: '0' } });
      expect(result.isCorrupted).toBe(false);
      expect(result.issues).toEqual([]);
    });

    test('returns safe for non-array', () => {
      const result = detectEnvCorruption('not an array', {});
      expect(result.isCorrupted).toBe(false);
      expect(result.issues).toEqual([]);
    });

    test('detects malformed line (no =)', () => {
      const result = detectEnvCorruption(['KEY=value', 'malformed line'], {});
      expect(result.isCorrupted).toBe(true);
      expect(result.issues.some(i => i.type === 'malformed-line')).toBe(true);
    });

    test('detects empty key', () => {
      const result = detectEnvCorruption(['=value'], {});
      expect(result.isCorrupted).toBe(true);
      expect(result.issues.some(i => i.type === 'empty-key')).toBe(true);
    });

    test('detects duplicate key', () => {
      const result = detectEnvCorruption(['KEY=value1', 'KEY=value2'], {});
      expect(result.isCorrupted).toBe(true);
      expect(result.issues.some(i => i.type === 'duplicate-key')).toBe(true);
    });

    test('detects unclosed quote', () => {
      const result = detectEnvCorruption(['KEY="value'], {});
      expect(result.isCorrupted).toBe(true);
      expect(result.issues.some(i => i.type === 'unclosed-quote')).toBe(true);
    });

    test('skips empty lines and comments', () => {
      const result = detectEnvCorruption(['', '# comment', 'KEY=value'], {});
      expect(result.isCorrupted).toBe(false);
      expect(result.issues).toEqual([]);
    });

    test('valid env is not corrupted', () => {
      const result = detectEnvCorruption(['KEY=value', 'OTHER="quoted"'], {});
      expect(result.isCorrupted).toBe(false);
    });

    test('reports correct line numbers', () => {
      const result = detectEnvCorruption(['KEY=value', 'bad line'], {});
      const issue = result.issues.find(i => i.type === 'malformed-line');
      expect(issue.line).toBe(2);
    });
  });

  describe('repairEnvLines', () => {
    test('returns unchanged when disabled', () => {
      const lines = ['KEY=value', 'bad line'];
      const result = repairEnvLines(lines, [{ line: 2, type: 'malformed-line' }], { env: { KHY_CONFIG_REPAIR: '0' } });
      expect(result.repaired).toEqual(lines);
      expect(result.removed).toBe(0);
    });

    test('returns unchanged for non-array', () => {
      const result = repairEnvLines(null, [], {});
      expect(result.repaired).toEqual([]);
      expect(result.removed).toBe(0);
    });

    test('returns unchanged when no issues', () => {
      const lines = ['KEY=value'];
      const result = repairEnvLines(lines, [], {});
      expect(result.repaired).toEqual(lines);
      expect(result.removed).toBe(0);
    });

    test('removes malformed lines', () => {
      const lines = ['KEY=value', 'bad line', 'OTHER=test'];
      const issues = [{ line: 2, type: 'malformed-line' }];
      const result = repairEnvLines(lines, issues, {});
      expect(result.repaired).toEqual(['KEY=value', 'OTHER=test']);
      expect(result.removed).toBe(1);
    });

    test('removes empty-key lines', () => {
      const lines = ['KEY=value', '=nokey'];
      const issues = [{ line: 2, type: 'empty-key' }];
      const result = repairEnvLines(lines, issues, {});
      expect(result.repaired).toEqual(['KEY=value']);
    });

    test('removes unclosed-quote lines', () => {
      const lines = ['KEY=value', '"unclosed'];
      const issues = [{ line: 2, type: 'unclosed-quote' }];
      const result = repairEnvLines(lines, issues, {});
      expect(result.repaired).toEqual(['KEY=value']);
    });

    test('keeps last duplicate key', () => {
      const lines = ['KEY=first', 'KEY=second'];
      const issues = [{
        line: 1,
        type: 'duplicate-key',
        message: '键 "KEY" 重复出现在行: 1, 2',
      }];
      const result = repairEnvLines(lines, issues, {});
      expect(result.repaired).toEqual(['KEY=second']);
      expect(result.removed).toBe(1);
    });

    test('handles multiple issue types', () => {
      const lines = ['KEY=value', 'bad', '=empty'];
      const issues = [
        { line: 2, type: 'malformed-line' },
        { line: 3, type: 'empty-key' },
      ];
      const result = repairEnvLines(lines, issues, {});
      expect(result.repaired).toEqual(['KEY=value']);
      expect(result.removed).toBe(2);
    });
  });
});
