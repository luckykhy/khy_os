'use strict';

const express = require('express');
const request = require('supertest');

// Variable names prefixed with `mock` so Jest's babel plugin hoists them
// alongside jest.mock(), avoiding TDZ errors in the factory closure.
const mockRefreshSession = jest.fn();
const mockCreateAuthResponseData = jest.fn();
const mockSerializeSession = jest.fn();
const mockListUserSessions = jest.fn();
const mockRevokeSessionById = jest.fn();
const mockInvalidateLegacyTokens = jest.fn();
const mockRevokeUserSessions = jest.fn();
const mockNotePasswordChanged = jest.fn();
const mockIssueSessionForUser = jest.fn();

jest.mock('../../src/services/authSessionService', () => ({
  refreshSession: (...args) => mockRefreshSession(...args),
  createAuthResponseData: (...args) => mockCreateAuthResponseData(...args),
  serializeSession: (...args) => mockSerializeSession(...args),
  listUserSessions: (...args) => mockListUserSessions(...args),
  revokeSessionById: (...args) => mockRevokeSessionById(...args),
  invalidateLegacyTokens: (...args) => mockInvalidateLegacyTokens(...args),
  revokeUserSessions: (...args) => mockRevokeUserSessions(...args),
  notePasswordChanged: (...args) => mockNotePasswordChanged(...args),
  issueSessionForUser: (...args) => mockIssueSessionForUser(...args),
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
    mockRefreshSession.mockResolvedValue({
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
    mockCreateAuthResponseData.mockReturnValue({
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
    expect(mockRefreshSession).toHaveBeenCalledWith('refresh-1', expect.any(Object));
    expect(res.body.data.token).toBe('access-2');
    expect(res.body.data.session.id).toBe('sess_rotated');
  });

  test('GET /api/auth/me returns both flat and nested user payloads', async () => {
    mockSerializeSession.mockReturnValue({ id: 'sess_current', current: true });

    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe('demo');
    expect(res.body.data.user.username).toBe('demo');
    expect(res.body.data.session.id).toBe('sess_current');
  });

  test('GET /api/auth/sessions returns current session id and session list', async () => {
    mockListUserSessions.mockResolvedValue([
      { id: 'sess_current', current: true },
      { id: 'sess_other', current: false },
    ]);

    const res = await request(app).get('/api/auth/sessions');

    expect(res.status).toBe(200);
    expect(mockListUserSessions).toHaveBeenCalledWith(3, 'sess_current');
    expect(res.body.data.currentSessionId).toBe('sess_current');
    expect(res.body.data.sessions).toHaveLength(2);
  });
});
