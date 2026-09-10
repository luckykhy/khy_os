'use strict';
const authTime = require('../authTimeFormat');
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
test('formatAuthTimestamp: valid ISO → localized non-empty, never "Invalid Date"', () => {
  const out = authTime.formatAuthTimestamp('2026-06-01T16:23:07.000Z', { locale: 'zh-CN' });
  expect(typeof out === 'string' && out.length > 0).toBeTruthy();
  expect(!out.toLowerCase()).toContain('invalid');
});

describe('Auth Time Format', () => {
  test('gate default-on; only {0,false,off,no} disable', () => {
      expect(authTime.isEnabled({})).toBe(true);
      expect(authTime.isEnabled({ KHY_AUTH_DATE_SANE: 'true' })).toBe(true);
      expect(authTime.isEnabled({ KHY_AUTH_DATE_SANE: '0' })).toBe(false);
      expect(authTime.isEnabled({ KHY_AUTH_DATE_SANE: 'off' })).toBe(false);
  });

  test('formatAuthTimestamp: undefined/null/empty/invalid → fallback 未知', () => {
      for (const bad of [undefined, null, '', 'not-a-date', NaN]) {
        assert.strictEqual(
          authTime.formatAuthTimestamp(bad),
          '未知',
          `expected fallback for ${String(bad)}`
        );
      }
  });

  test('formatAuthTimestamp: custom fallback honored', () => {
      expect(authTime.formatAuthTimestamp(undefined, { fallback: '永不过期' })).toBe('永不过期');
  });

  test('formatAuthTimestamp: markExpired appends (已过期) for past expiry', () => {
      const now = 2_000_000_000_000; // fixed injected clock
      const past = new Date(now - DAY).toISOString();
      const future = new Date(now + DAY).toISOString();
      expect(authTime.formatAuthTimestamp(past).toBeTruthy();
      expect(!authTime.formatAuthTimestamp(future).toBeTruthy();
  });

  test('formatAuthTimestamp: markExpired invalid value still → fallback (no crash)', () => {
      assert.strictEqual(
        authTime.formatAuthTimestamp(undefined, { markExpired: true, now: 1 }),
        '未知'
      );
  });

  test('deriveSessionExpiry: existing valid expiresAt preferred', () => {
      const exp = '2026-12-31T00:00:00.000Z';
      assert.strictEqual(
        authTime.deriveSessionExpiry(exp, '2026-06-01T00:00:00.000Z', WEEK),
        new Date(exp).toISOString()
      );
  });

  test('deriveSessionExpiry: missing expiresAt derived from loginAt + maxAge', () => {
      const loginAt = '2026-06-01T00:00:00.000Z';
      const expected = new Date(new Date(loginAt).getTime() + WEEK).toISOString();
      expect(authTime.deriveSessionExpiry(null, loginAt, WEEK)).toBe(expected);
      expect(authTime.deriveSessionExpiry(undefined, loginAt, WEEK)).toBe(expected);
  });

  test('deriveSessionExpiry: no valid basis → null', () => {
      expect(authTime.deriveSessionExpiry(null, null, WEEK)).toBe(null);
      expect(authTime.deriveSessionExpiry(null, 'bad', WEEK)).toBe(null);
      expect(authTime.deriveSessionExpiry(null, '2026-06-01T00:00:00.000Z', 0)).toBe(null);
  });

});
