/**
 * 密码重置 REST API —— 忘记密码和密码找回流程
 *
 * 架构角色：属于接入与路由层（对应论文第4.2节）
 *   提供基于密保问题（security question）的密码重置功能，
 *   每个端点带 resetLimiter 限流，防止暴力猜测。
 *
 * 注意：这里是密保问题方案，不是邮箱验证码方案。CLI 侧调用的
 * `/send-code` 与 `/verify-code` 端点在 routes/ 下没有定义，
 * 能力真源见 `/api/auth/capabilities` 的 `passwordReset.mode`。
 *
 * 对应论文：第5.1节（认证与中间件实现）
 */
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const apiResponse = require('../utils/apiResponse');
const { authMiddleware } = require('../middleware/auth');
const { User } = require('../models');
const { normalizeLoginIdentifier, validatePassword } = require('../services/authPolicy');
const authSessionService = require('../services/authSessionService');

// Strict rate limit for password reset to prevent brute-force attacks
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 attempts per window
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
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '请提供用户名或邮箱', { status: 400 });
    }

    // 查找用户
    const whereClause = {};
    if (username) {
      whereClause.username = username;
    }
    if (email) {
      whereClause.email = email;
    }

    const user = await User.findOne({ where: whereClause });

    // Uniform success shape whether or not the account exists. This endpoint is
    // reachable without authentication, so a 200-vs-400 split would be a
    // username-enumeration oracle: an attacker could map live accounts against
    // accounts that have a security question set. The negative case now looks
    // exactly like the positive one — same status, same keys, same latency
    // class — with the question simply null. Callers already treat a null
    // question as "nothing to show", so no frontend change is required.
    const hasQuestion = !!(user && user.securityQuestion);
    apiResponse.success(res, {
      username: hasQuestion ? user.username : null,
      securityQuestion: hasQuestion ? user.securityQuestion : null,
    });
  } catch (error) {
    console.error('获取密保问题失败:', error);
    apiResponse.fail(res, 'INTERNAL', '获取密保问题失败', { status: 500 });
  }
});

// ---------- 第二步：验证密保答案并重置密码 ----------
/**
 * POST /api/password-reset/reset
 * 验证密保答案是否正确，正确则将密码更新为新密码（bcrypt 自动加密）
 */
router.post('/reset', resetLimiter, async (req, res) => {
  try {
    const username = normalizeLoginIdentifier(req.body.username);
    const securityAnswer = String(req.body.securityAnswer || '');
    const newPassword = String(req.body.newPassword || '');

    // 验证必填字段
    if (!username || !securityAnswer || !newPassword) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '请填写所有必填字段', { status: 400 });
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', passwordError, { status: 400 });
    }

    // 查找用户 — use generic error to prevent user enumeration
    const user = await User.findOne({ where: { username } });

    if (!user || !user.securityQuestion || !user.securityAnswer) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '用户名或密保信息不正确', { status: 400 });
    }

    if (user.status !== 'active') {
      return apiResponse.fail(res, 'PERMISSION_DENIED', '账户当前不可重置密码，请联系管理员', { status: 403 });
    }

    // 验证密保答案
    const isAnswerValid = await user.compareSecurityAnswer(securityAnswer);

    if (!isAnswerValid) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '用户名或密保信息不正确', { status: 400 });
    }

    // 更新密码
    user.password = newPassword;
    await user.save();
    await authSessionService.notePasswordChanged(user.id);
    await authSessionService.revokeUserSessions(user.id, { reason: 'password_reset' });
    await authSessionService.invalidateLegacyTokens(user.id, 'password_reset');

    apiResponse.success(res, null, { message: '密码重置成功，请使用新密码登录' });
  } catch (error) {
    console.error('重置密码失败:', error);
    apiResponse.fail(res, 'INTERNAL', '重置密码失败', { status: 500 });
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
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '请填写所有必填字段', { status: 400 });
    }

    // 查找用户
    const user = await User.findByPk(userId);

    if (!user) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '用户不存在', { status: 404 });
    }

    // 验证当前密码
    const isPasswordValid = await user.comparePassword(currentPassword);

    if (!isPasswordValid) {
      return apiResponse.fail(res, 'AUTH_INVALID', '当前密码错误', { status: 401 });
    }

    // 更新密保问题和答案
    user.securityQuestion = securityQuestion;
    user.securityAnswer = securityAnswer;
    await user.save();

    apiResponse.success(res, null, { message: '密保问题设置成功' });
  } catch (error) {
    console.error('设置密保问题失败:', error);
    apiResponse.fail(res, 'INTERNAL', '设置密保问题失败', { status: 500 });
  }
});

module.exports = router;
