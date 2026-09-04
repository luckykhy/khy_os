'use strict';

const {
  resolveFriendlyFailureMessage,
  extractToolFailureReason,
  buildKeyConfigInvite,
  sanitizeCause,
  isHonestFailureEnabled,
  CATEGORY_PREFIX,
} = require('../../src/services/honestFailureReason');

describe('honestFailureReason', () => {
  describe('sanitizeCause', () => {
    test('returns empty for null/undefined', () => {
      expect(sanitizeCause(null)).toBe('');
      expect(sanitizeCause(undefined)).toBe('');
    });

    test('returns empty for empty string', () => {
      expect(sanitizeCause('')).toBe('');
    });

    test('masks Bearer token', () => {
      const result = sanitizeCause('Authorization: Bearer abc123xyz');
      expect(result).toContain('***');
      expect(result).not.toContain('abc123xyz');
    });

    test('masks api_key', () => {
      const result = sanitizeCause('api_key=secret123');
      expect(result).toContain('***');
      expect(result).not.toContain('secret123');
    });

    test('masks token', () => {
      const result = sanitizeCause('token=abc123');
      expect(result).toContain('***');
    });

    test('masks password', () => {
      const result = sanitizeCause('password=mysecret');
      expect(result).toContain('***');
    });

    test('masks OpenAI key', () => {
      const result = sanitizeCause('sk-abcdefghijklmnopqrstuvwxyz');
      expect(result).toContain('***');
    });

    test('masks URL credentials', () => {
      const result = sanitizeCause('http://user:pass@host.com');
      expect(result).toContain('***@');
    });

    test('preserves error codes', () => {
      const result = sanitizeCause('ECONNREFUSED 127.0.0.1:443');
      expect(result).toContain('ECONNREFUSED');
      expect(result).toContain('127.0.0.1');
    });

    test('collapses whitespace', () => {
      const result = sanitizeCause('  multiple   spaces  ');
      expect(result).toBe('multiple spaces');
    });

    test('truncates long text', () => {
      const longText = 'a'.repeat(300);
      const result = sanitizeCause(longText, 220);
      expect(result.length).toBeLessThanOrEqual(221);
      expect(result).toContain('…');
    });
  });

  describe('isHonestFailureEnabled', () => {
    test('returns true by default', () => {
      expect(isHonestFailureEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(isHonestFailureEnabled({ KHY_HONEST_FAILURE: '1' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(isHonestFailureEnabled({ KHY_HONEST_FAILURE: '0' })).toBe(false);
      expect(isHonestFailureEnabled({ KHY_HONEST_FAILURE: 'false' })).toBe(false);
      expect(isHonestFailureEnabled({ KHY_HONEST_FAILURE: 'off' })).toBe(false);
      expect(isHonestFailureEnabled({ KHY_HONEST_FAILURE: 'no' })).toBe(false);
    });
  });

  describe('resolveFriendlyFailureMessage', () => {
    test('returns legacy when disabled', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'network',
        cause: 'connection refused',
        legacyFriendly: '网络错误',
        options: { env: { KHY_HONEST_FAILURE: '0' } },
      });
      expect(result).toBe('网络错误');
    });

    test('returns legacy when no cause', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'network',
        cause: '',
        legacyFriendly: '网络错误',
        options: { env: {} },
      });
      expect(result).toBe('网络错误');
    });

    test('returns message with category prefix', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'network',
        cause: 'connection refused',
        legacyFriendly: '网络错误',
        options: { env: {} },
      });
      expect(result).toContain('网络请求未能完成');
      expect(result).toContain('connection refused');
    });

    test('returns message without duplicate prefix', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'network',
        cause: '网络请求未能完成，连接被拒绝',
        legacyFriendly: '网络错误',
        options: { env: {} },
      });
      expect(result).toContain('具体原因');
    });

    test('handles timeout category', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'timeout',
        cause: 'ETIMEDOUT',
        legacyFriendly: '超时',
        options: { env: {} },
      });
      expect(result).toContain('请求超时');
    });

    test('handles rate_limit category', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'rate_limit',
        cause: 'HTTP 429',
        legacyFriendly: '限流',
        options: { env: {} },
      });
      expect(result).toContain('请求被限流');
    });

    test('handles auth category', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'auth',
        cause: 'HTTP 401',
        legacyFriendly: '认证失败',
        options: { env: {} },
      });
      expect(result).toContain('认证失败');
    });

    test('handles process category', () => {
      const result = resolveFriendlyFailureMessage({
        errorType: 'process',
        cause: 'service crashed',
        legacyFriendly: '进程异常',
        options: { env: {} },
      });
      expect(result).toContain('服务进程异常');
    });
  });

  describe('extractToolFailureReason', () => {
    test('returns empty when disabled', () => {
      const result = extractToolFailureReason(
        { error: 'test error' },
        { env: { KHY_HONEST_FAILURE: '0' } }
      );
      expect(result).toBe('');
    });

    test('returns empty for null entry', () => {
      const result = extractToolFailureReason(null, { env: {} });
      expect(result).toBe('');
    });

    test('extracts from entry.error', () => {
      const result = extractToolFailureReason(
        { error: 'direct error' },
        { env: {} }
      );
      expect(result).toContain('direct error');
    });

    test('extracts from result.error.message', () => {
      const result = extractToolFailureReason(
        { result: { error: { message: 'nested error' } } },
        { env: {} }
      );
      expect(result).toContain('nested error');
    });

    test('extracts from result.data.outputTail', () => {
      const result = extractToolFailureReason(
        { result: { data: { outputTail: 'output tail' } } },
        { env: {} }
      );
      expect(result).toContain('output tail');
    });

    test('includes exit code', () => {
      const result = extractToolFailureReason(
        { result: { data: { outputTail: 'error', exitCode: 1 } } },
        { env: {} }
      );
      expect(result).toContain('[退出码 1]');
    });

    test('returns exit code when no output', () => {
      const result = extractToolFailureReason(
        { result: { data: { exitCode: 1 } } },
        { env: {} }
      );
      expect(result).toContain('退出码 1');
    });

    test('returns empty for zero exit code', () => {
      const result = extractToolFailureReason(
        { result: { data: { exitCode: 0 } } },
        { env: {} }
      );
      expect(result).toBe('');
    });
  });

  describe('buildKeyConfigInvite', () => {
    test('returns empty when disabled', () => {
      const result = buildKeyConfigInvite({
        errorType: 'auth',
        env: { KHY_FAILURE_KEY_INVITE: '0' },
      });
      expect(result).toBe('');
    });

    test('returns empty for non-key categories', () => {
      const result = buildKeyConfigInvite({
        errorType: 'network',
        env: {},
      });
      expect(result).toBe('');
    });

    test('returns invite for auth', () => {
      const result = buildKeyConfigInvite({
        errorType: 'auth',
        env: {},
      });
      expect(result).toContain('API Key 失效');
      expect(result).toContain('换一个新 key');
    });

    test('returns invite for auth_permanent', () => {
      const result = buildKeyConfigInvite({
        errorType: 'auth_permanent',
        env: {},
      });
      expect(result).toContain('API Key 失效');
    });

    test('returns invite for pool_exhausted', () => {
      const result = buildKeyConfigInvite({
        errorType: 'pool_exhausted',
        env: {},
      });
      expect(result).toContain('额度用尽');
    });

    test('returns invite for no_key', () => {
      const result = buildKeyConfigInvite({
        errorType: 'no_key',
        env: {},
      });
      expect(result).toContain('配置');
      expect(result).toContain('API Key');
    });

    test('detects provider from cause', () => {
      const result = buildKeyConfigInvite({
        errorType: 'auth',
        cause: 'deepseek api key invalid',
        env: {},
      });
      expect(result).toContain('DeepSeek');
    });

    test('returns empty for rate_limit', () => {
      const result = buildKeyConfigInvite({
        errorType: 'rate_limit',
        env: {},
      });
      expect(result).toBe('');
    });
  });

  describe('CATEGORY_PREFIX', () => {
    test('has all expected categories', () => {
      expect(CATEGORY_PREFIX.network).toBe('网络请求未能完成');
      expect(CATEGORY_PREFIX.timeout).toBe('请求超时');
      expect(CATEGORY_PREFIX.rate_limit).toBe('请求被限流');
      expect(CATEGORY_PREFIX.auth).toBe('认证失败');
      expect(CATEGORY_PREFIX.process).toBe('服务进程异常');
    });
  });
});
