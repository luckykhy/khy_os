'use strict';

/**
 * _retryWithBackoff Retry-After header parsing tests.
 * 借鉴 sst/opencode src/session/retry.ts:22-53 的 HTTP Retry-After 解析。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRetryAfterMs,
  extractRetryAfterHeader,
} = require('../../../src/services/gateway/adapters/_retryWithBackoff');

test('parseRetryAfterMs:null/undefined/空字符串 → 0', () => {
  assert.equal(parseRetryAfterMs(null), 0);
  assert.equal(parseRetryAfterMs(undefined), 0);
  assert.equal(parseRetryAfterMs(''), 0);
  assert.equal(parseRetryAfterMs('   '), 0);
});

test('parseRetryAfterMs:整数秒 → 毫秒', () => {
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs('1'), 1000);
  assert.equal(parseRetryAfterMs('60'), 60_000);
  assert.equal(parseRetryAfterMs('120'), 120_000);
});

test('parseRetryAfterMs:小数秒 → 毫秒(向上取整)', () => {
  assert.equal(parseRetryAfterMs('0.5'), 500);
  assert.equal(parseRetryAfterMs('1.5'), 1500);
});

test('parseRetryAfterMs:数字直接传入 → 毫秒', () => {
  assert.equal(parseRetryAfterMs(0), 0);
  assert.equal(parseRetryAfterMs(5), 5000);
  assert.equal(parseRetryAfterMs(30.5), 30_500);
});

test('parseRetryAfterMs:clamp 上限 10 分钟(防误配上游)', () => {
  // 2 小时(7200s)→ clamp 到 600000ms(10min)
  assert.equal(parseRetryAfterMs('7200'), 600_000);
  assert.equal(parseRetryAfterMs(7200), 600_000);
});

test('parseRetryAfterMs:负数 / NaN → 0', () => {
  assert.equal(parseRetryAfterMs(-5), 0);
  assert.equal(parseRetryAfterMs(NaN), 0);
});

test('parseRetryAfterMs:HTTP-date 未来 → 距 now 的差值', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const _nowFn = () => now;
  // 30 秒后
  const future = '2026-01-01T00:00:30Z';
  const r = parseRetryAfterMs(future, _nowFn);
  assert.ok(r > 29000 && r <= 30000, `expected ~30000ms, got ${r}`);
});

test('parseRetryAfterMs:HTTP-date 过去 → 0(避免负等待)', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const _nowFn = () => now;
  // 30 秒前
  const past = '2025-12-31T23:59:30Z';
  const r = parseRetryAfterMs(past, _nowFn);
  assert.equal(r, 0);
});

test('parseRetryAfterMs:RFC 1123 格式', () => {
  const now = Date.parse('Fri, 02 Jan 2026 00:00:00 GMT');
  const _nowFn = () => now;
  // 60s 后
  const r = parseRetryAfterMs('Fri, 02 Jan 2026 00:01:00 GMT', _nowFn);
  assert.ok(r >= 59000 && r <= 61000, `expected ~60000ms, got ${r}`);
});

test('parseRetryAfterMs:不可解析的字符串 → 0(不抛)', () => {
  assert.equal(parseRetryAfterMs('not a date or number'), 0);
  assert.equal(parseRetryAfterMs('abc'), 0);
  assert.equal(parseRetryAfterMs('GMT'), 0);
});

test('extractRetryAfterHeader:标准 Headers 对象', () => {
  const headers = new Map([['retry-after', '120']]);
  const fakeHeaders = { get: (n) => headers.get(n.toLowerCase()) };
  assert.equal(extractRetryAfterHeader({ headers: fakeHeaders }), '120');
});

test('extractRetryAfterHeader:plain object', () => {
  assert.equal(
    extractRetryAfterHeader({ headers: { 'retry-after': '60' } }),
    '60'
  );
  assert.equal(
    extractRetryAfterHeader({ headers: { 'Retry-After': '60' } }),
    '60'
  );
});

test('extractRetryAfterHeader:嵌套 .response', () => {
  const err = {
    response: { headers: { 'retry-after': '30' } },
  };
  assert.equal(extractRetryAfterHeader(err), '30');
});

test('extractRetryAfterHeader:无 header → undefined', () => {
  assert.equal(extractRetryAfterHeader({}), undefined);
  assert.equal(extractRetryAfterHeader({ headers: {} }), undefined);
  assert.equal(extractRetryAfterHeader({ headers: { 'content-type': 'json' } }), undefined);
});

test('extractRetryAfterHeader:null/undefined/坏 source 不抛', () => {
  assert.equal(extractRetryAfterHeader(null), undefined);
  assert.equal(extractRetryAfterHeader(undefined), undefined);
  // 坏 source:不会抛
  let r;
  try {
    r = extractRetryAfterHeader(42);
  } catch (e) {
    assert.fail(`should not throw: ${e.message}`);
  }
  assert.equal(r, undefined);
});

test('集成:重试时尊重 Retry-After(429 + 30s)', async () => {
  const { retryWithBackoff } = require('../../../src/services/gateway/adapters/_retryWithBackoff');
  // 模拟:第一次 429 + RA=1s,第二次成功
  let attempts = 0;
  const start = Date.now();
  const result = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('Too Many Requests');
        err.status = 429;
        err.headers = { 'retry-after': '1' }; // 1s
        throw err;
      }
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      backoffFactor: 2,
    }
  );
  const elapsed = Date.now() - start;
  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  // 至少 1s,但不应超过 2s(避免 RA=1s + 长 jitter 跑飞)
  assert.ok(elapsed >= 950, `should respect Retry-After: elapsed=${elapsed}ms`);
});

test('集成:无 RA 头时回退到指数退避', async () => {
  const { retryWithBackoff } = require('../../../src/services/gateway/adapters/_retryWithBackoff');
  let attempts = 0;
  const start = Date.now();
  await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error('Bad Gateway');
        err.status = 502;
        // 无 retry-after 头
        throw err;
      }
      return 'ok';
    },
    {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 5000,
    }
  );
  const elapsed = Date.now() - start;
  // 指数退避 base=200ms,att=1 → ~200-260ms
  assert.ok(elapsed >= 150, `exp backoff too short: ${elapsed}ms`);
  assert.ok(elapsed < 2000, `exp backoff too long: ${elapsed}ms`);
});
