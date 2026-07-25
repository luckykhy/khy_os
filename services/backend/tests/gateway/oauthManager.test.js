'use strict';

/**
 * Behavior tests for gateway/oauthManager.js (resolved through the @khy/shared shim).
 *
 * The module reads its token-store path from OAUTH_TOKENS_PATH at load time, so
 * we point it at a throwaway temp file — the suite never touches the real
 * ~/.khyquant/oauth_tokens.json. These tests pin the canonical (superset)
 * behavior the shared module must keep providing to both backend and ai-backend.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TOKEN_PATH = path.join(
  os.tmpdir(),
  `khy-oauth-tokens-${process.pid}-${Date.now()}.json`,
);
process.env.OAUTH_TOKENS_PATH = TOKEN_PATH;

// Far enough ahead to count as "valid" yet beyond the 24h auto-refresh window,
// so registerProvider schedules no timer and jest stays handle-free.
const FUTURE = Date.now() + 48 * 60 * 60 * 1000;

const oauth = require('../../src/services/gateway/oauthManager');

afterAll(() => {
  try { fs.unlinkSync(TOKEN_PATH); } catch { /* already gone */ }
});

describe('gateway/oauthManager exports', () => {
  test('exposes the expected API surface', () => {
    for (const fn of [
      'getToken', 'registerProvider', 'revokeToken', 'getTokenStatus',
      'getAllStatus', 'refreshToken', 'refreshAll', 'getKnownProviders', 'init',
    ]) {
      expect(typeof oauth[fn]).toBe('function');
    }
    expect(typeof oauth.PROVIDER_CONFIGS).toBe('object');
  });
});

describe('registerProvider() + getTokenStatus()', () => {
  test('registers a provider and reports a rich, masked status', () => {
    oauth.registerProvider('gemini', {
      clientId: 'client-1234567890',
      clientSecret: 'secret-abcdef',
      refreshToken: 'rt-token',
      accessToken: 'at-token',
      expiresAt: FUTURE,
    });

    const s = oauth.getTokenStatus('gemini');
    expect(s.registered).toBe(true);
    expect(s.valid).toBe(true);
    expect(s.hasRefreshToken).toBe(true);
    expect(s.hasClientId).toBe(true);
    expect(s.hasClientSecret).toBe(true);
    expect(s.hasAccessToken).toBe(true);
    expect(s.provider).toBe('Gemini');
    expect(s.supportsRefresh).toBe(true);
    // clientId is masked — never returned in clear text
    expect(s.clientIdMasked).toBe('clie...90');
    expect(s.clientIdMasked).not.toContain('1234567890');
  });

  test('merge semantics: a partial re-register preserves prior fields', () => {
    // Update only the access token; refreshToken/clientId must survive.
    oauth.registerProvider('gemini', { accessToken: 'at-token-2', expiresAt: FUTURE });

    const s = oauth.getTokenStatus('gemini');
    expect(s.hasRefreshToken).toBe(true); // preserved, not wiped
    expect(s.hasClientId).toBe(true);     // preserved
    expect(s.hasAccessToken).toBe(true);
  });

  test('an unregistered known provider still reports a consistent shape', () => {
    const s = oauth.getTokenStatus('codex');
    expect(s.registered).toBe(false);
    expect(s.provider).toBe('Codex');
    expect(s.hasRefreshToken).toBe(false);
    expect(s.clientIdMasked).toBe('');
  });
});

describe('getToken()', () => {
  test('returns the stored access token while still valid (no refresh)', async () => {
    const token = await oauth.getToken('gemini');
    expect(token).toBe('at-token-2');
  });

  test('returns null for an unknown provider', async () => {
    const token = await oauth.getToken('__nope__');
    expect(token).toBeNull();
  });
});

describe('getAllStatus()', () => {
  test('includes every known provider with a full status shape', () => {
    const all = oauth.getAllStatus();
    for (const key of ['kiro', 'codex', 'gemini', 'qwen']) {
      expect(all[key]).toBeDefined();
      expect(typeof all[key].registered).toBe('boolean');
      expect(typeof all[key].provider).toBe('string');
    }
    expect(all.gemini.registered).toBe(true);
  });
});

describe('getKnownProviders()', () => {
  test('returns metadata for the four configured providers', () => {
    const known = oauth.getKnownProviders();
    expect(Object.keys(known).sort()).toEqual(['codex', 'gemini', 'kiro', 'qwen']);
    expect(known.kiro.name).toBe('Kiro');
    expect(Array.isArray(known.kiro.scopes)).toBe(true);
    expect(known.qwen.supportsRefresh).toBe(false);
  });
});

describe('token store file', () => {
  test('is persisted with 0600 permissions on POSIX', () => {
    expect(fs.existsSync(TOKEN_PATH)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(TOKEN_PATH).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
