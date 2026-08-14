'use strict';

/**
 * failureReasonRanking.test.js — 「真实失败原因」清单排序(纯叶子)。
 *
 * 用户实测复现:同一次识图请求,主视觉通道本轮 live 撞 `HTTP 429 code=1305`(瞬时限流),
 * 但「真实失败原因」却报 238s 前缓存的 `404 model_not_found (cooldown 238s)` —— 陈旧缓存跳过
 * 被排在前、盖过本轮 429,误导用户以为「模型不存在」。此套件锁死叶子契约:
 *   - isCachedSkip:virtualSkip 显式标记 / (statusCode===0 且文本 `recent … failure cached`)→ true;
 *     真实 HTTP 码 → false(live);
 *   - rankFailedAttempts:稳定分区 live 优先、缓存靠后;组内保持原序;不 mutate;门关逐字回退。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isEnabled,
  isCachedSkip,
  rankFailedAttempts,
  describeFailureReasonRanking,
} = require('../../../src/services/gateway/failureReasonRanking');

// ── isCachedSkip ────────────────────────────────────────────────────────────

test('isCachedSkip: virtualSkip 显式标记 → true', () => {
  assert.strictEqual(isCachedSkip({ virtualSkip: true, statusCode: 0 }), true);
});

test('isCachedSkip: 真实 HTTP 429 live 失败 → false', () => {
  assert.strictEqual(
    isCachedSkip({ statusCode: 429, error: 'HTTP 429 code=1305 访问量过大' }),
    false,
  );
});

test('isCachedSkip: 真实 HTTP 404 live 失败 → false', () => {
  assert.strictEqual(
    isCachedSkip({ statusCode: 404, error: 'HTTP 404 model_not_found' }),
    false,
  );
});

test('isCachedSkip: statusCode 0 且文本命中 cached 特征 → true(兜底)', () => {
  assert.strictEqual(
    isCachedSkip({ statusCode: 0, error: 'recent 404 failure cached: model_not_found (cooldown 238s)' }),
    true,
  );
});

test('isCachedSkip: statusCode 缺省但文本非缓存口吻 → false', () => {
  assert.strictEqual(
    isCachedSkip({ error: 'some other failure' }),
    false,
  );
});

test('isCachedSkip: 有真实 HTTP 码即使文本含 cached 字样仍 live 优先 → false', () => {
  assert.strictEqual(
    isCachedSkip({ statusCode: 429, error: 'recent 404 failure cached ...' }),
    false,
  );
});

test('isCachedSkip: 坏输入绝不抛', () => {
  assert.strictEqual(isCachedSkip(null), false);
  assert.strictEqual(isCachedSkip(undefined), false);
  assert.strictEqual(isCachedSkip('string'), false);
  assert.strictEqual(isCachedSkip(42), false);
});

// ── rankFailedAttempts ───────────────────────────────────────────────────────

test('rankFailedAttempts: 陈旧缓存 404 在前、本轮 live 429 在后 → 重排为 live 优先', () => {
  const stale404 = { virtualSkip: true, statusCode: 0, error: 'recent 404 failure cached: model_not_found (cooldown 238s)' };
  const live429 = { statusCode: 429, error: 'HTTP 429 code=1305 访问量过大' };
  const ranked = rankFailedAttempts([stale404, live429]);
  assert.strictEqual(ranked[0], live429, 'live 429 应排第一');
  assert.strictEqual(ranked[1], stale404, '缓存 404 应排第二');
});

test('rankFailedAttempts: 稳定分区,组内保持原相对顺序', () => {
  const liveA = { statusCode: 500, error: 'A' };
  const cached1 = { virtualSkip: true, statusCode: 0, error: 'recent x failure cached (cooldown 1s)' };
  const liveB = { statusCode: 502, error: 'B' };
  const cached2 = { virtualSkip: true, statusCode: 0, error: 'recent y failure cached (cooldown 2s)' };
  const ranked = rankFailedAttempts([liveA, cached1, liveB, cached2]);
  assert.deepStrictEqual(ranked, [liveA, liveB, cached1, cached2]);
});

test('rankFailedAttempts: 不 mutate 入参', () => {
  const cached = { virtualSkip: true, statusCode: 0, error: 'recent x failure cached' };
  const live = { statusCode: 429, error: 'HTTP 429' };
  const input = [cached, live];
  const snapshot = input.slice();
  rankFailedAttempts(input);
  assert.deepStrictEqual(input, snapshot, '原数组顺序不应改变');
});

test('rankFailedAttempts: 单元素 / 空数组 → 原样浅拷贝', () => {
  const one = [{ statusCode: 429 }];
  const ranked = rankFailedAttempts(one);
  assert.deepStrictEqual(ranked, one);
  assert.notStrictEqual(ranked, one, '应为新数组');
  assert.deepStrictEqual(rankFailedAttempts([]), []);
});

test('rankFailedAttempts: 全 live 或全 cached → 顺序不变', () => {
  const allLive = [{ statusCode: 429 }, { statusCode: 404 }, { statusCode: 500 }];
  assert.deepStrictEqual(rankFailedAttempts(allLive), allLive);
  const allCached = [
    { virtualSkip: true, statusCode: 0, error: 'recent a failure cached' },
    { virtualSkip: true, statusCode: 0, error: 'recent b failure cached' },
  ];
  assert.deepStrictEqual(rankFailedAttempts(allCached), allCached);
});

test('rankFailedAttempts: 门控关 → 逐字节回退插入序', () => {
  const stale404 = { virtualSkip: true, statusCode: 0, error: 'recent 404 failure cached (cooldown 238s)' };
  const live429 = { statusCode: 429, error: 'HTTP 429' };
  const env = { KHY_FAILURE_REASON_RANKING: '0' };
  const ranked = rankFailedAttempts([stale404, live429], env);
  assert.deepStrictEqual(ranked, [stale404, live429], '关门时保持原插入序');
});

test('rankFailedAttempts: 坏输入绝不抛', () => {
  assert.deepStrictEqual(rankFailedAttempts(null), []);
  assert.deepStrictEqual(rankFailedAttempts(undefined), []);
  assert.deepStrictEqual(rankFailedAttempts('nope'), []);
});

// ── isEnabled ────────────────────────────────────────────────────────────────

test('isEnabled: 默认开(未设 env)', () => {
  assert.strictEqual(isEnabled({}), true);
});

test('isEnabled: CANON off-words 关', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(isEnabled({ KHY_FAILURE_REASON_RANKING: off }), false, `${off} 应关`);
  }
});

test('isEnabled: 任意真值开', () => {
  assert.strictEqual(isEnabled({ KHY_FAILURE_REASON_RANKING: '1' }), true);
  assert.strictEqual(isEnabled({ KHY_FAILURE_REASON_RANKING: 'true' }), true);
});

// ── describeFailureReasonRanking ─────────────────────────────────────────────

test('describeFailureReasonRanking: 自描述结构完整', () => {
  const d = describeFailureReasonRanking();
  assert.strictEqual(d.gate, 'KHY_FAILURE_REASON_RANKING');
  assert.strictEqual(d.defaultOn, true);
  assert.match(d.summary, /live/);
  assert.match(d.summary, /缓存/);
});
