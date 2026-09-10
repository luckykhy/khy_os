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
const brain = require('../../src/services/localBrainService');
const { _detectCrypto, _detectHoliday } = brain;

describe('Local Brain Map Entries Hoist', () => {
  test('crypto detection resolves known keywords to coin ids', () => {
      expect(_detectCrypto('比特币价格').coin).toBe('bitcoin');
      expect(_detectCrypto('eth 现在多少').coin).toBe('ethereum');
      expect(_detectCrypto('狗狗币').coin).toBe('dogecoin');
  });

  test('crypto detection falls back to bitcoin when no keyword matches', () => {
      // No specific coin keyword present -> default 'bitcoin'.
      expect(_detectCrypto('币价怎么样').coin).toBe('bitcoin');
  });

  test('holiday detection resolves country keywords to ISO codes', () => {
      expect(_detectHoliday('美国节假日').country).toBe('US');
      expect(_detectHoliday('japan holiday').country).toBe('JP');
      expect(_detectHoliday('德国假期').country).toBe('DE');
  });

  test('holiday detection falls back to CN when no country matches', () => {
      expect(_detectHoliday('放假安排').country).toBe('CN');
  });

  test('repeated calls are stable (shared entries arrays not corrupted)', () => {
      expect(_detectCrypto('比特币').coin).toBe(_detectCrypto('比特币').coin);
      expect(_detectHoliday('美国').country).toBe(_detectHoliday('美国').country);
  });

});
