'use strict';
const {
  isImageGenFailureSummaryEnabled,
  classifyImageGenFailure,
  buildImageGenFailureMessage,
  sanitizeCause,
  CATEGORY_HEADLINE,
} = require('./imageGenFailureSummary');
describe('Image Gen Failure Summary', () => {
  test('build: missing backend/model omits the "本次尝试" line, still returns a message', () => {
    const msg = buildImageGenFailureMessage({ rawError: 'HTTP 401', env: {} });
    expect(typeof msg === 'string').toBeTruthy();
    expect(!msg).toContain('本次尝试');
    expect(msg).toContain('图像生成失败');
  });
  
  test('gate: default-on when unset/empty/random, off for falsy tokens (case-folded)', () => {
      expect(isImageGenFailureSummaryEnabled({})).toBe(true);
      expect(isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: '' })).toBe(true);
      expect(isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False', 'NO']) {
        assert.strictEqual(
          isImageGenFailureSummaryEnabled({ KHY_IMAGE_GEN_FAILURE_SUMMARY: v }),
          false,
          v
        );
      }
  });

  test('classify: no_key wins over auth/network (order-sensitive)', () => {
      expect(classifyImageGenFailure('Agnes 后端缺少 AGNES_API_KEY')).toBe('no_key');
      expect(classifyImageGenFailure('已配置的图像生成 key 都不可用')).toBe('no_key');
      expect(classifyImageGenFailure('NO_USABLE_KEY')).toBe('no_key');
      expect(classifyImageGenFailure('未检测到任何图像生成后端')).toBe('no_key');
  });

  test('classify: auth / rate_limit / timeout / network / unknown', () => {
      expect(classifyImageGenFailure('HTTP 401 Unauthorized')).toBe('auth');
      expect(classifyImageGenFailure('认证失败 [auth]')).toBe('auth');
      expect(classifyImageGenFailure('HTTP 429 rate limit')).toBe('rate_limit');
      expect(classifyImageGenFailure('request timed out ETIMEDOUT')).toBe('timeout');
      expect(classifyImageGenFailure('ECONNREFUSED 502 bad gateway')).toBe('network');
      expect(classifyImageGenFailure('some weird thing happened')).toBe('unknown');
      expect(classifyImageGenFailure('')).toBe('unknown');
      expect(classifyImageGenFailure(null)).toBe('unknown');
  });

  test('sanitizeCause: keeps 401 / strips bearer + api_key, flattens, caps length', () => {
      const out = sanitizeCause('HTTP 401 Unauthorized bearer sk-abcdef1234567890 authorization=zzz');
      expect(out).toContain('401');
      expect(!/sk-abcdef1234567890/.test(out).toBeTruthy());
      expect(!/bearer\s+sk-/i.test(out).toBeTruthy());
      expect(out).toContain('***');
      const long = sanitizeCause('x'.repeat(500), 50);
      expect(long.length <= 51).toBeTruthy(); // 50 + ellipsis
  });

  test('build: auth �?headline + backend/model line + sanitized cause + key offer', () => {
      const msg = buildImageGenFailureMessage({
        rawError: 'HTTP 401 Unauthorized �?bearer sk-live-abcdefgh12345678',
        backend: 'agnes',
        model: 'agnes-image-2.0-flash',
        env: {},
      });
      expect(typeof msg === 'string').toBeTruthy();
      expect(msg).toContain('图像生成失败');
      expect(msg).toContain(CATEGORY_HEADLINE.auth);
      expect(msg).toContain('后端 agnes');
      expect(msg).toContain('模型 agnes-image-2.0-flash');
      expect(msg).toContain('401');
      expect(!/sk-live-abcdefgh12345678/.test(msg).toBeTruthy());
      expect(msg).toContain('需要我帮你配置图像生成模型');
  });

  test('build: no_key �?key offer present', () => {
      const msg = buildImageGenFailureMessage({
        rawError: '已配置的图像生成 key 都不可用',
        backend: 'agnes',
        env: {},
      });
      expect(msg).toContain('需要我帮你配置图像生成模型');
      expect(msg).toContain(CATEGORY_HEADLINE.no_key);
  });

  test('build: rate_limit / timeout / network give category-specific next-step, no key offer headline', () => {
      const rate = buildImageGenFailureMessage({ rawError: 'HTTP 429 too many requests', env: {} });
      expect(rate).toContain('分担额度');
      const net = buildImageGenFailureMessage({ rawError: 'ECONNREFUSED', env: {} });
      expect(net).toContain('网络/代理');
  });

  test('build: gate-off �?null (byte-revert to old message)', () => {
      const msg = buildImageGenFailureMessage({
        rawError: 'HTTP 401',
        backend: 'agnes',
        env: { KHY_IMAGE_GEN_FAILURE_SUMMARY: 'off' },
      });
      expect(msg).toBe(null);
  });

  test('build: never throws on malformed input', () => {
      expect(() => buildImageGenFailureMessage().not.toThrow());
      expect(() => buildImageGenFailureMessage({}).not.toThrow());
      expect(() => buildImageGenFailureMessage({ rawError: {}, env: {} }).not.toThrow());
  });

});

