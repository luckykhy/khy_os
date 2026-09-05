'use strict';

const {
  validateNotDevicePath,
  validateNotNoop,
  validateNotUNCPath,
  composeValidations,
  MAX_READ_FILE_SIZE,
  MAX_EDIT_FILE_SIZE,
} = require('../../src/tools/inputValidators');

describe('inputValidators', () => {
  describe('validateNotDevicePath', () => {
    test('valid for regular path', () => {
      const result = validateNotDevicePath('/tmp/test.txt');
      expect(result.valid).toBe(true);
    });

    test('valid for home path', () => {
      const result = validateNotDevicePath('/home/user/file');
      expect(result.valid).toBe(true);
    });

    test('blocks /dev/zero', () => {
      const result = validateNotDevicePath('/dev/zero');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('Blocked');
    });

    test('blocks /dev/random', () => {
      const result = validateNotDevicePath('/dev/random');
      expect(result.valid).toBe(false);
    });

    test('blocks /dev/stdin', () => {
      const result = validateNotDevicePath('/dev/stdin');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateNotNoop', () => {
    test('valid when strings differ', () => {
      const result = validateNotNoop('old text', 'new text');
      expect(result.valid).toBe(true);
    });

    test('invalid when strings are identical', () => {
      const result = validateNotNoop('same text', 'same text');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('No-op');
    });

    test('valid when both empty', () => {
      const result = validateNotNoop('', '');
      expect(result.valid).toBe(false);
    });

    test('valid when case differs', () => {
      const result = validateNotNoop('Text', 'text');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateNotUNCPath', () => {
    test('valid for regular path', () => {
      const result = validateNotUNCPath('/tmp/test.txt');
      expect(result.valid).toBe(true);
    });

    test('valid for relative path', () => {
      const result = validateNotUNCPath('test.txt');
      expect(result.valid).toBe(true);
    });

    test('valid for empty string', () => {
      const result = validateNotUNCPath('');
      expect(result.valid).toBe(true);
    });

    test('valid for null', () => {
      const result = validateNotUNCPath(null);
      expect(result.valid).toBe(true);
    });

    test('valid for undefined', () => {
      const result = validateNotUNCPath(undefined);
      expect(result.valid).toBe(true);
    });

    test('blocks Windows UNC path', () => {
      const result = validateNotUNCPath('\\\\server\\share');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('UNC');
    });

    test('blocks UNC path with forward slashes', () => {
      const result = validateNotUNCPath('//server/share');
      expect(result.valid).toBe(false);
    });
  });

  describe('composeValidations', () => {
    test('returns valid when all valid', () => {
      const result = composeValidations({ valid: true }, { valid: true });
      expect(result.valid).toBe(true);
    });

    test('returns first failure', () => {
      const fail1 = { valid: false, message: 'first error' };
      const fail2 = { valid: false, message: 'second error' };
      const result = composeValidations({ valid: true }, fail1, fail2);
      expect(result.valid).toBe(false);
      expect(result.message).toBe('first error');
    });

    test('returns valid for no results', () => {
      const result = composeValidations();
      expect(result.valid).toBe(true);
    });

    test('stops at first failure', () => {
      const fail1 = { valid: false, message: 'error1' };
      const result = composeValidations(fail1, { valid: false, message: 'error2' });
      expect(result.message).toBe('error1');
    });
  });

  describe('MAX_READ_FILE_SIZE', () => {
    test('is 500 KB', () => {
      expect(MAX_READ_FILE_SIZE).toBe(500 * 1024);
    });
  });

  describe('MAX_EDIT_FILE_SIZE', () => {
    test('is 2 MB', () => {
      expect(MAX_EDIT_FILE_SIZE).toBe(2 * 1024 * 1024);
    });
  });
});
