/**
 * Minimal auth route for AI Management Backend.
 * Shares the same User model and JWT_SECRET as the trading system,
 * so credentials are interchangeable.
 *
 * ARCH-074: /login 现在接受 username / email / alias 三种 login key（统一 resolveLoginKey）；
 * /register 接受可选 aliases 数组并校验跨账号唯一性。
 */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Sequelize, Op } = require('sequelize');
const { User } = require('@khy/shared/models');
const { authenticateToken } = require('../middleware/auth');
const { resolveLoginKey, normalizeAliases, findAliasConflicts } = require('../services/loginKeyResolver');

// SECURITY: JWT_SECRET must be set in production
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required in production');
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-do-not-use-in-production';

const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// GET /api/auth/default-admin — lightweight, unauthenticated.
// Exposes ONLY the default admin username (NEVER the password) so the login
// page can prefill it. The password lives in .khy/credentials/default-admin.json.
router.get('/default-admin', async (req, res) => {
  try {
    const admin = await User.findOne({
      where: { role: 'admin', status: 'active' },
      order: [['id', 'ASC']],
      attributes: ['username'],
    });
    if (!admin) {
      return res.status(404).json({ success: false, message: '尚未初始化默认管理员' });
    }
    return res.json({ success: true, data: { username: admin.username } });
  } catch (err) {
    console.error('Default admin lookup error:', err.message);
    return res.status(500).json({ success: false, message: '无法获取默认管理员信息' });
  }
});

// POST /api/auth/login
// ARCH-074: username 字段现在统一为「login key」——可以是 username / email / alias。
// 解析顺序由 services/loginKeyResolver.resolveLoginKey 决定。
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Username and password are required' });
    }

    const { user, matchedBy, error } = await resolveLoginKey(username);
    if (error) {
      console.warn(`[auth/login] resolveLoginKey error: ${error}`);
    }
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (String(user.status || '').toLowerCase() !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active' });
    }

    // Straight bcrypt comparison — the legacy admin123 compatibility shim
    // (which rewrote passwords to a weak hardcoded literal) was removed with
    // the dynamic-credential seeding scheme.
    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
        hint: '默认管理员初始密码保存在数据目录的凭证文件中',
      });
    }

    await user.update({ lastLoginAt: new Date() });

    const token = generateToken(user.id);
    const userData = user.toJSON();
    delete userData.password;

    return res.json({
      success: true,
      data: { token, user: userData, matchedBy },
    });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /api/auth/register
// ARCH-074: 接受可选 aliases: string[]。校验跨账号唯一性。
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, aliases } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Username and password are required' });
    }
    // Use same password policy as main backend
    const PASSWORD_MIN_LENGTH = 6;
    if (password.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({ 
        success: false, 
        message: `密码长度至少${PASSWORD_MIN_LENGTH}个字符` 
      });
    }

    // 规范化 alias（去重 / 字符集 / 长度）
    const { aliases: normalizedAliases, errors: aliasErrors } = normalizeAliases(aliases || []);
    if (aliasErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'alias 校验失败',
        details: aliasErrors,
      });
    }
    // alias 不允许与自身 username / email 重复
    const lowerUsername = String(username).toLowerCase();
    const lowerEmail = String(email || '').toLowerCase();
    const selfConflict = normalizedAliases.find(
      (a) => a.toLowerCase() === lowerUsername || (email && a.toLowerCase() === lowerEmail)
    );
    if (selfConflict) {
      return res.status(400).json({
        success: false,
        message: `alias "${selfConflict}" 与 username/email 重复`,
      });
    }
    // 跨账号唯一性
    const { conflicts } = await findAliasConflicts(normalizedAliases, { User });
    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'alias 已被其他账号占用',
        conflicts,
      });
    }
    // username 唯一性（DB 层 unique + 防御性 pre-check）
    const existing = await User.findOne({
      where: {
        [Op.or]: [{ username }, email ? { email } : { id: -1 }],
      },
    });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Username or email already taken',
      });
    }

    const user = await User.create({
      username,
      email: email || `${username}@local.invalid`,
      password,
      aliases: normalizedAliases,
    });
    const token = generateToken(user.id);
    const userData = user.toJSON();
    delete userData.password;
    return res.json({ success: true, data: { token, user: userData } });
  } catch (err) {
    console.error('Register error:', err.message);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Username or email already taken' });
    }
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userData = req.user?.toJSON ? req.user.toJSON() : req.user;
    res.json({ success: true, data: { user: userData || null } });
  } catch (err) {
    console.error('Auth profile error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;