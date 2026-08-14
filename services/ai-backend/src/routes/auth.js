/**
 * Minimal auth route for AI Management Backend.
 * Shares the same User model and JWT_SECRET as the trading system,
 * so credentials are interchangeable.
 */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { User } = require('@khy/shared/models');
const { authenticateToken } = require('../middleware/auth');
const { Op } = Sequelize;

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
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
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Username and password are required' });
    }

    const user = await User.findOne({
      where: { [Op.or]: [{ username }, { email: username }] },
    });

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

    res.json({ success: true, data: { token, user: userData } });
  } catch (err) {
    console.error('Auth error:', err.message);
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
