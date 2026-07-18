'use strict';

const express = require('express');
const request = require('supertest');

const refreshSession = jest.fn();
const createAuthResponseData = jest.fn();
const serializeSession = jest.fn();
const listUserSessions = jest.fn();
const revokeSessionById = jest.fn();
const invalidateLegacyTokens = jest.fn();
const revokeUserSessions = jest.fn();
const notePasswordChanged = jest.fn();
const issueSessionForUser = jest.fn();

jest.mock('../../src/services/authSessionService', () => ({
  refreshSession: (...args) => refreshSession(...args),
  createAuthResponseData: (...args) => createAuthResponseData(...args),
  serializeSession: (...args) => serializeSession(...args),
  listUserSessions: (...args) => listUserSessions(...args),
  revokeSessionById: (...args) => revokeSessionById(...args),
  invalidateLegacyTokens: (...args) => invalidateLegacyTokens(...args),
  revokeUserSessions: (...args) => revokeUserSessions(...args),
  notePasswordChanged: (...args) => notePasswordChanged(...args),
  issueSessionForUser: (...args) => issueSessionForUser(...args),
}));

jest.mock('../../src/models', () => ({
  User: {
    findOne: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock('../../src/services/userLogService', () => ({
  logUserAction: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req, _res, next) => {
    req.user = {
      id: 3,
      username: 'demo',
      role: 'user',
      status: 'active',
      toJSON() {
        return {
          id: 3,
          username: 'demo',
          role: 'user',
          status: 'active',
        };
      },
    };
    req.authSession = { id: 'sess_current' };
    req.auth = { method: 'jwt', legacy: false, sessionId: 'sess_current' };
    next();
  },
}));

describe('auth routes session endpoints', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../src/routes/auth'));
  });

  test('POST /api/auth/refresh returns rotated token payload', async () => {
    refreshSession.mockResolvedValue({
      ok: true,
      user: {
        id: 3,
        username: 'demo',
        toJSON() {
          return { id: 3, username: 'demo' };
        },
      },
      session: { id: 'sess_rotated' },
    });
    createAuthResponseData.mockReturnValue({
      token: 'access-2',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      user: { id: 3, username: 'demo' },
      session: { id: 'sess_rotated' },
    });

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'refresh-1' });

    expect(res.status).toBe(200);
    expect(refreshSession).toHaveBeenCalledWith('refresh-1', expect.any(Object));
    expect(res.body.data.token).toBe('access-2');
    expect(res.body.data.session.id).toBe('sess_rotated');
  });

  test('GET /api/auth/me returns both flat and nested user payloads', async () => {
    serializeSession.mockReturnValue({ id: 'sess_current', current: true });

    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe('demo');
    expect(res.body.data.user.username).toBe('demo');
    expect(res.body.data.session.id).toBe('sess_current');
  });

  test('GET /api/auth/sessions returns current session id and session list', async () => {
    listUserSessions.mockResolvedValue([
      { id: 'sess_current', current: true },
      { id: 'sess_other', current: false },
    ]);

    const res = await request(app).get('/api/auth/sessions');

    expect(res.status).toBe(200);
    expect(listUserSessions).toHaveBeenCalledWith(3, 'sess_current');
    expect(res.body.data.currentSessionId).toBe('sess_current');
    expect(res.body.data.sessions).toHaveLength(2);
  });
});
