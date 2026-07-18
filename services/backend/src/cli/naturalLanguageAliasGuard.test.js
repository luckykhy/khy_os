'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const guard = require(path.join(__dirname, 'naturalLanguageAliasGuard.js'));

test('gate default-on: reserved NL phrase 我是谁 → true', () => {
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase('我是谁', {}), true);
});

test('trim + case-insensitive normalization on reserved match', () => {
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase('  我是谁  ', {}), true);
});

test('non-reserved command alias passes through (returns false)', () => {
  // Command-intent aliases must NOT be treated as reserved NL phrases.
  for (const s of ['登录', 'woshishui', '退出登录', '改密码', 'whoami', '我是谁系统']) {
    assert.strictEqual(guard.isReservedNaturalLanguagePhrase(s, {}), false, `expected false for ${s}`);
  }
});

test('gate off (KHY_NL_ALIAS_GUARD=0) → always false (byte fallback)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      guard.isReservedNaturalLanguagePhrase('我是谁', { KHY_NL_ALIAS_GUARD: off }),
      false,
      `expected false when gate=${off}`,
    );
  }
});

test('gate on for unset / truthy env', () => {
  assert.strictEqual(guard.isEnabled({}), true);
  assert.strictEqual(guard.isEnabled({ KHY_NL_ALIAS_GUARD: 'true' }), true);
  assert.strictEqual(guard.isEnabled({ KHY_NL_ALIAS_GUARD: '1' }), true);
  assert.strictEqual(guard.isEnabled({ KHY_NL_ALIAS_GUARD: 'off' }), false);
});

test('non-string / empty input → false, never throws', () => {
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase('', {}), false);
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase(null, {}), false);
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase(undefined, {}), false);
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase(42, {}), false);
  assert.strictEqual(guard.isReservedNaturalLanguagePhrase({}, {}), false);
});

test('reserved phrase list is frozen and conservative', () => {
  assert.ok(Object.isFrozen(guard.RESERVED_NL_ALIAS_PHRASES));
  assert.ok(guard.RESERVED_NL_ALIAS_PHRASES.includes('我是谁'));
});
