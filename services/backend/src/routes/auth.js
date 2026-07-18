const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const { User } = require('../models');
const { authMiddleware } = require('../middleware/auth');
const { BACKEND_PORT } = require('../constants/serviceDefaults');
const UserLogService = require('../services/userLogService');
const authSessionService = require('../services/authSessionService');
const { Op } = Sequelize;

// 获取客户端IP地址
const getClientIP = (req) => {
  return req.headers['x-forwarded-for'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '127.0.0.1';
};

const issueAuthResponseData = async (user, req, options = {}) => {
  const bundle = await authSessionService.issueSessionForUser(user, req, options);
  return authSessionService.createAuthResponseData(user, bundle);
};

const extractRefreshToken = (req) => {
  const headerToken = String(req.headers['x-refresh-token'] || '').trim();
  const authHeader = String(req.headers.authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  return String(req.body?.refreshToken || headerToken || bearerToken || '').trim();
};

const mapRefreshFailure = (result) => {
  if (result?.code === 'missing_refresh_token') {
    return { status: 400, message: '缺少刷新令牌' };
  }
  if (result?.code === 'user_inactive') {
    return { status: 403, message: '账户已被禁用' };
  }
  return { status: 401, message: '刷新令牌无效或已过期，请重新登录' };
};

const QR_LOGIN_TTL_MS = 60 * 1000;
const qrLoginStore = new Map();

const getExternalBaseUrl = (req) => {
  const host = (req.headers['x-forwarded-host'] || req.get('host') || `localhost:${BACKEND_PORT}`)
    .split(',')[0]
    .trim();
  const protocol = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return `${protocol === 'https' ? 'https' : 'http'}://${host}`;
};

const cleanupQrLoginStore = () => {
  const now = Date.now();
  for (const [token, record] of qrLoginStore.entries()) {
    if (record.expiresAt <= now || (record.confirmedAt && now - record.confirmedAt > 60 * 1000)) {
      qrLoginStore.delete(token);
    }
  }
};

const buildQrLoginPage = (token) => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>扫码登录确认</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: grid; place-items: center; }
    .card { width: min(92vw, 420px); background: #111827; border: 1px solid #334155; border-radius: 14px; padding: 24px; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 16px; color: #94a3b8; line-height: 1.5; }
    .row { margin-bottom: 12px; }
    label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 10px 12px; outline: none; }
    input:focus { border-color: #60a5fa; box-shadow: 0 0 0 2px rgba(96,165,250,.2); }
    button { width: 100%; margin-top: 4px; border: none; border-radius: 8px; padding: 11px 12px; font-weight: 600; cursor: pointer; background: linear-gradient(135deg, #2563eb, #4f46e5); color: white; font-size: 15px; }
    button:disabled { opacity: .6; cursor: not-allowed; }
    .status { margin-top: 12px; min-height: 22px; font-size: 13px; color: #cbd5e1; }
    .status.error { color: #fca5a5; }
    .status.ok { color: #86efac; }
    .logo { text-align: center; margin-bottom: 16px; font-size: 22px; font-weight: bold; color: #60a5fa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">khy OS AI 平台系统</div>
    <h1>扫码登录确认</h1>
    <p>请输入账号密码，确认在桌面浏览器上的登录请求。</p>
    <form id="confirmForm">
      <div class="row">
        <label for="username">用户名或邮箱</label>
        <input id="username" name="username" autocomplete="username" placeholder="请输入用户名或邮箱" required />
      </div>
      <div class="row">
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required />
      </div>
      <button id="confirmBtn" type="submit">确认登录</button>
      <div id="status" class="status"></div>
    </form>
  </div>
  <script>
    const form = document.getElementById('confirmForm');
    const statusEl = document.getElementById('status');
    const button = document.getElementById('confirmBtn');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      statusEl.className = 'status';
      statusEl.textContent = '正在确认登录...';

      const payload = {
        token: '${token}',
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value
      };

      try {
        const response = await fetch('/api/auth/qr-confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.message || '确认失败');
        }
        statusEl.className = 'status ok';
        statusEl.textContent = '登录成功！请返回桌面浏览器继续操作。';
        button.textContent = '已确认';
      } catch (error) {
        statusEl.className = 'status error';
        statusEl.textContent = error.message || '确认失败，请检查账号密码';
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

// 用户注册
router.post('/register', [
  body('username').trim().isLength({ min: 3, max: 50 }).withMessage('用户名长度必须在3-50个字符之间'),
  body('email').isEmail().withMessage('请输入有效的邮箱地址'),
  body('password').isLength({ min: 6 }).withMessage('密码长度至少6个字符')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: '输入验证失败',
        errors: errors.array()
      });
    }

    const { username, email, password, securityQuestion, securityAnswer } = req.body;

    // 检查用户是否已存在
    const existingUser = await User.findOne({
      where: {
        [Op.or]: [{ username }, { email }]
      }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: '用户名或邮箱已被注册'
      });
    }

    // 创建新用户数据
    const userData = {
      username,
      email,
      password
    };

    // 如果提供了密保问题，添加到用户数据中
    if (securityQuestion && securityAnswer) {
      userData.securityQuestion = securityQuestion;
      userData.securityAnswer = securityAnswer;
    }

    // 创建新用户
    const user = await User.create(userData);

    // 记录注册日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'register',
      actionDescription: '用户注册',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        email: user.email,
        registrationTime: new Date()
      }
    });

    const authData = await issueAuthResponseData(user, req, { authMethod: 'register' });

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: authData
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({
      success: false,
      message: '注册失败',
      error: error.message
    });
  }
});

// 用户登录
router.post('/login', [
  body('username').notEmpty().withMessage('请输入用户名'),
  body('password').notEmpty().withMessage('请输入密码')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: '输入验证失败',
        errors: errors.array()
      });
    }

    const { username, password } = req.body;

    // 查找用户（支持用户名或邮箱登录）
    const user = await User.findOne({
      where: {
        [Op.or]: [
          { username },
          { email: username }
        ]
      }
    });

    if (!user) {
      // 记录登录失败日志
      await UserLogService.logUserAction({
        userId: 0,
        username: username,
        action: 'login',
        actionDescription: '登录失败 - 用户不存在',
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        status: 'failed',
        details: {
          reason: 'user_not_found',
          attemptedUsername: username
        }
      });

      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    // 验证密码
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      // 记录登录失败日志
      await UserLogService.logUserAction({
        userId: user.id,
        username: user.username,
        action: 'login',
        actionDescription: '登录失败 - 密码错误',
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        status: 'failed',
        details: {
          reason: 'invalid_password',
          userId: user.id
        }
      });

      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    if (user.status !== 'active') {
      await UserLogService.logUserAction({
        userId: user.id,
        username: user.username,
        action: 'login',
        actionDescription: '登录失败 - 账户已禁用',
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        status: 'failed',
        details: {
          reason: 'user_inactive',
          userStatus: user.status
        }
      });

      return res.status(403).json({
        success: false,
        message: '账户已被禁用'
      });
    }

    // 更新最后登录时间
    await user.update({ lastLoginAt: new Date() });

    // 记录登录成功日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'login',
      actionDescription: '用户登录成功',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        loginTime: new Date(),
        userRole: user.role
      }
    });

    // Trigger daily instrument sync on first login of the day
    try {
      const instrumentSyncService = require('../services/instrumentSyncService');
      instrumentSyncService.onLogin().catch(() => {});
    } catch { /* ignore */ }

    const authData = await issueAuthResponseData(user, req, { authMethod: 'password' });

    res.json({
      success: true,
      message: '登录成功',
      data: authData
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({
      success: false,
      message: '登录失败',
      error: error.message
    });
  }
});

// 生成扫码登录一次性 token
router.post('/qr-token', async (req, res) => {
  try {
    cleanupQrLoginStore();
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const expiresAt = now + QR_LOGIN_TTL_MS;
    const qrUrl = `${process.env.QR_LOGIN_BASE_URL || getExternalBaseUrl(req)}/api/auth/qr-login?token=${encodeURIComponent(token)}`;

    qrLoginStore.set(token, {
      token,
      status: 'pending',
      createdAt: now,
      expiresAt,
      authToken: null,
      user: null,
      confirmedAt: null
    });

    res.json({
      success: true,
      data: {
        token,
        qrUrl,
        expiresIn: Math.floor(QR_LOGIN_TTL_MS / 1000)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate QR login token'
    });
  }
});

// 轮询扫码登录状态
router.get('/qr-status', async (req, res) => {
  cleanupQrLoginStore();
  const token = String(req.query?.token || '');

  if (!token) {
    return res.status(400).json({ success: false, message: 'Missing token' });
  }

  const record = qrLoginStore.get(token);
  if (!record) {
    return res.status(404).json({ success: true, status: 'expired' });
  }

  if (record.expiresAt <= Date.now()) {
    qrLoginStore.delete(token);
    return res.status(410).json({ success: true, status: 'expired' });
  }

  if (record.status === 'confirmed' && record.authToken) {
    qrLoginStore.delete(token);
    return res.json({
      success: true,
      status: 'confirmed',
      token: record.authToken,
      user: record.user,
      data: record.authData || null
    });
  }

  return res.json({
    success: true,
    status: 'pending',
    expiresIn: Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 1000))
  });
});

// 扫码端页面
router.get('/qr-login', async (req, res) => {
  cleanupQrLoginStore();
  const token = String(req.query?.token || '');

  if (!token) {
    return res.status(400).send('Missing QR token');
  }

  const record = qrLoginStore.get(token);
  if (!record || record.expiresAt <= Date.now()) {
    qrLoginStore.delete(token);
    return res.status(410).send('QR token expired');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(buildQrLoginPage(token));
});

// 扫码端确认登录
router.post('/qr-confirm', [
  body('token').notEmpty().withMessage('token is required'),
  body('username').notEmpty().withMessage('username is required'),
  body('password').notEmpty().withMessage('password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Invalid input', errors: errors.array() });
    }

    cleanupQrLoginStore();
    const token = String(req.body.token);
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const record = qrLoginStore.get(token);
    if (!record) {
      return res.status(404).json({ success: false, message: 'QR login request not found' });
    }
    if (record.expiresAt <= Date.now()) {
      qrLoginStore.delete(token);
      return res.status(410).json({ success: false, message: 'QR login token expired' });
    }

    const user = await User.findOne({
      where: {
        [Op.or]: [{ username }, { email: username }]
      }
    });

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    const validPassword = await user.comparePassword(password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: '账户已被禁用' });
    }

    await user.update({ lastLoginAt: new Date() });

    const authData = await issueAuthResponseData(user, req, { authMethod: 'qr' });
    record.status = 'confirmed';
    record.authToken = authData.token;
    record.user = authData.user;
    record.authData = authData;
    record.confirmedAt = Date.now();
    qrLoginStore.set(token, record);

    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'login',
      actionDescription: '扫码确认登录成功',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        loginType: 'qr',
        loginTime: new Date()
      }
    }).catch(() => {});

    res.json({ success: true, message: 'QR login confirmed' });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to confirm QR login'
    });
  }
});

// 获取当前用户信息
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = req.user.toJSON();
    res.json({
      success: true,
      data: {
        ...user,
        user,
        session: authSessionService.serializeSession(req.authSession, req.authSession?.id || ''),
        authMethod: req.auth?.method || 'jwt',
        legacySession: !!req.auth?.legacy,
      }
    });
  } catch (error) {
    console.error('获取用户信息错误:', error);
    res.status(500).json({
      success: false,
      message: '获取用户信息失败',
      error: error.message
    });
  }
});

// 刷新访问令牌
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = extractRefreshToken(req);
    const result = await authSessionService.refreshSession(refreshToken, req);

    if (!result.ok) {
      const failure = mapRefreshFailure(result);
      return res.status(failure.status).json({
        success: false,
        message: failure.message
      });
    }

    return res.json({
      success: true,
      message: '令牌刷新成功',
      data: authSessionService.createAuthResponseData(result.user, result)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '刷新令牌失败',
      error: error.message
    });
  }
});

// 获取当前账号的登录会话列表
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await authSessionService.listUserSessions(req.user.id, req.authSession?.id || '');
    res.json({
      success: true,
      data: {
        currentSessionId: req.authSession?.id || null,
        legacySession: !!req.auth?.legacy,
        sessions
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取登录会话失败',
      error: error.message
    });
  }
});

// 用户退出登录
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    let revoked = false;
    if (req.authSession?.id) {
      const revokeResult = await authSessionService.revokeSessionById(req.authSession.id, 'logout');
      revoked = !!revokeResult.revoked;
    } else if (req.auth?.legacy) {
      await authSessionService.invalidateLegacyTokens(req.user.id, 'logout');
      revoked = true;
    }

    // 记录退出登录日志
    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'logout',
      actionDescription: '用户退出登录',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        logoutTime: new Date()
      }
    });

    res.json({
      success: true,
      message: '退出登录成功',
      data: {
        revoked,
        currentSessionId: req.authSession?.id || null
      }
    });
  } catch (error) {
    console.error('退出登录错误:', error);
    res.status(500).json({
      success: false,
      message: '退出登录失败',
      error: error.message
    });
  }
});

// 登出所有设备
router.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    const revokeResult = await authSessionService.revokeUserSessions(req.user.id, {
      reason: 'logout_all'
    });
    await authSessionService.invalidateLegacyTokens(req.user.id, 'logout_all');

    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'logout_all',
      actionDescription: '用户退出所有设备',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        revokedSessions: revokeResult.revokedCount,
        logoutTime: new Date()
      }
    });

    res.json({
      success: true,
      message: '已退出所有设备',
      data: {
        revokedSessions: revokeResult.revokedCount
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '退出所有设备失败',
      error: error.message
    });
  }
});

// 撤销指定会话
router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: '缺少会话编号'
      });
    }

    const sessions = await authSessionService.listUserSessions(req.user.id, req.authSession?.id || '');
    const target = sessions.find((session) => String(session.id) === sessionId);
    if (!target) {
      return res.status(404).json({
        success: false,
        message: '会话不存在'
      });
    }

    const result = await authSessionService.revokeSessionById(sessionId, 'manual_revoke');
    return res.json({
      success: true,
      message: '会话已撤销',
      data: {
        revoked: !!result.revoked,
        sessionId
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: '撤销会话失败',
      error: error.message
    });
  }
});

// 修改密码
router.post('/change-password', [
  body('currentPassword').notEmpty().withMessage('请输入当前密码'),
  body('newPassword').isLength({ min: 6 }).withMessage('新密码长度至少6个字符'),
  body('confirmPassword').custom((value, { req }) => {
    if (value !== req.body.newPassword) {
      throw new Error('确认密码与新密码不匹配');
    }
    return true;
  })
], authMiddleware, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: '输入验证失败',
        errors: errors.array()
      });
    }

    const { currentPassword, newPassword } = req.body;

    // 验证当前密码
    const isCurrentPasswordValid = await req.user.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      // 记录密码修改失败日志
      await UserLogService.logUserAction({
        userId: req.user.id,
        username: req.user.username,
        action: 'password_change',
        actionDescription: '密码修改失败 - 当前密码错误',
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        status: 'failed',
        details: {
          reason: 'invalid_current_password'
        }
      });

      return res.status(400).json({
        success: false,
        message: '当前密码错误'
      });
    }

    // 检查新密码是否与当前密码相同
    const isSamePassword = await req.user.comparePassword(newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: '新密码不能与当前密码相同'
      });
    }

    // 更新密码
    await req.user.update({ password: newPassword });
    await authSessionService.notePasswordChanged(req.user.id);
    const revokeResult = await authSessionService.revokeUserSessions(req.user.id, {
      excludeSessionId: req.authSession?.id || '',
      reason: 'password_change'
    });
    await authSessionService.invalidateLegacyTokens(req.user.id, 'password_change');

    // 记录密码修改成功日志
    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'password_change',
      actionDescription: '用户修改密码成功',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      status: 'success',
      details: {
        changeTime: new Date()
      }
    });

    res.json({
      success: true,
      message: '密码修改成功',
      data: {
        revokedOtherSessions: revokeResult.revokedCount,
        currentSessionPreserved: !!req.authSession?.id,
        legacySession: !!req.auth?.legacy
      }
    });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({
      success: false,
      message: '修改密码失败',
      error: error.message
    });
  }
});

module.exports = router;
