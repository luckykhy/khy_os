'use strict';

const { ALLOWED_KEY_PREFIXES, isAllowedSettingKey } = require('../../src/config/settingsWhitelist');

describe('settingsWhitelist', () => {
  describe('ALLOWED_KEY_PREFIXES', () => {
    test('is exported as an array', () => {
      expect(Array.isArray(ALLOWED_KEY_PREFIXES).toBe(true);
    });

    test('contains expected prefixes', () => {
      expect(ALLOWED_KEY_PREFIXES).toContain('system.');
      expect(ALLOWED_KEY_PREFIXES).toContain('user.');
      expect(ALLOWED_KEY_PREFIXES).toContain('security.');
      expect(ALLOWED_KEY_PREFIXES).toContain('trading.');
      expect(ALLOWED_KEY_PREFIXES).toContain('kline.');
    });

    test('has exactly 5 prefixes', () => {
      expect(ALLOWED_KEY_PREFIXES.length).toBe(5);
    });
  });

  describe('isAllowedSettingKey', () => {
    test('returns true for system. prefixed keys', () => {
      expect(isAllowedSettingKey('system.theme').toBe(true);
    });

    test('returns true for user. prefixed keys', () => {
      expect(isAllowedSettingKey('user.name').toBe(true);
    });

    test('returns true for security. prefixed keys', () => {
      expect(isAllowedSettingKey('security.2fa').toBe(true);
    });

    test('returns true for trading. prefixed keys', () => {
      expect(isAllowedSettingKey('trading.enabled').toBe(true);
    });

    test('returns true for kline. prefixed keys', () => {
      expect(isAllowedSettingKey('kline.duration').toBe(true);
    });

    test('returns false for unknown prefix', () => {
      expect(isAllowedSettingKey('unknown.key').toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isAllowedSettingKey('').toBe(false);
    });

    test('returns false for null', () => {
      expect(isAllowedSettingKey(null).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(isAllowedSettingKey(undefined).toBe(false);
    });

    test('returns false for number', () => {
      expect(isAllowedSettingKey(123).toBe(false);
    });

    test('returns false for partial prefix match', () => {
      expect(isAllowedSettingKey('system').toBe(false);
    });

    test('returns false for case-sensitive match', () => {
      expect(isAllowedSettingKey('System.theme').toBe(false);
    });

    test('returns false for object input', () => {
      expect(isAllowedSettingKey({ key: 'system.theme' }).toBe(false);
    });

    test('returns false for array input', () => {
      expect(isAllowedSettingKey(['system.theme']).toBe(false);
    });

    test('returns true for exact prefix only (no suffix)', () => {
      expect(isAllowedSettingKey('system.').toBe(true);
    });

    test('handles prefix with nested dots', () => {
      expect(isAllowedSettingKey('system.theme.dark').toBe(true);
    });
  });
});

