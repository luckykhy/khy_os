const express = require('express');
const { Op } = require('sequelize');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');

const { User } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const { BACKEND_PORT } = require('../constants/serviceDefaults');
const authSessionService = require('../services/authSessionService');

const router = express.Router();

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const challengeStore = new Map();

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 将任意格式转为 base64url 字符串存入数据库
 */
function toBase64Url(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  // Uint8Array / Buffer
  return isoBase64URL.fromBuffer(input);
}

/**
 * 将用户ID编码为 Uint8Array（v13 要求）
 */
function userIdToBuffer(id) {
  const str = String(id);
  const buf = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    buf[i] = str.charCodeAt(i);
  }
  return buf;
}

function getRequestHost(req) {
  const fallbackHost = `localhost:${BACKEND_PORT}`;
  const rawHost = (req.headers['x-forwarded-host'] || req.get('host') || fallbackHost)
    .split(',')[0]
    .trim();
  return rawHost || fallbackHost;
}

function getRequestProtocol(req) {
  const rawProto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return rawProto === 'https' ? 'https' : 'http';
}

function getRpContext(req) {
  const host = getRequestHost(req);
  const protocol = getRequestProtocol(req);
  const rpIdCandidate = host.split(':')[0];
  const rpID = rpIdCandidate === '127.0.0.1' ? 'localhost' : rpIdCandidate;
  const rpName = process.env.WEBAUTHN_RP_NAME || 'khy OS Platform';
  const origin = `${protocol}://${host}`;

  const configuredOrigins = (process.env.WEBAUTHN_ORIGIN || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Build expected origins dynamically from current request + env config
  const expectedOrigins = Array.from(new Set([
    origin,
    `http://localhost:${BACKEND_PORT}`,
    `http://127.0.0.1:${BACKEND_PORT}`,
    ...configuredOrigins
  ]));

  return { rpID, rpName, expectedOrigins };
}

function putChallenge(key, payload) {
  challengeStore.set(key, { ...payload, createdAt: Date.now() });
}

function takeChallenge(key) {
  const value = challengeStore.get(key);
  challengeStore.delete(key);
  if (!value) return null;
  if (Date.now() - value.createdAt > CHALLENGE_TTL_MS) return null;
  return value;
}

function sweepExpiredChallenges() {
  const now = Date.now();
  for (const [key, value] of challengeStore.entries()) {
    if (now - value.createdAt > CHALLENGE_TTL_MS) challengeStore.delete(key);
  }
}

function normalizeCredentialPayload(payload) {
  if (payload && payload.credential) return payload.credential;
  if (payload && payload.response) return payload;
  return null;
}

async function findUserByIdentifier(identifier) {
  return User.findOne({
    where: { [Op.or]: [{ username: identifier }, { email: identifier }] }
  });
}

// ── 注册：生成 options ────────────────────────────────────────────────────────
router.post('/register-options', authMiddleware, async (req, res) => {
  try {
    sweepExpiredChallenges();
    const user = req.user;
    const { rpID, rpName, expectedOrigins } = getRpContext(req);

    const excludeCredentials = [];
    if (user.webauthnCredentialId) {
      excludeCredentials.push({
        id: user.webauthnCredentialId,
        type: 'public-key',
        transports: ['internal']
      });
    }

    const options = await generateRegistrationOptions({
      rpID,
      rpName,
      // v13 要求 userID 为 Uint8Array，不再接受字符串
      userID: userIdToBuffer(user.id),
      userName: user.email || user.username,
      userDisplayName: user.username || user.email || `user-${user.id}`,
      timeout: 120000,
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required'
      },
      supportedAlgorithmIDs: [-7, -257],
      excludeCredentials
    });

    putChallenge(`reg:${user.id}`, {
      challenge: options.challenge,
      rpID,
      expectedOrigins
    });

    res.json({ success: true, options });
  } catch (error) {
    console.error('WebAuthn register-options error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate registration options' });
  }
});

// ── 注册：验证响应 ────────────────────────────────────────────────────────────
router.post('/register-verify', authMiddleware, async (req, res) => {
  try {
    sweepExpiredChallenges();
    const user = req.user;
    const credential = normalizeCredentialPayload(req.body);

    if (!credential) {
      return res.status(400).json({ success: false, message: 'Missing WebAuthn registration response payload' });
    }

    // 确保 type 字段存在（前端有时会漏传）
    if (!credential.type) credential.type = 'public-key';

    const saved = takeChallenge(`reg:${user.id}`);
    if (!saved) {
      return res.status(400).json({ success: false, message: 'Registration challenge expired, please retry' });
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: saved.challenge,
      expectedOrigin: saved.expectedOrigins,
      expectedRPID: saved.rpID,
      requireUserVerification: true
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ success: false, message: 'WebAuthn registration verification failed' });
    }

    // v13: registrationInfo.credential 包含 { id, publicKey, counter, ... }
    // publicKey 是 Uint8Array，需要转为 base64url 存储
    const { credential: credInfo } = verification.registrationInfo;

    await user.update({
      webauthnCredentialId: toBase64Url(credInfo.id),
      webauthnPublicKey: toBase64Url(credInfo.publicKey),
      webauthnCounter: credInfo.counter || 0
    });

    res.json({ success: true, message: 'Biometric credential registered successfully' });
  } catch (error) {
    console.error('WebAuthn register-verify error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to verify registration response'
    });
  }
});

// ── 登录：生成 options ────────────────────────────────────────────────────────
router.post('/login-options', async (req, res) => {
  try {
    sweepExpiredChallenges();
    const username = String(req.body?.username || '').trim();
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username or email is required' });
    }

    const user = await findUserByIdentifier(username);
    if (!user || !user.webauthnCredentialId || !user.webauthnPublicKey) {
      return res.status(400).json({
        success: false,
        message: '该账号尚未绑定生物识别，请先用密码登录，再前往「个人中心 → 安全设置」完成绑定'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: '账户已被禁用'
      });
    }

    const { rpID, expectedOrigins } = getRpContext(req);

    const options = await generateAuthenticationOptions({
      rpID,
      timeout: 120000,
      userVerification: 'required',
      allowCredentials: [{
        id: user.webauthnCredentialId,
        type: 'public-key',
        transports: ['internal']
      }]
    });

    putChallenge(`auth:${user.id}`, {
      challenge: options.challenge,
      rpID,
      expectedOrigins
    });

    res.json({ success: true, userId: user.id, options });
  } catch (error) {
    console.error('WebAuthn login-options error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate authentication options' });
  }
});

// ── 登录：验证响应 ────────────────────────────────────────────────────────────
router.post('/login-verify', async (req, res) => {
  try {
    sweepExpiredChallenges();
    const userId = Number.parseInt(String(req.body?.userId || ''), 10);
    const credential = normalizeCredentialPayload(req.body);

    if (!Number.isFinite(userId) || !credential) {
      return res.status(400).json({ success: false, message: 'Invalid WebAuthn authentication payload' });
    }

    const user = await User.findByPk(userId);
    if (!user || !user.webauthnCredentialId || !user.webauthnPublicKey) {
      return res.status(400).json({ success: false, message: 'User has no biometric credential' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: '账户已被禁用' });
    }

    const saved = takeChallenge(`auth:${userId}`);
    if (!saved) {
      return res.status(400).json({ success: false, message: 'Authentication challenge expired, please retry' });
    }

    // v13: credential.publicKey 必须是 Uint8Array
    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: saved.challenge,
      expectedOrigin: saved.expectedOrigins,
      expectedRPID: saved.rpID,
      credential: {
        id: user.webauthnCredentialId,
        publicKey: isoBase64URL.toBuffer(user.webauthnPublicKey),
        counter: Number(user.webauthnCounter || 0),
        transports: ['internal']
      },
      requireUserVerification: true
    });

    if (!verification.verified) {
      return res.status(400).json({ success: false, message: 'Biometric authentication failed' });
    }

    await user.update({
      webauthnCounter: verification.authenticationInfo.newCounter,
      lastLoginAt: new Date()
    });

    const authData = authSessionService.createAuthResponseData(
      user,
      await authSessionService.issueSessionForUser(user, req, { authMethod: 'webauthn' })
    );

    res.json({
      success: true,
      message: 'Biometric login succeeded',
      data: authData
    });
  } catch (error) {
    console.error('WebAuthn login-verify error:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to verify authentication response'
    });
  }
});

// ── 解绑 ──────────────────────────────────────────────────────────────────────
router.post('/unbind', authMiddleware, async (req, res) => {
  try {
    await req.user.update({
      webauthnCredentialId: null,
      webauthnPublicKey: null,
      webauthnCounter: 0
    });
    res.json({ success: true, message: 'Biometric credential removed' });
  } catch (error) {
    console.error('WebAuthn unbind error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to unbind biometric credential' });
  }
});

// ── 状态查询 ──────────────────────────────────────────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    bound: Boolean(req.user.webauthnCredentialId && req.user.webauthnPublicKey)
  });
});

module.exports = router;
