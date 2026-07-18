/**
 * Unit tests for rateLimit middleware module.
 *
 * Verifies the module exports the expected limiter objects.
 * express-rate-limit is a real dependency so we can test the shape
 * of the returned middleware without mocking it.
 */

// Mock logger to prevent winston file I/O during tests
jest.mock('@khy/shared/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const rateLimitModule = require('../../src/middleware/rateLimit');

describe('rateLimit middleware', () => {
  test('exports an object', () => {
    expect(rateLimitModule).toBeDefined();
    expect(typeof rateLimitModule).toBe('object');
  });

  test('exports apiLimiter', () => {
    expect(rateLimitModule.apiLimiter).toBeDefined();
  });

  test('apiLimiter is a function (Express middleware)', () => {
    expect(typeof rateLimitModule.apiLimiter).toBe('function');
  });

  test('exports authLimiter', () => {
    expect(rateLimitModule.authLimiter).toBeDefined();
  });

  test('authLimiter is a function (Express middleware)', () => {
    expect(typeof rateLimitModule.authLimiter).toBe('function');
  });

  test('exports aiLimiter', () => {
    expect(rateLimitModule.aiLimiter).toBeDefined();
  });

  test('aiLimiter is a function (Express middleware)', () => {
    expect(typeof rateLimitModule.aiLimiter).toBe('function');
  });

  test('does not export unexpected keys beyond the three limiters', () => {
    const keys = Object.keys(rateLimitModule);
    expect(keys).toEqual(expect.arrayContaining(['apiLimiter', 'authLimiter', 'aiLimiter']));
    expect(keys.length).toBe(3);
  });
});
