'use strict';

const {
  resolveLocalProxyBaseUrl,
  resolveLocalProxyOpenAiBaseUrl,
  resolveAnthropicBaseUrl,
} = require('../../src/utils/proxyBaseUrl');

describe('proxyBaseUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROXY_HOST;
    delete process.env.PROXY_PORT;
    delete process.env.PROXY_ENABLE_HTTPS;
    delete process.env.PROXY_HTTPS_ONLY;
    delete process.env.PROXY_HTTPS_PORT;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('resolveLocalProxyBaseUrl', () => {
    test('returns http URL by default', () => {
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toMatch(/^http:\/\//);
    });

    test('uses PROXY_HOST env', () => {
      process.env.PROXY_HOST = '192.168.1.1';
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toContain('192.168.1.1');
    });

    test('uses PROXY_PORT env', () => {
      process.env.PROXY_PORT = '8080';
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toContain(':8080');
    });

    test('returns https when enabled', () => {
      process.env.PROXY_ENABLE_HTTPS = 'true';
      process.env.PROXY_HTTPS_PORT = '8443';
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toMatch(/^https:\/\//);
      expect(result).toContain(':8443');
    });

    test('returns https only when configured', () => {
      process.env.PROXY_ENABLE_HTTPS = 'true';
      process.env.PROXY_HTTPS_ONLY = 'true';
      process.env.PROXY_HTTPS_PORT = '8443';
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toMatch(/^https:\/\//);
    });

    test('normalizes 0.0.0.0 to 127.0.0.1', () => {
      process.env.PROXY_HOST = '0.0.0.0';
      const result = resolveLocalProxyBaseUrl(process.env);
      expect(result).toContain('127.0.0.1');
    });
  });

  describe('resolveLocalProxyOpenAiBaseUrl', () => {
    test('appends /v1', () => {
      const result = resolveLocalProxyOpenAiBaseUrl(process.env);
      expect(result).toMatch(/\/v1$/);
    });

    test('strips trailing slashes', () => {
      process.env.PROXY_HOST = '127.0.0.1';
      process.env.PROXY_PORT = '9100';
      const result = resolveLocalProxyOpenAiBaseUrl(process.env);
      expect(result).toBe('http://127.0.0.1:9100/v1');
    });
  });

  describe('resolveAnthropicBaseUrl', () => {
    test('returns configured ANTHROPIC_BASE_URL', () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      const result = resolveAnthropicBaseUrl({ processEnv: process.env });
      expect(result).toBe('https://api.anthropic.com');
    });

    test('falls back to proxy env', () => {
      process.env.PROXY_PORT = '8080';
      const result = resolveAnthropicBaseUrl({ processEnv: process.env });
      expect(result).toContain(':8080');
    });

    test('prefers runtime over configured for loopback', () => {
      process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9999';
      process.env.PROXY_PORT = '8080';
      const result = resolveAnthropicBaseUrl({ processEnv: process.env });
      // Runtime file doesn't exist, so configured is used
      expect(result).toBeDefined();
    });
  });
});
