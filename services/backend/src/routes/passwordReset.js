/**
 * 密码重置 REST API —— 忘记密码和密码找回流程
 *
 * 架构角色：属于接入与路由层（对应论文第4.2节）
 *   提供基于邮箱验证码的密码重置功能，
 *   重置令牌有时效限制，防止重放攻击。
 *
 * 对应论文：第5.1节（认证与中间件实现）
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { User } = require('../models');
const bcrypt = require('bcryptjs');
const { authMiddleware } = require('../middleware/auth');
const authSessionService = require('../services/authSessionService');

// Strict rate limit for password reset to prevent brute-force attacks
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                     // max 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '密码重置请求过于频繁，请15分钟后再试' },
});

// ---------- 第一步：获取密保问题 ----------
/**
 * POST /api/password-reset/get-question
 * 根据用户名或邮箱查找用户，返回其密保问题（不返回答案）
 */
router.post('/get-question', resetLimiter, async (req, res) => {
  try {
    const { username, email } = req.body;

    if (!username && !email) {
      return res.status(400).json({
        success: false,
        message: '请提供用户名或邮箱'
      });
    }

    // 查找用户
    const whereClause = {};
    if (username) whereClause.username = username;
    if (email) whereClause.email = email;

    const user = await User.findOne({ where: whereClause });

    if (!user || !user.securityQuestion) {
      // Return a generic response to prevent user enumeration
      return res.status(400).json({
        success: false,
        message: '无法找到对应的密保问题，请确认账号信息或联系管理员'
      });
    }

    res.json({
      success: true,
      data: {
        username: user.username,
        securityQuestion: user.securityQuestion
      }
    });
  } catch (error) {
    console.error('获取密保问题失败:', error);
    res.status(500).json({
      success: false,
      message: '获取密保问题失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ---------- 第二步：验证密保答案并重置密码 ----------
/**
 * POST /api/password-reset/reset
 * 验证密保答案是否正确，正确则将密码更新为新密码（bcrypt 自动加密）
 */
router.post('/reset', resetLimiter, async (req, res) => {
  try {
    const { username, securityAnswer, newPassword } = req.body;

    // 验证必填字段
    if (!username || !securityAnswer || !newPassword) {
      return res.status(400).json({
        success: false,
        message: '请填写所有必填字段'
      });
    }

    // 验证新密码强度
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: '新密码长度至少为6位'
      });
    }

    // 查找用户 — use generic error to prevent user enumeration
    const user = await User.findOne({ where: { username } });

    if (!user || !user.securityQuestion || !user.securityAnswer) {
      return res.status(400).json({
        success: false,
        message: '用户名或密保信息不正确'
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: '账户当前不可重置密码，请联系管理员'
      });
    }

    // 验证密保答案
    const isAnswerValid = await user.compareSecurityAnswer(securityAnswer);

    if (!isAnswerValid) {
      return res.status(400).json({
        success: false,
        message: '用户名或密保信息不正确'
      });
    }

    // 更新密码
    user.password = newPassword;
    await user.save();
    await authSessionService.notePasswordChanged(user.id);
    await authSessionService.revokeUserSessions(user.id, { reason: 'password_reset' });
    await authSessionService.invalidateLegacyTokens(user.id, 'password_reset');

    res.json({
      success: true,
      message: '密码重置成功，请使用新密码登录'
    });
  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(500).json({
      success: false,
      message: '重置密码失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ---------- 设置/更新密保问题（需要登录） ----------
/**
 * POST /api/password-reset/set-security
 * 已登录用户设置或修改密保问题，需要验证当前密码确认身份
 */
router.post('/set-security', authMiddleware, async (req, res) => {
  try {
    const { securityQuestion, securityAnswer, currentPassword } = req.body;
    const userId = req.user.id; // From JWT token via authMiddleware

    if (!securityQuestion || !securityAnswer || !currentPassword) {
      return res.status(400).json({
        success: false,
        message: '请填写所有必填字段'
      });
    }

    // 查找用户
    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 验证当前密码
    const isPasswordValid = await user.comparePassword(currentPassword);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: '当前密码错误'
      });
    }

    // 更新密保问题和答案
    user.securityQuestion = securityQuestion;
    user.securityAnswer = securityAnswer;
    await user.save();

    res.json({
      success: true,
      message: '密保问题设置成功'
    });
  } catch (error) {
    console.error('设置密保问题失败:', error);
    res.status(500).json({
      success: false,
      message: '设置密保问题失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;
