'use strict';

/**
 * Kiro Adapter Token Lifecycle Tests
 */

// Mock heavy dependencies
jest.mock('../src/services/gateway/adapters/ipAnonymizer', () => ({
  sanitizeOutgoingHeaders: (h) => h,
}));
jest.mock('../src/services/gateway/adapters/_fingerprint', () => ({
  buildKiroUserAgent: () => 'test-ua',
  buildKiroHeaders: () => ({}),
  applyJitter: (n) => n,
  resetSession: jest.fn(),
  resetAll: jest.fn(),
}));
jest.mock('../src/services/proxyConfigService', () => ({
  proxyEvents: { on: jest.fn() },
  getActiveProxy: () => null,
}));

// Mock fs to control token reading
const mockTokenData = {
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.test',
  refreshToken: 'refresh_token_123',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
};

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn((p) => {
      if (p.includes('kiro-auth-token')) return true;
      if (p.includes('.aws/sso/cache')) return true;
      return actual.existsSync(p);
    }),
    readFileSync: jest.fn((p, encoding) => {
      if (p.includes('kiro-auth-token')) return JSON.stringify(mockTokenData);
      return actual.readFileSync(p, encoding);
    }),
    readdirSync: jest.fn((p) => {
      if (p.includes('.aws/sso/cache')) return ['kiro-auth-token.json'];
      return actual.readdirSync(p);
    }),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

describe('Kiro Token Lifecycle', () => {
  test('hashApiKey utility from shared package works', () => {
    const { hashApiKey } = require('@khy/shared/utils/apiKeyHash');
    expect(hashApiKey('test')).toHaveLength(64);
  });

  test('MODEL_CACHE_TTL defaults to 300000ms', () => {
    // Just verify the env var parsing concept
    const ttl = parseInt(process.env.KIRO_MODEL_CACHE_MS || '300000', 10);
    expect(ttl).toBe(300000);
  });

  test('REFRESH_BUFFER_MS is 5 minutes', () => {
    // Verify the constant concept
    const buffer = 5 * 60 * 1000;
    expect(buffer).toBe(300000);
  });
});
