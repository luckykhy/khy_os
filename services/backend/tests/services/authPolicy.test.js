'use strict';

const {
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  normalizeLoginIdentifier,
  validatePassword,
} = require('../../src/services/authPolicy');

describe('authPolicy', () => {
  test('normalizes login identifiers and email addresses', () => {
    expect(normalizeLoginIdentifier('  Alice  ')).toBe('Alice');
    expect(normalizeEmail('  Alice@Example.COM  ')).toBe('alice@example.com');
  });

  test('applies the shared minimum password length', () => {
    expect(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(
      `密码长度至少${PASSWORD_MIN_LENGTH}个字符`
    );
    expect(validatePassword('x'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });
});
