'use strict';

describe('config/env', () => {
  // Save and restore env between tests
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  // Re-require to get a fresh module each time
  function loadEnv() {
    // The backend re-exports from shared
    return require('../../src/config/env');
  }

  describe('applyEnvDefaults()', () => {
    test('is a function', () => {
      const env = loadEnv();
      expect(typeof env.applyEnvDefaults).toBe('function');
    });

    test('sets NODE_ENV to development if not set', () => {
      delete process.env.NODE_ENV;
      const env = loadEnv();
      env.applyEnvDefaults();
      expect(process.env.NODE_ENV).toBe('development');
    });

    test('sets PORT to 3000 if not set', () => {
      delete process.env.PORT;
      const env = loadEnv();
      env.applyEnvDefaults();
      expect(process.env.PORT).toBe('3000');
    });

    test('sets DB_TYPE to auto if not set', () => {
      delete process.env.DB_TYPE;
      const env = loadEnv();
      env.applyEnvDefaults();
      expect(process.env.DB_TYPE).toBe('auto');
    });

    test('does not overwrite existing values', () => {
      process.env.PORT = '5000';
      const env = loadEnv();
      env.applyEnvDefaults();
      expect(process.env.PORT).toBe('5000');
    });

    test('sets rate limit defaults', () => {
      delete process.env.RATE_LIMIT_API_MAX;
      delete process.env.RATE_LIMIT_AUTH_MAX;
      delete process.env.RATE_LIMIT_AI_MAX;
      const env = loadEnv();
      env.applyEnvDefaults();
      expect(process.env.RATE_LIMIT_API_MAX).toBe('600');
      expect(process.env.RATE_LIMIT_AUTH_MAX).toBe('30');
      expect(process.env.RATE_LIMIT_AI_MAX).toBe('120');
    });
  });

  describe('validateRequiredEnv()', () => {
    test('is a function', () => {
      const env = loadEnv();
      expect(typeof env.validateRequiredEnv).toBe('function');
    });

    test('warns in development when JWT_SECRET is missing', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.JWT_SECRET;
      const env = loadEnv();
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      env.validateRequiredEnv();
      // Should have warned, not thrown
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    test('warns in development when JWT_SECRET is weak', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'secret';
      const env = loadEnv();
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      env.validateRequiredEnv();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    test('does not throw in development for invalid PORT', () => {
      process.env.NODE_ENV = 'development';
      process.env.PORT = '99999';
      process.env.JWT_SECRET = 'x'.repeat(32);
      const env = loadEnv();
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => env.validateRequiredEnv()).not.toThrow();
      spy.mockRestore();
    });

    test('no warnings when all required vars are valid', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'abcdefghijklmnopqrstuvwxyz1234567890';
      process.env.PORT = '3000';
      process.env.DB_TYPE = 'sqlite';
      const env = loadEnv();
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      env.validateRequiredEnv();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
