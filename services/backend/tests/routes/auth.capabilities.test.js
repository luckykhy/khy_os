'use strict';

/**
 * auth.capabilities.test.js — GET /api/auth/capabilities is public and truthful.
 *
 * The login page renders from this one call instead of guessing which recovery
 * paths exist. The important property is non-drift: every advertised
 * capability must still have a backing route, and a capability that was
 * removed must stop being advertised. Half of the value of this endpoint is
 * the assertion below that checks the router table against the table.
 */

const express = require('express');
const request = require('supertest');

// Variable names prefixed with `mock` so Jest's babel plugin hoists them
// alongside jest.mock(), avoiding TDZ errors in the factory closure.
const mockRefreshSession = jest.fn();
const mockCreateAuthResponseData = jest.fn();
const mockListUserSessions = jest.fn();
const mockRevokeUserSessions = jest.fn();
const mockIssueSessionForUser = jest.fn();
const mockAuthenticateAccessToken = jest.fn();

jest.mock('../../src/services/authSessionService', () => ({
  refreshSession: (...args) => mockRefreshSession(...args),
  createAuthResponseData: (...args) => mockCreateAuthResponseData(...args),
  listUserSessions: (...args) => mockListUserSessions(...args),
  revokeUserSessions: (...args) => mockRevokeUserSessions(...args),
  issueSessionForUser: (...args) => mockIssueSessionForUser(...args),
  authenticateAccessToken: (...args) => mockAuthenticateAccessToken(...args),
}));

jest.mock('../../src/models', () => ({
  User: { findOne: jest.fn(), create: jest.fn(), findByPk: jest.fn() },
  sequelize: { getQueryInterface: () => ({ describeTable: jest.fn(async () => null) }) },
  QueryTypes: { SELECT: 'SELECT', UPDATE: 'UPDATE' },
}));

jest.mock('../../src/services/userLogService', () => ({
  logUserAction: jest.fn().mockResolvedValue(null),
}));

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../src/routes/auth'));

function mountedPaths() {
  const router = require('../../src/routes/auth');
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => Object.keys(layer.route.methods).join(',') + ' ' + layer.route.path);
}

describe('GET /api/auth/capabilities', () => {
  it('is public: no bearer token required', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockAuthenticateAccessToken).not.toHaveBeenCalled();
  });

  it('advertises the methods the router actually implements', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    const caps = res.body.data;

    expect(caps.passwordLogin).toBe(true);
    expect(caps.registration).toBe(true);
    expect(caps.changePassword).toBe(true);
    expect(caps.securityQuestion).toBe(true);
    expect(caps.cliTokenLogin).toBe(true);
    expect(caps.webauthn).toBe(true);
    expect(caps.qrLogin).toEqual({ enabled: true, ttlSeconds: 60 });
  });

  it('keeps /default-admin advertised as unavailable in the monolith', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    expect(res.body.data.defaultAdminAvailable).toBe(false);
    // The login page renders a button from this flag. If someone ever mounts
    // the daemon route here, this assertion fails and the flag must be
    // updated on purpose rather than drifting.
    expect(mountedPaths().join('\n')).not.toMatch(/default-admin/);
  });

  it('reports no oauth providers while none are wired', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    expect(res.body.data.oauthProviders).toEqual([]);
  });

  it('pins passwordReset.mode so the frontend cannot guess', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    expect(res.body.data.passwordReset).toEqual({ mode: 'security-question' });
  });

  it('advertises no first-run setup gate', async () => {
    const res = await request(app).get('/api/auth/capabilities');
    expect(res.body.data.setupRequired).toBe(false);
  });

  it('leaks no credential material (answer, key, or secret-shaped value)', async () => {
    const body = (await request(app).get('/api/auth/capabilities')).body;
    const data = body.data;

    // Nothing answer-shaped or key-shaped may appear at any depth.
    expect(Object.keys(data).join(',')).not.toMatch(/securityAnswer|apiKey|rawKey|plaintext/i);
    const payload = JSON.stringify(data);
    expect(payload).not.toMatch(/KEY_SECRET|Bearer\s+/i);
    // The only free-form string in `data` is passwordReset.mode; every other
    // string value must stay short, so a secret cannot be smuggled in as a
    // new capability field.
    const longStrings = [];
    (function walk(node) {
      if (typeof node === 'string' && node.length > 24) longStrings.push(node);
      if (node && typeof node === 'object') {
        for (const value of Object.values(node)) walk(value);
      }
    })(data);
    expect(longStrings).toEqual([]);
  });

  it('every advertised capability has a backing route in this router', () => {
    const router = require('../../src/routes/auth');
    const paths = new Set(
      router.stack.filter((l) => l.route).map((l) => l.route.path)
    );

    expect(paths.has('/login')).toBe(true);
    expect(paths.has('/register')).toBe(true);
    expect(paths.has('/me')).toBe(true);
    expect(paths.has('/change-password')).toBe(true);
    expect(paths.has('/qr-token')).toBe(true);
    expect(paths.has('/qr-status')).toBe(true);
    expect(paths.has('/qr-login')).toBe(true);
    expect(paths.has('/qr-confirm')).toBe(true);
    expect(paths.has('/capabilities')).toBe(true);
  });
});
