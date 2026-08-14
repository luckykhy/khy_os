'use strict';

/**
 * parseRetryAfterCooldown.test.js — 锁 utils/parseRetryAfterCooldown 口径
 *   (收敛 2 处 apiKeyPool Retry-After 冷却钳制 helper 的护栏)。
 */

const test = require('node:test');
const assert = require('node:assert');

const parseRetryAfterCooldown = require('../src/utils/parseRetryAfterCooldown');

const BASE = 10000;
const MAX = 600000;

test('falsy value → base cooldown', () => {
  assert.strictEqual(parseRetryAfterCooldown(null, BASE, MAX), BASE);
  assert.strictEqual(parseRetryAfterCooldown(0, BASE, MAX), BASE);
  assert.strictEqual(parseRetryAfterCooldown('', BASE, MAX), BASE);
});

test('数字秒 → *1000 后 clamp 到 [base, max]', () => {
  assert.strictEqual(parseRetryAfterCooldown('30', BASE, MAX), 30000);
  assert.strictEqual(parseRetryAfterCooldown('5', BASE, MAX), BASE); // 5000 < base → base
  assert.strictEqual(parseRetryAfterCooldown('9999', BASE, MAX), MAX); // clamp to max
});

test('非数字非日期 → base', () => {
  assert.strictEqual(parseRetryAfterCooldown('not-a-date', BASE, MAX), BASE);
});

test('HTTP-date 未来时刻 → clamp(delta)', () => {
  const future = new Date(Date.now() + 60000).toUTCString();
  const got = parseRetryAfterCooldown(future, BASE, MAX);
  assert.ok(got >= BASE && got <= MAX);
});

test('默认边界 = 10000 / 600000', () => {
  assert.strictEqual(parseRetryAfterCooldown(null), 10000);
  assert.strictEqual(parseRetryAfterCooldown('99999'), 600000);
});

test('逐输入等价原体(固定边界)', () => {
  const ref = (value, baseCooldownMs, maxRetryAfterMs) => {
    if (!value) return baseCooldownMs;
    const asNumber = Number(value);
    if (!isNaN(asNumber) && asNumber > 0) {
      return Math.min(maxRetryAfterMs, Math.max(baseCooldownMs, asNumber * 1000));
    }
    const asDate = new Date(value).getTime();
    if (!isNaN(asDate)) {
      const delta = asDate - Date.now();
      return Math.min(maxRetryAfterMs, Math.max(baseCooldownMs, delta));
    }
    return baseCooldownMs;
  };
  for (const v of [null, 0, '', '15', '5', '99999', 'xyz', '1']) {
    assert.strictEqual(parseRetryAfterCooldown(v, BASE, MAX), ref(v, BASE, MAX));
  }
});
