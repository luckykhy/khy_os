'use strict';

const express = require('express');
const request = require('supertest');

const mockAuthContext = {
  user: null,
  auth: null,
  session: null,
};

const mockModels = {
  User: {
    findOne: jest.fn(),
    create: jest.fn(),
    findByPk: jest.fn(),
  },
};

const mockUserLogService = {
  logUserAction: jest.fn().mockResolvedValue(null),
};

const mockAuthSessionService = {
  issueSessionForUser: jest.fn(),
  createAuthResponseData: jest.fn(),
  notePasswordChanged: jest.fn(),
  revokeUserSessions: jest.fn(),
  invalidateLegacyTokens: jest.fn(),
  serializeSession: jest.fn(() => null),
};

jest.mock('../src/models', () => mockModels);
jest.mock('../src/services/userLogService', () => mockUserLogService);
jest.mock('../src/services/authSessionService', () => mockAuthSessionService);
jest.mock('../src/services/instrumentSyncService', () => ({
  onLogin: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req, res, next) => {
    req.user = mockAuthContext.user;
    req.auth = mockAuthContext.auth;
    req.authSession = mockAuthContext.session;
    next();
  },
}));

const authRoutes = require('../src/routes/auth');
const passwordResetRoutes = require('../src/routes/passwordReset');

function createJsonApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

describe('auth route session security', () => {
  const authApp = createJsonApp(authRoutes);
  const passwordResetApp = createJsonApp(passwordResetRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthContext.user = null;
    mockAuthContext.auth = null;
    mockAuthContext.session = null;
    mockAuthSessionService.revokeUserSessions.mockResolvedValue({ revokedCount: 0 });
    mockAuthSessionService.invalidateLegacyTokens.mockResolvedValue({});
    mockAuthSessionService.notePasswordChanged.mockResolvedValue({});
  });

  test('POST /login rejects disabled users before issuing a session', async () => {
    const user = {
      id: 7,
      username: 'blocked-user',
      role: 'user',
      status: 'banned',
      comparePassword: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockModels.User.findOne.mockResolvedValue(user);

    const res = await request(authApp)
      .post('/login')
      .send({ username: 'blocked-user', password: 'secret123' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('账户已被禁用');
    expect(mockAuthSessionService.issueSessionForUser).not.toHaveBeenCalled();
  });

  test('POST /change-password invalidates legacy tokens even without a current db session', async () => {
    const user = {
      id: 9,
      username: 'legacy-user',
      comparePassword: jest.fn(async (password) => password === 'oldpass123'),
      update: jest.fn().mockResolvedValue(undefined),
    };
    mockAuthContext.user = user;
    mockAuthContext.auth = { legacy: true };
    mockAuthContext.session = null;
    mockAuthSessionService.revokeUserSessions.mockResolvedValue({ revokedCount: 2 });

    const res = await request(authApp)
      .post('/change-password')
      .send({
        currentPassword: 'oldpass123',
        newPassword: 'newpass123',
        confirmPassword: 'newpass123',
      });

    expect(res.status).toBe(200);
    expect(mockAuthSessionService.notePasswordChanged).toHaveBeenCalledWith(9);
    expect(mockAuthSessionService.invalidateLegacyTokens).toHaveBeenCalledWith(9, 'password_change');
  });

  test('POST /reset blocks password reset for inactive accounts', async () => {
    const user = {
      id: 12,
      username: 'inactive-user',
      status: 'inactive',
      securityQuestion: 'question',
      securityAnswer: 'hashed-answer',
      compareSecurityAnswer: jest.fn().mockResolvedValue(true),
    };
    mockModels.User.findOne.mockResolvedValue(user);

    const res = await request(passwordResetApp)
      .post('/reset')
      .send({
        username: 'inactive-user',
        securityAnswer: 'secret-answer',
        newPassword: 'newpass123',
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('账户当前不可重置密码，请联系管理员');
    expect(mockAuthSessionService.revokeUserSessions).not.toHaveBeenCalled();
  });
});
