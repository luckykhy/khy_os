'use strict';

const { validateName } = require('../../src/utils/worktreeName');

describe('worktreeName', () => {
  describe('validateName', () => {
    test('returns false for empty string', () => {
      expect(validateName('')).toBe(false);
    });

    test('returns false for null', () => {
      expect(validateName(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(validateName(undefined)).toBe(false);
    });

    test('returns false for non-string', () => {
      expect(validateName(123)).toBe(false);
    });

    test('returns false for too long name', () => {
      expect(validateName('a'.repeat(65))).toBe(false);
    });

    test('returns false for invalid characters', () => {
      expect(validateName('test name')).toBe(false);
      expect(validateName('test@name')).toBe(false);
    });

    test('returns false for dot', () => {
      expect(validateName('.')).toBe(false);
    });

    test('returns false for double dot', () => {
      expect(validateName('..')).toBe(false);
    });

    test('returns false for empty segment', () => {
      expect(validateName('test//name')).toBe(false);
    });

    test('returns false for dot segment', () => {
      expect(validateName('test/./name')).toBe(false);
    });

    test('returns false for double dot segment', () => {
      expect(validateName('test/../name')).toBe(false);
    });

    test('returns true for valid name', () => {
      expect(validateName('feature-branch')).toBe(true);
      expect(validateName('feature_branch')).toBe(true);
      expect(validateName('feature.branch')).toBe(true);
      expect(validateName('feature/branch')).toBe(true);
      expect(validateName('feature123')).toBe(true);
    });
  });
});
