'use strict';

const { resolveProxyCorsOrigin } = require('../../../src/services/gateway/corsUtils');

describe('corsUtils', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PROXY_CORS_ORIGINS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns null for empty origin', () => {
    expect(resolveProxyCorsOrigin('')).toBe('null');
  });

  test('allows loopback when no PROXY_CORS_ORIGINS', () => {
    expect(resolveProxyCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveProxyCorsOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  test('rejects non-loopback when no PROXY_CORS_ORIGINS', () => {
    expect(resolveProxyCorsOrigin('https://example.com')).toBe('null');
  });
});
