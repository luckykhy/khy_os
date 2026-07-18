'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isImageGenFailureSummaryEnabled,
  classifyImageGenFailure,
  buildImageGenFailureMessage,
  sanitizeCause,
  CATEGORY_HEADLINE,
} = require('./imageGenFailureSummary');

test('gate: default-on when unset/empty/random, off for falsy tokens (case-folded)', () => {
  assert.strictEqual(isImageGenFailureSummaryEnabled({}), true);
  assert.strictEqual(isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: '' }), true);
  assert.strictEqual(isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False', 'NO']) {
    assert.strictEqual(
      isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: v }), false, v);
  }
});

test('classify: no_key wins over auth/network (order-sensitive)', () => {
  assert.strictEqual(classifyImageGenFailure('Agnes 后端缺少 AGNES_API_KEY'), 'no_key');
  assert.strictEqual(classifyImageGenFailure('已配置的图像生成 key 都不可用'), 'no_key');
  assert.strictEqual(classifyImageGenFailure('NO_USABLE_KEY'), 'no_key');
  assert.strictEqual(classifyImageGenFailure('未检测到任何图像生成后端'), 'no_key');
});

test('classify: auth / rate_limit / timeout / network / unknown', () => {
  assert.strictEqual(classifyImageGenFailure('HTTP 401 Unauthorized'), 'auth');
  assert.strictEqual(classifyImageGenFailure('认证失败 [auth]'), 'auth');
  assert.strictEqual(classifyImageGenFailure('HTTP 429 rate limit'), 'rate_limit');
  assert.strictEqual(classifyImageGenFailure('request timed out ETIMEDOUT'), 'timeout');
  assert.strictEqual(classifyImageGenFailure('ECONNREFUSED 502 bad gateway'), 'network');
  assert.strictEqual(classifyImageGenFailure('some weird thing happened'), 'unknown');
  assert.strictEqual(classifyImageGenFailure(''), 'unknown');
  assert.strictEqual(classifyImageGenFailure(null), 'unknown');
});

test('sanitizeCause: keeps 401 / strips bearer + api_key, flattens, caps length', () => {
  const out = sanitizeCause('HTTP 401 Unauthorized bearer sk-abcdef1234567890 authorization=zzz');
  assert.ok(out.includes('401'));
  assert.ok(!/sk-abcdef1234567890/.test(out));
  assert.ok(!/bearer\s+sk-/i.test(out));
  assert.ok(out.includes('***'));
  const long = sanitizeCause('x'.repeat(500), 50);
  assert.ok(long.length <= 51); // 50 + ellipsis
});

test('build: auth → headline + backend/model line + sanitized cause + key offer', () => {
  const msg = buildImageGenFailureMessage({
    rawError: 'HTTP 401 Unauthorized — bearer sk-live-abcdefgh12345678',
    backend: 'agnes',
    model: 'agnes-image-2.0-flash',
    env: {},
  });
  assert.ok(typeof msg === 'string');
  assert.ok(msg.includes('图像生成失败'));
  assert.ok(msg.includes(CATEGORY_HEADLINE.auth));
  assert.ok(msg.includes('后端 agnes'));
  assert.ok(msg.includes('模型 agnes-image-2.0-flash'));
  assert.ok(msg.includes('401'));
  assert.ok(!/sk-live-abcdefgh12345678/.test(msg));
  assert.ok(msg.includes('需要我帮你配置图像生成模型'));
});

test('build: no_key → key offer present', () => {
  const msg = buildImageGenFailureMessage({
    rawError: '已配置的图像生成 key 都不可用',
    backend: 'agnes',
    env: {},
  });
  assert.ok(msg.includes('需要我帮你配置图像生成模型'));
  assert.ok(msg.includes(CATEGORY_HEADLINE.no_key));
});

test('build: rate_limit / timeout / network give category-specific next-step, no key offer headline', () => {
  const rate = buildImageGenFailureMessage({ rawError: 'HTTP 429 too many requests', env: {} });
  assert.ok(rate.includes('分担额度'));
  const net = buildImageGenFailureMessage({ rawError: 'ECONNREFUSED', env: {} });
  assert.ok(net.includes('网络/代理'));
});

test('build: gate-off → null (byte-revert to old message)', () => {
  const msg = buildImageGenFailureMessage({
    rawError: 'HTTP 401', backend: 'agnes', env: { KHY_IMAGE_GEN_FAILURE_SUMMARY: 'off' },
  });
  assert.strictEqual(msg, null);
});

test('build: missing backend/model omits the "本次尝试" line, still returns a message', () => {
  const msg = buildImageGenFailureMessage({ rawError: 'HTTP 401', env: {} });
  assert.ok(typeof msg === 'string');
  assert.ok(!msg.includes('本次尝试'));
  assert.ok(msg.includes('图像生成失败'));
});

test('build: never throws on malformed input', () => {
  assert.doesNotThrow(() => buildImageGenFailureMessage());
  assert.doesNotThrow(() => buildImageGenFailureMessage({}));
  assert.doesNotThrow(() => buildImageGenFailureMessage({ rawError: {}, env: {} }));
});
