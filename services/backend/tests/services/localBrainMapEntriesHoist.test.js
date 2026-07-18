'use strict';

/**
 * localBrainMapEntriesHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of Object.entries(_CRYPTO_MAP) and
 * Object.entries(_COUNTRY_CODE_MAP) out of _detectCrypto / _detectHoliday.
 * Each was allocated fresh on every crypto/holiday-intent turn; now built once
 * at module load. Behavior (including first-match insertion order and the
 * default fallback) must be byte-identical; the maps are consumed read-only.
 */

const test = require('node:test');
const assert = require('node:assert');

const brain = require('../../src/services/localBrainService');
const { _detectCrypto, _detectHoliday } = brain;

test('crypto detection resolves known keywords to coin ids', () => {
  assert.strictEqual(_detectCrypto('比特币价格').coin, 'bitcoin');
  assert.strictEqual(_detectCrypto('eth 现在多少').coin, 'ethereum');
  assert.strictEqual(_detectCrypto('狗狗币').coin, 'dogecoin');
});

test('crypto detection falls back to bitcoin when no keyword matches', () => {
  // No specific coin keyword present -> default 'bitcoin'.
  assert.strictEqual(_detectCrypto('币价怎么样').coin, 'bitcoin');
});

test('holiday detection resolves country keywords to ISO codes', () => {
  assert.strictEqual(_detectHoliday('美国节假日').country, 'US');
  assert.strictEqual(_detectHoliday('japan holiday').country, 'JP');
  assert.strictEqual(_detectHoliday('德国假期').country, 'DE');
});

test('holiday detection falls back to CN when no country matches', () => {
  assert.strictEqual(_detectHoliday('放假安排').country, 'CN');
});

test('repeated calls are stable (shared entries arrays not corrupted)', () => {
  assert.strictEqual(_detectCrypto('比特币').coin, _detectCrypto('比特币').coin);
  assert.strictEqual(_detectHoliday('美国').country, _detectHoliday('美国').country);
});
