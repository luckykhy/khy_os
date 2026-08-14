'use strict';

/**
 * Tests for mcp/oauthTokenStore.js — multi-backend OAuth token storage.
 */

// Mock the logger before requiring the module under test
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { McpOAuthTokenStore, getTokenStore } = require('../src/services/mcp/oauthTokenStore');

describe('McpOAuthTokenStore', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Constructor ──

  describe('constructor', () => {
    test('defaults to "file" backend when no options given', () => {
      const store = new McpOAuthTokenStore();
      expect(store._backend).toBe('file');
    });

    test('accepts "memory" backend', () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      expect(store._backend).toBe('memory');
    });

    test('accepts "keychain" backend', () => {
      const store = new McpOAuthTokenStore({ backend: 'keychain' });
      expect(store._backend).toBe('keychain');
    });

    test('initializes an empty memoryStore map', () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      expect(store._memoryStore).toBeInstanceOf(Map);
      expect(store._memoryStore.size).toBe(0);
    });
  });

  // ── store() + getToken() round-trip with memory backend ──

  describe('store() + getToken() round-trip (memory)', () => {
    test('stores and retrieves an access token', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      await store.store('srv-1', {
        accessToken: 'tok_abc123',
        tokenType: 'Bearer',
      });

      const token = await store.getToken('srv-1');
      expect(token).toBe('tok_abc123');
      store.destroy();
    });

    test('returns null for an unknown server', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const token = await store.getToken('nonexistent');
      expect(token).toBeNull();
      store.destroy();
    });
  });

  // ── getEntry() ──

  describe('getEntry()', () => {
    test('returns the full entry object with all fields', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const now = Date.now();
      await store.store('srv-2', {
        accessToken: 'tok_full',
        refreshToken: 'ref_full',
        expiresAt: now + 3600_000,
        tokenType: 'Bearer',
        scope: 'read write',
      });

      const entry = await store.getEntry('srv-2');
      expect(entry).toBeDefined();
      expect(entry.accessToken).toBe('tok_full');
      expect(entry.refreshToken).toBe('ref_full');
      expect(entry.tokenType).toBe('Bearer');
      expect(entry.scope).toBe('read write');
      expect(entry.storedAt).toBeGreaterThan(0);
      store.destroy();
    });
  });

  // ── listServers() ──

  describe('listServers()', () => {
    test('returns stored server IDs', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      await store.store('alpha', { accessToken: 'a' });
      await store.store('beta', { accessToken: 'b' });
      await store.store('gamma', { accessToken: 'c' });

      const servers = await store.listServers();
      expect(servers).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
      expect(servers).toHaveLength(3);
      store.destroy();
    });

    test('returns empty array when nothing stored', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const servers = await store.listServers();
      expect(servers).toEqual([]);
      store.destroy();
    });
  });

  // ── revoke() ──

  describe('revoke()', () => {
    test('removes the token from memory store', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      await store.store('srv-del', { accessToken: 'tok_remove' });

      expect(await store.getToken('srv-del')).toBe('tok_remove');
      await store.revoke('srv-del');
      expect(await store.getToken('srv-del')).toBeNull();

      const servers = await store.listServers();
      expect(servers).not.toContain('srv-del');
      store.destroy();
    });
  });

  // ── getStatus() ──

  describe('getStatus()', () => {
    test('returns correct status for a valid (non-expired) token', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const futureTs = Date.now() + 3600_000;
      await store.store('status-valid', {
        accessToken: 'tok_status',
        expiresAt: futureTs,
        tokenType: 'Bearer',
      });

      const status = await store.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0].serverId).toBe('status-valid');
      expect(status[0].hasToken).toBe(true);
      expect(status[0].expired).toBe(false);
      expect(status[0].tokenType).toBe('Bearer');
      store.destroy();
    });

    test('reports expired=true for a token with past expiresAt', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const pastTs = Date.now() - 60_000;
      await store.store('status-expired', {
        accessToken: 'tok_old',
        expiresAt: pastTs,
      });

      const status = await store.getStatus();
      const entry = status.find((s) => s.serverId === 'status-expired');
      expect(entry).toBeDefined();
      expect(entry.expired).toBe(true);
      store.destroy();
    });
  });

  // ── Token expiry detection ──

  describe('token expiry detection', () => {
    test('getToken returns stale token when expired and no refresh/config', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      // Store a token that is already expired (past the refresh buffer)
      await store.store('srv-expired', {
        accessToken: 'tok_expired',
        expiresAt: Date.now() - 600_000, // 10 min ago
      });

      // Since there is no refreshToken/oauthConfig, it should return the stale token
      const token = await store.getToken('srv-expired');
      expect(token).toBe('tok_expired');
      store.destroy();
    });
  });

  // ── startAuthCodeFlow() ──

  describe('startAuthCodeFlow()', () => {
    test('returns authUrl, state, and codeVerifier with valid PKCE', () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });
      const redirectHost = 'localhost';
      const redirectPort = 9999;
      const result = store.startAuthCodeFlow('srv-oauth', {
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-123',
        redirectUri: `http://${redirectHost}:${redirectPort}/callback`,
        scope: 'openid profile',
      });

      expect(result).toHaveProperty('authUrl');
      expect(result).toHaveProperty('state');
      expect(result).toHaveProperty('codeVerifier');

      // state should be a 32-char hex string
      expect(result.state).toMatch(/^[0-9a-f]{32}$/);

      // codeVerifier is base64url from 32 random bytes
      expect(result.codeVerifier.length).toBeGreaterThanOrEqual(32);

      // authUrl should contain key OAuth params
      expect(result.authUrl).toContain('response_type=code');
      expect(result.authUrl).toContain('client_id=client-123');
      expect(result.authUrl).toContain('code_challenge_method=S256');
      expect(result.authUrl).toContain('scope=openid+profile');
      store.destroy();
    });
  });

  // ── destroy() ──

  describe('destroy()', () => {
    test('clears all refresh timers', async () => {
      const store = new McpOAuthTokenStore({ backend: 'memory' });

      // Store tokens with future expiry and refresh tokens to trigger timer scheduling
      await store.store('timer-1', {
        accessToken: 'a',
        refreshToken: 'r1',
        expiresAt: Date.now() + 3600_000,
      });
      await store.store('timer-2', {
        accessToken: 'b',
        refreshToken: 'r2',
        expiresAt: Date.now() + 7200_000,
      });

      expect(store._refreshTimers.size).toBe(2);

      store.destroy();
      expect(store._refreshTimers.size).toBe(0);
    });
  });

  // ── getTokenStore() singleton ──

  describe('getTokenStore()', () => {
    test('returns the same instance on repeated calls', () => {
      // Note: the singleton is module-level so these tests share it.
      // We access it via the named export.
      const s1 = getTokenStore({ backend: 'memory' });
      const s2 = getTokenStore({ backend: 'file' }); // options ignored on second call
      expect(s1).toBe(s2);
      s1.destroy();
    });
  });
});
