'use strict';

/**
 * buildChannelFailureAdvice — 纯叶子测试:各通道失败信号翻译成可操作指引。
 *
 * 覆盖:server_error(5xx)/ auth / rate_limit / network / model_not_found 单因、
 * 多因混合、无匹配 → null、门控关 → null、attempts 空 → null、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  buildChannelFailureAdvice,
  _isServerError,
  _isAuthFailure,
  _isRateLimited,
  _isNetworkFailure,
  _isModelNotFound,
} = require('../../src/services/gateway/buildChannelFailureAdvice');

const ON = { env: { KHY_CHANNEL_FAILURE_ADVICE: '1' } };
const OFF = { env: { KHY_CHANNEL_FAILURE_ADVICE: 'off' } };

test('signal predicates classify common gateway failures', () => {
  assert.ok(_isServerError({ statusCode: 502 }));
  assert.ok(_isServerError({ statusCode: 503 }));
  assert.ok(_isServerError({ errorType: 'server_error' }));
  assert.ok(!_isServerError({ statusCode: 200 }));

  assert.ok(_isAuthFailure({ statusCode: 401 }));
  assert.ok(_isAuthFailure({ statusCode: 403 }));
  assert.ok(_isAuthFailure({ errorType: 'auth' }));
  assert.ok(_isAuthFailure({ error: 'Incorrect API key provided' }));
  assert.ok(!_isAuthFailure({ statusCode: 500 }));

  assert.ok(_isRateLimited({ statusCode: 429 }));
  assert.ok(_isRateLimited({ errorType: 'rate_limit' }));
  assert.ok(_isRateLimited({ error: 'rate limit exceeded' }));
  assert.ok(!_isRateLimited({ statusCode: 200 }));

  assert.ok(_isNetworkFailure({ errorType: 'network' }));
  assert.ok(_isNetworkFailure({ error: 'socket hang up' }));
  assert.ok(_isNetworkFailure({ error: 'connect ECONNREFUSED 127.0.0.1:7890' }));
  assert.ok(!_isNetworkFailure({ statusCode: 502 }));

  assert.ok(_isModelNotFound({ statusCode: 404 }));
  assert.ok(_isModelNotFound({ errorType: 'model_not_found' }));
  assert.ok(_isModelNotFound({ error: 'model does not exist' }));
  assert.ok(!_isModelNotFound({ statusCode: 200 }));
});

test('server_error (502) produces the transient-5xx advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', provider: 'agnes', statusCode: 502, errorType: 'server_error' }],
    ...ON,
  });
  assert.ok(out, 'must produce advice');
  assert.deepStrictEqual(out.reasons, ['serverError']);
  assert.ok(out.message.includes('5xx'), 'must explain 5xx is transient');
  assert.ok(out.message.includes('gateway status'), 'must suggest a check command');
});

test('auth failure produces the key-check advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', provider: 'stepfun', statusCode: 401, error: 'Incorrect API key' }],
    ...ON,
  });
  assert.ok(out);
  assert.ok(out.reasons.includes('auth'));
  assert.ok(out.message.includes('API key'));
});

test('rate_limit produces the backoff advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', provider: 'sensenova', statusCode: 429, errorType: 'rate_limit' }],
    ...ON,
  });
  assert.ok(out);
  assert.ok(out.reasons.includes('rateLimited'));
  assert.ok(out.message.includes('限流'));
});

test('mixed failures list every cause', () => {
  const out = buildChannelFailureAdvice({
    attempts: [
      { adapterKey: 'api', provider: 'agnes', statusCode: 502, errorType: 'server_error' },
      { adapterKey: 'api', provider: 'stepfun', statusCode: 401, error: 'Incorrect API key' },
    ],
    ...ON,
  });
  assert.ok(out);
  assert.ok(out.reasons.includes('serverError'));
  assert.ok(out.reasons.includes('auth'));
  // 两条指引都在
  assert.ok(out.message.includes('5xx'));
  assert.ok(out.message.includes('API key'));
});

test('no matching signal → null (fall back to plain wall)', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', provider: 'x', statusCode: 200, success: false }],
    ...ON,
  });
  assert.strictEqual(out, null);
});

test('gate off → null (byte-identical fallback)', () => {
  assert.strictEqual(
    buildChannelFailureAdvice({
      attempts: [{ adapterKey: 'api', provider: 'agnes', statusCode: 502 }],
      ...OFF,
    }),
    null,
  );
});

test('empty / missing attempts → null', () => {
  assert.strictEqual(buildChannelFailureAdvice({ attempts: [], ...ON }), null);
  assert.strictEqual(buildChannelFailureAdvice({ attempts: null, ...ON }), null);
  assert.strictEqual(buildChannelFailureAdvice({ ...ON }), null);
});

test('never throws on garbage input', () => {
  assert.strictEqual(buildChannelFailureAdvice(null), null);
  assert.strictEqual(buildChannelFailureAdvice({ attempts: [null, 'x', 42] }), null);
  assert.doesNotThrow(() => buildChannelFailureAdvice({ attempts: [{}] }));
});
