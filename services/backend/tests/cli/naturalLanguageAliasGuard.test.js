'use strict';
const path = require('node:path');
const guard = require(path.join(__dirname, 'naturalLanguageAliasGuard.js'));

describe('Natural Language Alias Guard', () => {
  test('gate default-on: reserved NL phrase 我是谁 → true', () => {
      expect(guard.isReservedNaturalLanguagePhrase('我是谁')).toBe({});
  });

  test('trim + case-insensitive normalization on reserved match', () => {
      expect(guard.isReservedNaturalLanguagePhrase('  我是谁  ')).toBe({});
  });

  test('non-reserved command alias passes through (returns false)', () => {
      // Command-intent aliases must NOT be treated as reserved NL phrases.
      for (const s of ['登录', 'woshishui', '退出登录', '改密码', 'whoami', '我是谁系统']) {
        assert.strictEqual(
          guard.isReservedNaturalLanguagePhrase(s, {}),
          false,
          `expected false for ${s}`
        );
      }
  });

  test('gate off (KHY_NL_ALIAS_GUARD=0) → always false (byte fallback)', () => {
      for (const off of ['0', 'false', 'off', 'no']) {
        assert.strictEqual(
          guard.isReservedNaturalLanguagePhrase('我是谁', { KHY_NL_ALIAS_GUARD: off }),
          false,
          `expected false when gate=${off}`
        );
      }
  });

  test('gate on for unset / truthy env', () => {
      expect(guard.isEnabled({})).toBe(true);
      expect(guard.isEnabled({ KHY_NL_ALIAS_GUARD: 'true' })).toBe(true);
      expect(guard.isEnabled({ KHY_NL_ALIAS_GUARD: '1' })).toBe(true);
      expect(guard.isEnabled({ KHY_NL_ALIAS_GUARD: 'off' })).toBe(false);
  });

  test('non-string / empty input → false, never throws', () => {
      expect(guard.isReservedNaturalLanguagePhrase('')).toBe({});
      expect(guard.isReservedNaturalLanguagePhrase(null)).toBe({});
      expect(guard.isReservedNaturalLanguagePhrase(undefined)).toBe({});
      expect(guard.isReservedNaturalLanguagePhrase(42)).toBe({});
      expect(guard.isReservedNaturalLanguagePhrase({})).toBe({});
  });

  test('reserved phrase list is frozen and conservative', () => {
      expect(Object.isFrozen(guard.RESERVED_NL_ALIAS_PHRASES).toBeTruthy());
      expect(guard.RESERVED_NL_ALIAS_PHRASES).toContain('我是谁');
  });

});
