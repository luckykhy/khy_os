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
      // Default plural form is word + 's' (CC byte-exact port); irregular -es
      // forms are supplied by call sites via the explicit pluralWord arg.
      expect(plural(0, 'match')).toBe('matchs');
      expect(plural(2, 'match')).toBe('matchs');
      expect(plural(5, 'file')).toBe('files');
    });

    test('uses custom plural word', () => {
      expect(plural(2, 'child', 'children')).toBe('children');
      expect(plural(1, 'child', 'children')).toBe('child');
      expect(plural(2, 'match', 'matches')).toBe('matches');
    });
  });

  describe('pluralOr', () => {
    test('returns singular when enabled and n=1', () => {
      expect(pluralOr(1, 'match', null, {})).toBe('match');
    });

    test('returns plural when enabled and n!=1', () => {
      // Call sites pass the explicit plural form ('matches') — the default
      // word+'s' rule would produce the ungrammatical 'matchs'.
      expect(pluralOr(5, 'match', 'matches', {})).toBe('matches');
      expect(pluralOr(5, 'file', null, {})).toBe('files');
    });

    test('always returns plural when disabled', () => {
      expect(pluralOr(1, 'match', 'matches', { KHY_CC_PLURAL: '0' })).toBe('matches');
      expect(pluralOr(5, 'match', 'matches', { KHY_CC_PLURAL: '0' })).toBe('matches');
    });
  });
});
