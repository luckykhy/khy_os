'use strict';

process.env.JWT_SECRET = 'unit-test-auth-secret';
process.env.JWT_EXPIRES_IN = '7d';
process.env.AUTH_REFRESH_EXPIRES_IN = '30d';

const jwt = require('jsonwebtoken');

jest.mock('../../src/models', () => ({
  User: { findByPk: jest.fn() },
  AuthSession: {
    update: jest.fn(),
    create: jest.fn(),
    findByPk: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
  },
  UserAuthState: {
    findByPk: jest.fn(),
    create: jest.fn(),
  },
}));

const { User, AuthSession, UserAuthState } = require('../../src/models');
const authSessionService = require('../../src/services/authSessionService');

function makeUser(overrides = {}) {
  return {
    id: 7,
    username: 'alice',
    email: 'alice@example.com',
    role: 'user',
    status: 'active',
    toJSON() {
      return {
        id: this.id,
        username: this.username,
        email: this.email,
        role: this.role,
        status: this.status,
      };
    },
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  const session = {
    id: 'sess_test_1',
    userId: 7,
    tokenVersion: 1,
    status: 'active',
    authMethod: 'password',
    ipAddress: '127.0.0.1',
    userAgent: 'Mozilla/5.0 Chrome/126.0',
    deviceLabel: 'Chrome on Unknown OS',
    loginAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActivityAt: new Date(0),
    lastRefreshAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: null,
    revokedReason: null,
    update: jest.fn(async function update(values) {
      Object.assign(this, values);
      return this;
    }),
    get() {
      return {
        id: this.id,
        userId: this.userId,
        tokenVersion: this.tokenVersion,
        status: this.status,
        authMethod: this.authMethod,
        ipAddress: this.ipAddress,
        userAgent: this.userAgent,
        deviceLabel: this.deviceLabel,
        loginAt: this.loginAt,
        lastActivityAt: this.lastActivityAt,
        lastRefreshAt: this.lastRefreshAt,
        expiresAt: this.expiresAt,
        revokedAt: this.revokedAt,
        revokedReason: this.revokedReason,
      };
    },
    ...overrides,
  };
  return session;
}

describe('authSessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AuthSession.update.mockResolvedValue([0]);
    UserAuthState.findByPk.mockResolvedValue(null);
  });

  test('issues session-backed access and refresh tokens', async () => {
    const user = makeUser();
    const session = makeSession();
    AuthSession.create.mockResolvedValue(session);

    const result = await authSessionService.issueSessionForUser(user, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/126.0' },
      ip: '127.0.0.1',
    }, { authMethod: 'password' });

    expect(AuthSession.create).toHaveBeenCalledWith(expect.objectContaining({
      userId: user.id,
      authMethod: 'password',
      status: 'active',
    }));
    expect(result.refreshToken).toMatch(/^rt_/);
    expect(AuthSession.create.mock.calls[0][0].refreshTokenHash).not.toBe(result.refreshToken);

    const decoded = jwt.verify(result.accessToken, process.env.JWT_SECRET);
    expect(decoded.userId).toBe(user.id);
    expect(decoded.sessionId).toBe(session.id);
    expect(decoded.tokenVersion).toBe(1);
  });

  test('authenticates active session-backed access token', async () => {
    const user = makeUser();
    const session = makeSession();
    const token = jwt.sign(
      { userId: user.id, sessionId: session.id, tokenVersion: 1, tokenType: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    User.findByPk.mockResolvedValue(user);
    AuthSession.findByPk.mockResolvedValue(session);

    const result = await authSessionService.authenticateAccessToken(token);

    expect(result.ok).toBe(true);
    expect(result.legacy).toBe(false);
    expect(result.user).toBe(user);
    expect(result.session).toBe(session);
  });

  test('rejects legacy token after invalidation timestamp', async () => {
    const user = makeUser();
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    User.findByPk.mockResolvedValue(user);
    UserAuthState.findByPk.mockResolvedValue({
      tokenInvalidBefore: new Date(Date.now() + 1000),
    });

    const result = await authSessionService.authenticateAccessToken(token, { touch: false });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('legacy_token_revoked');
  });

  test('refreshSession rotates refresh token and access token version', async () => {
    const user = makeUser();
    const session = makeSession({
      refreshTokenHash: 'old-hash',
    });

    AuthSession.findOne.mockResolvedValue(session);
    User.findByPk.mockResolvedValue(user);

    const result = await authSessionService.refreshSession('raw-refresh-token', {
      headers: { 'user-agent': 'Mozilla/5.0 Firefox/127.0' },
      ip: '10.0.0.8',
    });

    expect(result.ok).toBe(true);
    expect(result.refreshToken).toMatch(/^rt_/);
    expect(session.update).toHaveBeenCalledWith(expect.objectContaining({
      tokenVersion: 2,
      ipAddress: '10.0.0.8',
    }));

    const decoded = jwt.verify(result.accessToken, process.env.JWT_SECRET);
    expect(decoded.tokenVersion).toBe(2);
  });

  test('revokeUserSessions preserves excluded current session', async () => {
    const current = makeSession({ id: 'sess_current' });
    const other = makeSession({ id: 'sess_other' });
    AuthSession.findAll.mockResolvedValue([current, other]);

    const result = await authSessionService.revokeUserSessions(7, {
      excludeSessionId: 'sess_current',
      reason: 'password_change',
    });

    expect(result.revokedCount).toBe(1);
    expect(current.update).not.toHaveBeenCalled();
    expect(other.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'revoked',
      revokedReason: 'password_change',
    }));
  });
});
