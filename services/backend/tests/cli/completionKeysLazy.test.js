'use strict';

const { isEnabled, buildKeys } = require('../../src/cli/completionKeysLazy');

describe('completionKeysLazy', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: '0' })).toBe(false);
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: 'false' })).toBe(false);
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: 'off' })).toBe(false);
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: 'no' })).toBe(false);
    });

    test('is case-insensitive', () => {
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: 'FALSE' })).toBe(false);
      expect(isEnabled({ KHY_COMPLETION_KEYS_LAZY: 'Off' })).toBe(false);
    });
  });

  describe('buildKeys', () => {
    test('returns array from computeFn', () => {
      const result = buildKeys(() => ['a', 'b', 'c']);
      expect(result).toEqual(['a', 'b', 'c']);
    });

    test('returns empty array on error', () => {
      const result = buildKeys(() => { throw new Error('fail'); });
      expect(result).toEqual([]);
    });

    test('returns empty array for non-array', () => {
      const result = buildKeys(() => 'string');
      expect(result).toEqual([]);
    });
  });
});
