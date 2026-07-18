'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { User, AuthSession, UserAuthState } = require('../models');

const DEFAULT_ACCESS_EXPIRES_IN = process.env.AUTH_ACCESS_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '7d';
const DEFAULT_REFRESH_EXPIRES_IN = process.env.AUTH_REFRESH_EXPIRES_IN || process.env.JWT_REFRESH_EXPIRES_IN || '30d';
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

function parseDurationMs(rawValue, fallbackMs) {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0) {
    return rawValue;
  }

  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return fallbackMs;

  const match = normalized.match(/^(\d+)\s*(ms|s|m|h|d|w)?$/);
  if (!match) return fallbackMs;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 'ms';
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return amount * (multipliers[unit] || 1);
}

function getAccessExpiresIn() {
  return DEFAULT_ACCESS_EXPIRES_IN;
}

function getRefreshExpiresIn() {
  return DEFAULT_REFRESH_EXPIRES_IN;
}

function getRefreshTtlMs() {
  return parseDurationMs(getRefreshExpiresIn(), 30 * 24 * 60 * 60 * 1000);
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createRefreshToken() {
  return `rt_${crypto.randomBytes(48).toString('hex')}`;
}

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') {
    return `sess_${crypto.randomUUID()}`;
  }
  return `sess_${crypto.randomBytes(18).toString('hex')}`;
}

function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
}

function getUserAgent(req) {
  return String(req?.headers?.['user-agent'] || '').trim();
}

function detectDeviceLabel(userAgent = '') {
  const ua = String(userAgent || '').toLowerCase();

  let browser = 'Unknown Browser';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome/')) browser = 'Chrome';
  else if (ua.includes('firefox/')) browser = 'Firefox';
  else if (ua.includes('safari/') && !ua.includes('chrome/')) browser = 'Safari';
  else if (ua.includes('micromessenger/')) browser = 'WeChat';

  let os = 'Unknown OS';
  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac os x') || ua.includes('macintosh')) os = 'macOS';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) os = 'iOS';
  else if (ua.includes('linux')) os = 'Linux';

  if (browser === 'Unknown Browser' && os === 'Unknown OS') return 'Unknown Device';
  if (browser === 'Unknown Browser') return os;
  if (os === 'Unknown OS') return browser;
  return `${browser} on ${os}`;
}

function serializeSession(session, currentSessionId = '') {
  if (!session) return null;

  const plain = typeof session.get === 'function' ? session.get({ plain: true }) : session;
  const currentId = String(currentSessionId || '').trim();

  return {
    id: plain.id,
    authMethod: plain.authMethod || 'password',
    status: plain.status || 'active',
    deviceLabel: plain.deviceLabel || 'Unknown Device',
    ipAddress: plain.ipAddress || '',
    userAgent: plain.userAgent || '',
    loginAt: plain.loginAt || plain.createdAt || null,
    lastActivityAt: plain.lastActivityAt || null,
    lastRefreshAt: plain.lastRefreshAt || null,
    expiresAt: plain.expiresAt || null,
    revokedAt: plain.revokedAt || null,
    revokedReason: plain.revokedReason || null,
    current: !!(currentId && String(plain.id) === currentId),
  };
}

function createAuthResponseData(user, bundle) {
  const safeUser = typeof user?.toJSON === 'function' ? user.toJSON() : user;
  return {
    user: safeUser,
    token: bundle.accessToken,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    expiresIn: bundle.expiresInSeconds,
    refreshExpiresIn: bundle.refreshExpiresInSeconds,
    expiresAt: bundle.expiresAt.toISOString(),
    refreshExpiresAt: bundle.refreshExpiresAt.toISOString(),
    session: serializeSession(bundle.session, bundle.session?.id),
  };
}

async function maybeMarkExpiredSession(session) {
  if (!session || typeof session.update !== 'function') return;
  if (session.status === 'expired') return;
  try {
    await session.update({ status: 'expired' });
  } catch {
    // best effort
  }
}

function maybeTouchSession(session) {
  if (!session || typeof session.update !== 'function') return;
  const lastAt = session.lastActivityAt ? new Date(session.lastActivityAt).getTime() : 0;
  const now = Date.now();
  if (lastAt && (now - lastAt) < SESSION_TOUCH_INTERVAL_MS) return;
  session.update({ lastActivityAt: new Date(now) }).catch(() => {});
}

async function getOrCreateUserAuthState(userId) {
  const existing = await UserAuthState.findByPk(userId);
  if (existing) return existing;
  return UserAuthState.create({ userId });
}

async function invalidateLegacyTokens(userId, reason = 'manual') {
  const state = await getOrCreateUserAuthState(userId);
  const now = new Date();
  await state.update({
    tokenInvalidBefore: now,
    lastInvalidationReason: reason,
  });
  return state;
}

async function notePasswordChanged(userId) {
  const state = await getOrCreateUserAuthState(userId);
  await state.update({
    lastPasswordChangedAt: new Date(),
  });
  return state;
}

async function isLegacyTokenStillValid(userId, decoded = {}) {
  const state = await UserAuthState.findByPk(userId);
  if (!state?.tokenInvalidBefore) return true;
  const issuedAtMs = Number(decoded.iat || 0) * 1000;
  if (!issuedAtMs) return false;
  return issuedAtMs > new Date(state.tokenInvalidBefore).getTime();
}

function signAccessToken(userId, session) {
  return jwt.sign(
    {
      userId,
      sessionId: session.id,
      tokenVersion: Number(session.tokenVersion || 1),
      tokenType: 'access',
    },
    process.env.JWT_SECRET,
    { expiresIn: getAccessExpiresIn() }
  );
}

async function cleanupExpiredSessions(userId = null) {
  const where = {
    revokedAt: null,
    status: { [Op.ne]: 'expired' },
    expiresAt: { [Op.lt]: new Date() },
  };
  if (userId) where.userId = userId;

  try {
    await AuthSession.update(
      { status: 'expired' },
      { where }
    );
  } catch {
    // best effort
  }
}

async function issueSessionForUser(user, req, options = {}) {
  await cleanupExpiredSessions(user?.id || null);

  const now = new Date();
  const refreshExpiresAt = new Date(now.getTime() + getRefreshTtlMs());
  const refreshToken = createRefreshToken();
  const session = await AuthSession.create({
    id: createSessionId(),
    userId: user.id,
    refreshTokenHash: hashRefreshToken(refreshToken),
    tokenVersion: 1,
    status: 'active',
    authMethod: String(options.authMethod || 'password'),
    ipAddress: String(options.ipAddress || getClientIp(req) || ''),
    userAgent: String(options.userAgent || getUserAgent(req) || ''),
    deviceLabel: String(options.deviceLabel || detectDeviceLabel(options.userAgent || getUserAgent(req)) || 'Unknown Device'),
    loginAt: now,
    lastActivityAt: now,
    lastRefreshAt: now,
    expiresAt: refreshExpiresAt,
  });

  const accessToken = signAccessToken(user.id, session);
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(parseDurationMs(getAccessExpiresIn(), 7 * 24 * 60 * 60 * 1000) / 1000),
    refreshExpiresInSeconds: Math.floor(getRefreshTtlMs() / 1000),
    expiresAt: new Date(Date.now() + parseDurationMs(getAccessExpiresIn(), 7 * 24 * 60 * 60 * 1000)),
    refreshExpiresAt,
    session,
  };
}

async function authenticateAccessToken(token, options = {}) {
  if (!token) {
    return { ok: false, code: 'missing_token', message: 'missing token' };
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      return { ok: false, code: 'token_expired', message: 'token expired', error };
    }
    return { ok: false, code: 'invalid_token', message: 'invalid token', error };
  }

  const userId = Number(decoded?.userId || 0);
  if (!userId) {
    return { ok: false, code: 'invalid_token', message: 'missing user id in token' };
  }

  const user = await User.findByPk(userId);
  if (!user) {
    return { ok: false, code: 'user_not_found', message: 'user not found' };
  }

  if (user.status !== 'active') {
    return { ok: false, code: 'user_inactive', message: 'user is inactive', user };
  }

  if (!decoded.sessionId) {
    const legacyAllowed = await isLegacyTokenStillValid(userId, decoded);
    if (!legacyAllowed) {
      return { ok: false, code: 'legacy_token_revoked', message: 'legacy token revoked', user };
    }
    return {
      ok: true,
      code: 'ok',
      method: 'jwt',
      legacy: true,
      user,
      session: null,
      decoded,
    };
  }

  const session = await AuthSession.findByPk(String(decoded.sessionId));
  if (!session || Number(session.userId) !== userId) {
    return { ok: false, code: 'session_not_found', message: 'session not found', user };
  }

  if (session.revokedAt || session.status === 'revoked') {
    return { ok: false, code: 'session_revoked', message: 'session revoked', user, session };
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await maybeMarkExpiredSession(session);
    return { ok: false, code: 'session_expired', message: 'session expired', user, session };
  }

  const decodedVersion = Number(decoded.tokenVersion || 0);
  const sessionVersion = Number(session.tokenVersion || 0);
  if (decodedVersion && sessionVersion && decodedVersion !== sessionVersion) {
    return { ok: false, code: 'token_version_mismatch', message: 'token version mismatch', user, session };
  }

  if (options.touch !== false) {
    maybeTouchSession(session);
  }

  return {
    ok: true,
    code: 'ok',
    method: 'jwt',
    legacy: false,
    user,
    session,
    decoded,
  };
}

async function revokeSessionById(sessionId, reason = 'logout') {
  const session = await AuthSession.findByPk(String(sessionId || ''));
  if (!session) return { revoked: false, session: null };
  if (session.revokedAt || session.status === 'revoked') {
    return { revoked: false, session };
  }

  await session.update({
    status: 'revoked',
    revokedAt: new Date(),
    revokedReason: reason,
  });

  return { revoked: true, session };
}

async function revokeUserSessions(userId, options = {}) {
  const reason = String(options.reason || 'logout_all');
  const excludeSessionId = String(options.excludeSessionId || '').trim();

  // Bulk revoke to avoid TOCTOU race: between findAll + individual updates,
  // a newly-created session could escape revocation.
  const where = {
    userId,
    revokedAt: null,
    status: 'active',
  };
  if (excludeSessionId) {
    where.id = { [Op.ne]: excludeSessionId };
  }

  const [revokedCount] = await AuthSession.update(
    { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
    { where }
  );

  return { revokedCount };
}

async function refreshSession(refreshToken, req, options = {}) {
  if (!refreshToken) {
    return { ok: false, code: 'missing_refresh_token', message: 'missing refresh token' };
  }

  await cleanupExpiredSessions();

  const session = await AuthSession.findOne({
    where: {
      refreshTokenHash: hashRefreshToken(refreshToken),
    },
  });

  if (!session) {
    return { ok: false, code: 'refresh_not_found', message: 'refresh token not found' };
  }

  if (session.revokedAt || session.status === 'revoked') {
    return { ok: false, code: 'refresh_revoked', message: 'refresh token revoked', session };
  }

  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await maybeMarkExpiredSession(session);
    return { ok: false, code: 'refresh_expired', message: 'refresh token expired', session };
  }

  const user = await User.findByPk(session.userId);
  if (!user) {
    return { ok: false, code: 'user_not_found', message: 'user not found' };
  }

  if (user.status !== 'active') {
    return { ok: false, code: 'user_inactive', message: 'user is inactive', user };
  }

  const now = new Date();
  const nextRefreshToken = createRefreshToken();
  const refreshExpiresAt = new Date(now.getTime() + getRefreshTtlMs());

  await session.update({
    refreshTokenHash: hashRefreshToken(nextRefreshToken),
    tokenVersion: Number(session.tokenVersion || 1) + 1,
    lastRefreshAt: now,
    lastActivityAt: now,
    expiresAt: refreshExpiresAt,
    ipAddress: String(options.ipAddress || getClientIp(req) || session.ipAddress || ''),
    userAgent: String(options.userAgent || getUserAgent(req) || session.userAgent || ''),
    deviceLabel: String(options.deviceLabel || detectDeviceLabel(options.userAgent || getUserAgent(req) || session.userAgent || '') || session.deviceLabel || 'Unknown Device'),
  });

  const accessToken = signAccessToken(user.id, session);
  return {
    ok: true,
    code: 'ok',
    user,
    accessToken,
    refreshToken: nextRefreshToken,
    expiresInSeconds: Math.floor(parseDurationMs(getAccessExpiresIn(), 7 * 24 * 60 * 60 * 1000) / 1000),
    refreshExpiresInSeconds: Math.floor(getRefreshTtlMs() / 1000),
    expiresAt: new Date(Date.now() + parseDurationMs(getAccessExpiresIn(), 7 * 24 * 60 * 60 * 1000)),
    refreshExpiresAt,
    session,
  };
}

async function listUserSessions(userId, currentSessionId = '') {
  await cleanupExpiredSessions(userId);

  const sessions = await AuthSession.findAll({
    where: { userId },
    order: [
      ['lastActivityAt', 'DESC'],
      ['loginAt', 'DESC'],
      ['createdAt', 'DESC'],
    ],
  });

  return sessions.map((session) => serializeSession(session, currentSessionId));
}

module.exports = {
  authenticateAccessToken,
  cleanupExpiredSessions,
  createAuthResponseData,
  detectDeviceLabel,
  getClientIp,
  getUserAgent,
  invalidateLegacyTokens,
  issueSessionForUser,
  listUserSessions,
  notePasswordChanged,
  refreshSession,
  revokeSessionById,
  revokeUserSessions,
  serializeSession,
};
