'use strict';

const { isEnabled, plural, pluralOr } = require('../../src/cli/ccPlural');

describe('ccPlural', () => {
  describe('isEnabled', () => {
    test('returns true by default', () => {
      expect(isEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isEnabled({ KHY_CC_PLURAL: '0' })).toBe(false);
    });
  });

  describe('plural', () => {
    test('returns singular for 1', () => {
      expect(plural(1, 'match')).toBe('match');
    });

    test('returns plural for other numbers', () => {
      expect(plural(0, 'match')).toBe('matches');
      expect(plural(2, 'match')).toBe('matches');
      expect(plural(5, 'file')).toBe('files');
    });

    test('uses custom plural word', () => {
      expect(plural(2, 'child', 'children')).toBe('children');
      expect(plural(1, 'child', 'children')).toBe('child');
    });
  });

  describe('pluralOr', () => {
    test('returns singular when enabled and n=1', () => {
      expect(pluralOr(1, 'match', null, {})).toBe('match');
    });

    test('returns plural when enabled and n!=1', () => {
      expect(pluralOr(5, 'match', null, {})).toBe('matches');
    });

    test('always returns plural when disabled', () => {
      expect(pluralOr(1, 'match', null, { KHY_CC_PLURAL: '0' })).toBe('matches');
      expect(pluralOr(5, 'match', null, { KHY_CC_PLURAL: '0' })).toBe('matches');
    });
  });
});
