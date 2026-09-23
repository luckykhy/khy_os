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

// ── 通道钉选诊断（首选通道被 strict 钉死 → 不回退）────────────────────────────
//
// 现场事故：services/backend/.env 残留 `GATEWAY_PREFERRED_ADAPTER=codex` +
// `GATEWAY_PREFERRED_STRICT=true`，而本机 codex 无凭据 → 每次调用都在首选通道
// 硬失败、不回退到可用的 api/agnes 通道。因为本叶子此前**只认** 5xx/auth/限流/
// 网络/模型不存在五类信号，这种「钉选导致不回退」被翻译成了 404/auth 之类
// 的表象，排障者于是连续三天去查密钥——真因从未浮出。
// 契约：只要 pin 指明「有具体首选通道且 strict 生效」，就必须输出一条独立的
// channelPinned 指引，点名该通道并给出解除钉选的 env 开关；且必须与既有信号
// 指引**叠加**而非替换。

test('strict channel pin is surfaced as its own actionable advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [
      { adapterKey: 'codex', error: 'codex [unavailable]: OpenAI Codex unavailable' },
    ],
    pin: { adapter: 'codex', strict: true, fallbackSuppressed: true },
    ...ON,
  });
  assert.ok(out, 'pin advice must be produced');
  assert.ok(out.reasons.includes('channelPinned'), 'must carry the channelPinned reason');
  assert.ok(out.message.includes('codex'), 'must name the pinned adapter');
  assert.ok(
    out.message.includes('GATEWAY_PREFERRED_ADAPTER'),
    'must name the env var the user has to change'
  );
  assert.ok(
    out.message.includes('GATEWAY_PREFERRED_STRICT'),
    'must name the strict switch'
  );
});

test('pin advice names the pinned adapter, not a hardcoded one', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'trae', error: 'trae login required' }],
    pin: { adapter: 'trae', strict: true, fallbackSuppressed: true },
    ...ON,
  });
  assert.ok(out);
  assert.ok(out.message.includes('trae'));
  assert.ok(!out.message.includes('codex'), 'must not hardcode another channel name');
});

test('no pin advice when strict is off (auto fallback still allowed)', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'codex', statusCode: 502, errorType: 'server_error' }],
    pin: { adapter: 'codex', strict: false },
    ...ON,
  });
  assert.ok(out);
  assert.ok(!out.reasons.includes('channelPinned'));
});

test('no pin advice when the preference is auto / unset', () => {
  const bare = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', statusCode: 502, errorType: 'server_error' }],
    pin: { adapter: 'auto', strict: true },
    ...ON,
  });
  assert.ok(bare);
  assert.ok(!bare.reasons.includes('channelPinned'));

  const unset = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'api', statusCode: 502, errorType: 'server_error' }],
    ...ON,
  });
  assert.ok(unset);
  assert.ok(!unset.reasons.includes('channelPinned'));
});

test('pin advice is additive, never replaces the underlying signal advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'codex', statusCode: 401, error: 'Incorrect API key provided' }],
    pin: { adapter: 'codex', strict: true, fallbackSuppressed: true },
    ...ON,
  });
  assert.ok(out);
  assert.ok(out.reasons.includes('channelPinned'));
  assert.ok(out.reasons.includes('auth'), 'the real auth signal must survive');
  assert.ok(out.message.includes('API key'));
});

test('pin alone (no other matching signal) still yields advice', () => {
  const out = buildChannelFailureAdvice({
    attempts: [{ adapterKey: 'codex', error: 'unavailable' }],
    pin: { adapter: 'codex', strict: true, fallbackSuppressed: true },
    ...ON,
  });
  assert.ok(out, 'pin is itself a sufficient signal');
  assert.deepStrictEqual(out.reasons, ['channelPinned']);
});

test('gate off suppresses pin advice too (byte-identical fallback)', () => {
  assert.strictEqual(
    buildChannelFailureAdvice({
      attempts: [{ adapterKey: 'codex', error: 'unavailable' }],
      pin: { adapter: 'codex', strict: true, fallbackSuppressed: true },
      ...OFF,
    }),
    null
  );
});

test('never throws on garbage pin input', () => {
  assert.strictEqual(buildChannelFailureAdvice({ attempts: [{}], pin: null, ...ON }), null);
  assert.strictEqual(buildChannelFailureAdvice({ attempts: [{}], pin: 'x', ...ON }), null);
  assert.strictEqual(buildChannelFailureAdvice({ attempts: [{}], pin: [], ...ON }), null);
  assert.doesNotThrow(() =>
    buildChannelFailureAdvice({ attempts: [{}], pin: { adapter: 42, strict: 'yes' }, ...ON })
  );
  assert.doesNotThrow(() =>
    buildChannelFailureAdvice({ attempts: [{}], pin: { adapter: 'codex', strict: {} }, ...ON })
  );
  assert.doesNotThrow(() =>
    buildChannelFailureAdvice({
      attempts: [{}],
      pin: Object.create(null),
      ...ON,
    })
  );
});
