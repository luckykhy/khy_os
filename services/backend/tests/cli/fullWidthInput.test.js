'use strict';

const { fullWidthInputEnabled, normalizeFullWidthDigits, normalizeFullWidthSpace, foldDigits, foldSpace } = require('../../src/cli/fullWidthInput');

describe('fullWidthInput', () => {
  describe('fullWidthInputEnabled', () => {
    test('returns true by default', () => {
      expect(fullWidthInputEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: '0' })).toBe(false);
      expect(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: 'false' })).toBe(false);
      expect(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: 'off' })).toBe(false);
      expect(fullWidthInputEnabled({ KHY_FULLWIDTH_INPUT: 'no' })).toBe(false);
    });
  });

  describe('normalizeFullWidthDigits', () => {
    test('converts fullwidth digits to ASCII', () => {
      expect(normalizeFullWidthDigits('０１２３４５６７８９')).toBe('0123456789');
    });

    test('preserves ASCII digits', () => {
      expect(normalizeFullWidthDigits('123')).toBe('123');
    });

    test('handles mixed input', () => {
      expect(normalizeFullWidthDigits('abc５def')).toBe('abc5def');
    });

    test('handles null/undefined', () => {
      expect(normalizeFullWidthDigits(null)).toBe('');
      expect(normalizeFullWidthDigits(undefined)).toBe('');
    });
  });

  describe('normalizeFullWidthSpace', () => {
    test('converts fullwidth space to ASCII', () => {
      expect(normalizeFullWidthSpace('hello　world')).toBe('hello world');
    });

    test('handles null/undefined', () => {
      expect(normalizeFullWidthSpace(null)).toBe('');
    });
  });

  describe('foldDigits', () => {
    test('folds when enabled', () => {
      expect(foldDigits('５', {})).toBe('5');
    });

    test('does not fold when disabled', () => {
      expect(foldDigits('５', { KHY_FULLWIDTH_INPUT: '0' })).toBe('５');
    });
  });

  describe('foldSpace', () => {
    test('folds when enabled', () => {
      expect(foldSpace('　', {})).toBe(' ');
    });

    test('does not fold when disabled', () => {
      expect(foldSpace('　', { KHY_FULLWIDTH_INPUT: '0' })).toBe('　');
    });
  });
});
