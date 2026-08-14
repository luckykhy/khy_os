'use strict';

/**
 * 单测 —— msgSender 连接稳定(retry/backoff)。全程注入 post + sleep,零真实网络 / 零真实延时。
 *
 * 覆盖:_isRetryable 分类、_backoffMs 指数+封顶、_resolveMaxRetries 夹取、
 *      sendText 重试到成功 / 重试耗尽 / 永久错不重试 / 退避时序 / attempts 计数 / 默认不重试可关。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const sender = require('../../../src/services/messaging/msgSender');
const {
  sendText, _isRetryable, _backoffMs, _resolveMaxRetries,
  DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BASE_MS,
} = sender;

// assertUrl 恒放行、sleep 记录延时不真等。post 由 responder 决定每次返回什么。
function fakeDeps(responder) {
  const calls = [];
  const slept = [];
  return {
    calls,
    slept,
    deps: {
      assertUrl: async () => true,
      sleep: async (ms) => { slept.push(ms); },
      post: async (url, req) => { calls.push({ url, req }); return responder(calls.length, url, req); },
    },
  };
}

const DING = { platform: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=t', text: 'hi', timestampMs: 1700000000000 };

// ── 纯分类 ──
test('_isRetryable:传输错(网络/超时)可重试,非法 URL 不可', () => {
  assert.strictEqual(_isRetryable({ _err: 'socket hang up' }, { ok: false }), true);
  assert.strictEqual(_isRetryable({ _err: '请求超时(15000ms)' }, { ok: false }), true);
  assert.strictEqual(_isRetryable({ _err: '非法 URL:xxx' }, { ok: false }), false);
});

test('_isRetryable:429 与 5xx 可重试,4xx 与业务错不可', () => {
  assert.strictEqual(_isRetryable({}, { ok: false, status: 429 }), true);
  assert.strictEqual(_isRetryable({}, { ok: false, status: 500 }), true);
  assert.strictEqual(_isRetryable({}, { ok: false, status: 503 }), true);
  assert.strictEqual(_isRetryable({}, { ok: false, status: 401 }), false);
  assert.strictEqual(_isRetryable({}, { ok: false, status: 404 }), false);
  // 2xx 但业务码非 0(interpretResponse 会给 status=200)→ 永久错
  assert.strictEqual(_isRetryable({}, { ok: false, status: 200 }), false);
});

test('_backoffMs:指数增长 + 封顶 30s', () => {
  assert.strictEqual(_backoffMs(1, 500), 500);
  assert.strictEqual(_backoffMs(2, 500), 1000);
  assert.strictEqual(_backoffMs(3, 500), 2000);
  assert.strictEqual(_backoffMs(99, 500), 30000); // 封顶
  assert.strictEqual(_backoffMs(1, 0), DEFAULT_RETRY_BASE_MS); // 非法基数回退
});

test('_resolveMaxRetries:默认/env/input 优先级 + 夹 [0,5]', () => {
  assert.strictEqual(_resolveMaxRetries({}, {}), DEFAULT_MAX_RETRIES);
  assert.strictEqual(_resolveMaxRetries({ KHY_MSG_MAX_RETRIES: '4' }, {}), 4);
  assert.strictEqual(_resolveMaxRetries({ KHY_MSG_MAX_RETRIES: '4' }, { maxRetries: 1 }), 1); // input 优先
  assert.strictEqual(_resolveMaxRetries({ KHY_MSG_MAX_RETRIES: '99' }, {}), 5); // 夹上限
  assert.strictEqual(_resolveMaxRetries({ KHY_MSG_MAX_RETRIES: '-3' }, {}), 0); // 夹下限
  assert.strictEqual(_resolveMaxRetries({ KHY_MSG_MAX_RETRIES: 'abc' }, {}), DEFAULT_MAX_RETRIES); // 非数字回退
});

// ── sendText 重试行为 ──
test('sendText:首次 5xx → 重试后成功,attempts=2,退避一次', async () => {
  const { calls, slept, deps } = fakeDeps((n) =>
    n === 1 ? { status: 503, body: '' } : { status: 200, body: '{"errcode":0}' });
  const r = await sendText({ ...DING, maxRetries: 3, retryBaseMs: 500 }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(slept, [500]); // 第 1 次重试退避 500ms
});

test('sendText:持续超时 → 重试耗尽,ok:false,attempts=1+maxRetries', async () => {
  const { calls, slept, deps } = fakeDeps(() => ({ _err: '请求超时(15000ms)' }));
  const r = await sendText({ ...DING, maxRetries: 2, retryBaseMs: 100 }, deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 3);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(slept, [100, 200]); // 指数退避两次
});

test('sendText:永久错(业务码非 0) → 不重试,attempts=1', async () => {
  const { calls, slept, deps } = fakeDeps(() => ({ status: 200, body: '{"errcode":310000,"errmsg":"sign not match"}' }));
  const r = await sendText({ ...DING, maxRetries: 3 }, deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(slept, []); // 永久错零退避
});

test('sendText:HTTP 4xx → 不重试', async () => {
  const { calls, deps } = fakeDeps(() => ({ status: 403, body: '{"errmsg":"forbidden"}' }));
  const r = await sendText({ ...DING, maxRetries: 3 }, deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 1);
});

test('sendText:maxRetries=0 → 单次尝试(关闭重试)', async () => {
  const { calls, slept, deps } = fakeDeps(() => ({ status: 500, body: '' }));
  const r = await sendText({ ...DING, maxRetries: 0 }, deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(slept, []);
});

test('sendText:env KHY_MSG_MAX_RETRIES 生效', async () => {
  const { calls, deps } = fakeDeps(() => ({ status: 429, body: '' }));
  const r = await sendText({ ...DING, env: { KHY_MSG: 'true', KHY_MSG_MAX_RETRIES: '1', KHY_MSG_RETRY_BASE_MS: '10' } }, deps);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 2); // 1 + 1 retry
});

test('sendText:成功路径 attempts=1(不回归旧行为)', async () => {
  const { calls, slept, deps } = fakeDeps(() => ({ status: 200, body: '{"errcode":0}' }));
  const r = await sendText({ ...DING }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(slept, []);
});
