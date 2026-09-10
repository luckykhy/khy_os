'use strict';

const { validateName } = require('../../src/utils/worktreeName');

describe('worktreeName', () => {
  describe('validateName', () => {
    test('returns true for valid simple names', () => {
      expect(validateName('feature-branch')).toBe(true);
      expect(validateName('main')).toBe(true);
      expect(validateName('task123')).toBe(true);
    });

    test('returns true for names with dots', () => {
      expect(validateName('v1.2.3')).toBe(true);
    });

    test('returns true for names with slashes', () => {
      expect(validateName('feature/login')).toBe(true);
      expect(validateName('user/task/name')).toBe(true);
    });

    test('returns true for names with underscores', () => {
      expect(validateName('feature_branch')).toBe(true);
    });

    test('returns false for null', () => {
      expect(validateName(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(validateName(undefined)).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(validateName('')).toBe(false);
    });

    test('returns false for non-string input', () => {
      expect(validateName(123)).toBe(false);
      expect(validateName({})).toBe(false);
      expect(validateName([])).toBe(false);
    });

    test('returns false for "."', () => {
      expect(validateName('.')).toBe(false);
    });

    test('returns false for ".."', () => {
      expect(validateName('..')).toBe(false);
    });

    test('returns false for names > 64 chars', () => {
      const longName = 'a'.repeat(65);
      expect(validateName(longName)).toBe(false);
    });

    test('returns true for names exactly 64 chars', () => {
      const exactName = 'a'.repeat(64);
      expect(validateName(exactName)).toBe(true);
    });

    test('returns false for path traversal segments', () => {
      expect(validateName('feature/../main')).toBe(false);
      expect(validateName('./feature')).toBe(false);
      expect(validateName('feature/..')).toBe(false);
    });

    test('returns false for empty path segments', () => {
      expect(validateName('feature//branch')).toBe(false);
      expect(validateName('/feature')).toBe(false);
      expect(validateName('feature/')).toBe(false);
    });

    test('returns false for invalid characters', () => {
      expect(validateName('feature branch')).toBe(false);
      expect(validateName('feature@branch')).toBe(false);
      expect(validateName('feature!')).toBe(false);
      expect(validateName('feature#1')).toBe(false);
    });

    test('returns false for backslash', () => {
      expect(validateName('feature\\branch')).toBe(false);
    });
  });
});
