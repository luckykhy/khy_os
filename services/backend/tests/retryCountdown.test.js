'use strict';

/**
 * retryCountdown — pins the pure-leaf decision for the gateway-recovery retry
 * "wait countdown" status text (aligns with CC's "Retrying in N seconds…
 * (attempt X/Y)" from SystemAPIErrorMessage.tsx).
 *
 * Key LOGIC pinned:
 *   - gate on + remaining>0  → "N 秒后重试（第 a/m 次）" with sec = ceil(remainingMs/1000)
 *   - gate on + remaining<=0 → "正在重试（第 a/m 次）..." (retry firing now)
 *   - gate off / any error   → byte-identical legacy static string
 *   Chinese "秒" needs no plural branch (simpler than CC's second/seconds).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const rc = require('../src/cli/retryCountdown');

test('isRetryCountdownEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(rc.isRetryCountdownEnabled({}), true);
  assert.strictEqual(rc.isRetryCountdownEnabled({ KHY_RETRY_COUNTDOWN: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(rc.isRetryCountdownEnabled({ KHY_RETRY_COUNTDOWN: v }), false, `expected off for ${v}`);
  }
});

test('gate on + remaining>0 → live countdown with attempt counter', () => {
  const msg = rc.buildRetryStatusMessage(
    { errType: 'timeout', attempt: 1, maxAttempts: 3, remainingMs: 2500 }, {});
  assert.match(msg, /网关连接波动（timeout）/);
  assert.match(msg, /3 秒后重试/); // ceil(2500/1000) = 3
  assert.match(msg, /第 1\/3 次/);
});

test('countdown seconds use ceil (at-least-N semantics) and clamp to >=1 while waiting', () => {
  assert.match(rc.buildRetryStatusMessage({ errType: 't', attempt: 2, maxAttempts: 3, remainingMs: 1200 }, {}), /2 秒后重试/);
  assert.match(rc.buildRetryStatusMessage({ errType: 't', attempt: 2, maxAttempts: 3, remainingMs: 200 }, {}), /1 秒后重试/); // ceil(0.2)=1, not 0
});

test('gate on + remaining<=0 → "正在重试" (retry is firing now)', () => {
  const msg = rc.buildRetryStatusMessage({ errType: 'reset', attempt: 2, maxAttempts: 3, remainingMs: 0 }, {});
  assert.match(msg, /正在重试（第 2\/3 次）/);
  assert.doesNotMatch(msg, /秒后重试/);
});

test('gate off → byte-identical legacy static string', () => {
  const msg = rc.buildRetryStatusMessage(
    { errType: 'timeout', attempt: 2, maxAttempts: 3, remainingMs: 2500 },
    { KHY_RETRY_COUNTDOWN: 'off' });
  assert.strictEqual(msg, '网关连接波动（timeout），正在进行稳定性重试 2/3...');
  assert.strictEqual(msg, rc.buildLegacyRetryStatus('timeout', 2, 3));
});

test('buildLegacyRetryStatus: exact legacy shape', () => {
  assert.strictEqual(rc.buildLegacyRetryStatus('overloaded', 1, 2),
    '网关连接波动（overloaded），正在进行稳定性重试 1/2...');
});

test('fail-soft: missing/garbage input never throws, returns a string', () => {
  assert.doesNotThrow(() => rc.buildRetryStatusMessage());
  assert.strictEqual(typeof rc.buildRetryStatusMessage(), 'string');
  assert.strictEqual(typeof rc.buildRetryStatusMessage({ remainingMs: NaN }, {}), 'string');
  // defaults: unknown errType, attempt 1/1
  assert.match(rc.buildRetryStatusMessage({ remainingMs: 0 }, {}), /网关连接波动（unknown）/);
});

test('TICK_MS is 1000', () => {
  assert.strictEqual(rc.TICK_MS, 1000);
});
