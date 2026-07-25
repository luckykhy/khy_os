'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const authTime = require('../authTimeFormat');

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

test('gate default-on; only {0,false,off,no} disable', () => {
  assert.strictEqual(authTime.isEnabled({}), true);
  assert.strictEqual(authTime.isEnabled({ KHY_AUTH_DATE_SANE: 'true' }), true);
  assert.strictEqual(authTime.isEnabled({ KHY_AUTH_DATE_SANE: '0' }), false);
  assert.strictEqual(authTime.isEnabled({ KHY_AUTH_DATE_SANE: 'off' }), false);
});

test('formatAuthTimestamp: valid ISO → localized non-empty, never "Invalid Date"', () => {
  const out = authTime.formatAuthTimestamp('2026-06-01T16:23:07.000Z', { locale: 'zh-CN' });
  assert.ok(typeof out === 'string' && out.length > 0);
  assert.ok(!out.toLowerCase().includes('invalid'));
});

test('formatAuthTimestamp: undefined/null/empty/invalid → fallback 未知', () => {
  for (const bad of [undefined, null, '', 'not-a-date', NaN]) {
    assert.strictEqual(authTime.formatAuthTimestamp(bad), '未知', `expected fallback for ${String(bad)}`);
  }
});

test('formatAuthTimestamp: custom fallback honored', () => {
  assert.strictEqual(authTime.formatAuthTimestamp(undefined, { fallback: '永不过期' }), '永不过期');
});

test('formatAuthTimestamp: markExpired appends (已过期) for past expiry', () => {
  const now = 2_000_000_000_000; // fixed injected clock
  const past = new Date(now - DAY).toISOString();
  const future = new Date(now + DAY).toISOString();
  assert.ok(authTime.formatAuthTimestamp(past, { markExpired: true, now }).includes('(已过期)'));
  assert.ok(!authTime.formatAuthTimestamp(future, { markExpired: true, now }).includes('(已过期)'));
});

test('formatAuthTimestamp: markExpired invalid value still → fallback (no crash)', () => {
  assert.strictEqual(authTime.formatAuthTimestamp(undefined, { markExpired: true, now: 1 }), '未知');
});

test('deriveSessionExpiry: existing valid expiresAt preferred', () => {
  const exp = '2026-12-31T00:00:00.000Z';
  assert.strictEqual(
    authTime.deriveSessionExpiry(exp, '2026-06-01T00:00:00.000Z', WEEK),
    new Date(exp).toISOString(),
  );
});

test('deriveSessionExpiry: missing expiresAt derived from loginAt + maxAge', () => {
  const loginAt = '2026-06-01T00:00:00.000Z';
  const expected = new Date(new Date(loginAt).getTime() + WEEK).toISOString();
  assert.strictEqual(authTime.deriveSessionExpiry(null, loginAt, WEEK), expected);
  assert.strictEqual(authTime.deriveSessionExpiry(undefined, loginAt, WEEK), expected);
});

test('deriveSessionExpiry: no valid basis → null', () => {
  assert.strictEqual(authTime.deriveSessionExpiry(null, null, WEEK), null);
  assert.strictEqual(authTime.deriveSessionExpiry(null, 'bad', WEEK), null);
  assert.strictEqual(authTime.deriveSessionExpiry(null, '2026-06-01T00:00:00.000Z', 0), null);
});
