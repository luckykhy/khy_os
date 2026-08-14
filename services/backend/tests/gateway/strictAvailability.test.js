'use strict';

/**
 * Strict-availability classifier tests (single source of truth).
 *
 * Guards the rule introduced to fix the bug where the gateway status panel
 * reported Cursor/Windsurf/Warp as "可用" on machines where those IDEs were
 * not installed. Availability must be:
 *
 *   available = installedLocally && hasGenuineLocalLogin
 *
 * where "genuine local login" means a credential token read from the IDE's own
 * native storage — NOT a pool/imported credential and NOT a Nirvana account
 * switcher cache entry. Imported credentials only count toward availability when
 * the opt-in flag KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS is enabled.
 */

const mixin = require('../../src/services/gateway/adapters/_ideTokenMixin');

const {
  allowImportedCredentials,
  classifyTokenSource,
  isNativeLoginToken,
  countsTowardAvailability,
} = mixin;

// A token shape that passes isLikelyCredentialToken (long, credential-like).
const VALID_ACCESS_TOKEN = `eyJhbGciOiJ${'a'.repeat(48)}.${'b'.repeat(48)}.${'c'.repeat(24)}`;

function localToken(overrides = {}) {
  return { accessToken: VALID_ACCESS_TOKEN, source: 'Cursor', ...overrides };
}

describe('strict availability classifier', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  describe('allowImportedCredentials', () => {
    test('defaults to OFF (strict) when the flag is unset', () => {
      delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;
      expect(allowImportedCredentials()).toBe(false);
    });

    test.each(['1', 'true', 'on', 'yes', 'TRUE', 'On', 'Yes'])(
      'treats %s as enabled',
      (value) => {
        process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = value;
        expect(allowImportedCredentials()).toBe(true);
      },
    );

    test.each(['0', 'false', 'off', 'no', '', '  ', 'maybe'])(
      'treats %s as disabled',
      (value) => {
        process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = value;
        expect(allowImportedCredentials()).toBe(false);
      },
    );
  });

  describe('classifyTokenSource', () => {
    test('classifies native IDE storage sources as local', () => {
      expect(classifyTokenSource(localToken({ source: 'Cursor' }))).toBe('local');
      expect(classifyTokenSource(localToken({ source: 'Windsurf' }))).toBe('local');
      expect(classifyTokenSource(localToken({ source: 'official-trae' }))).toBe('local');
    });

    test('classifies pool-prefixed sources as pool', () => {
      expect(classifyTokenSource(localToken({ source: 'pool:cursor' }))).toBe('pool');
      expect(classifyTokenSource(localToken({ source: 'pool:warp' }))).toBe('pool');
    });

    test('classifies Nirvana account-switcher sources as nirvana', () => {
      expect(classifyTokenSource(localToken({ source: 'nirvana-cache' }))).toBe('nirvana');
      expect(classifyTokenSource(localToken({ source: 'nirvana' }))).toBe('nirvana');
    });

    test('classifies tokens whose path points at a Nirvana cache as nirvana', () => {
      const t = localToken({ source: '', path: '/home/u/.khy/nirvana/trae/storage.json' });
      expect(classifyTokenSource(t)).toBe('nirvana');
    });

    test('defaults to local for malformed input', () => {
      expect(classifyTokenSource(null)).toBe('local');
      expect(classifyTokenSource(undefined)).toBe('local');
      expect(classifyTokenSource('a-string')).toBe('local');
    });
  });

  describe('isNativeLoginToken', () => {
    test('true only for a valid credential from native local storage', () => {
      expect(isNativeLoginToken(localToken())).toBe(true);
    });

    test('false for pool or nirvana sourced tokens even with a valid credential', () => {
      expect(isNativeLoginToken(localToken({ source: 'pool:cursor' }))).toBe(false);
      expect(isNativeLoginToken(localToken({ source: 'nirvana-cache' }))).toBe(false);
    });

    test('false when the credential is missing or too short to be real', () => {
      expect(isNativeLoginToken({ source: 'Cursor' })).toBe(false);
      expect(isNativeLoginToken({ source: 'Cursor', accessToken: 'short' })).toBe(false);
      expect(isNativeLoginToken(null)).toBe(false);
    });
  });

  describe('countsTowardAvailability', () => {
    test('native login always counts, regardless of the imported-credentials flag', () => {
      delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;
      expect(countsTowardAvailability(localToken())).toBe(true);
      process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = '1';
      expect(countsTowardAvailability(localToken())).toBe(true);
    });

    test('pool/nirvana credentials do NOT count when the flag is OFF (strict default)', () => {
      delete process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS;
      expect(countsTowardAvailability(localToken({ source: 'pool:cursor' }))).toBe(false);
      expect(countsTowardAvailability(localToken({ source: 'nirvana-cache' }))).toBe(false);
    });

    test('pool/nirvana credentials DO count when the flag is ON (opt-in restores old behavior)', () => {
      process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = '1';
      expect(countsTowardAvailability(localToken({ source: 'pool:cursor' }))).toBe(true);
      expect(countsTowardAvailability(localToken({ source: 'nirvana-cache' }))).toBe(true);
    });

    test('an invalid/empty token never counts, even with the flag ON', () => {
      process.env.KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS = '1';
      expect(countsTowardAvailability(null)).toBe(false);
      expect(countsTowardAvailability({ source: 'pool:cursor', accessToken: 'short' })).toBe(false);
    });
  });
});
