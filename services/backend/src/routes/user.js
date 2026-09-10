const express = require('express');

const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { User } = require('../models');
const apiResponse = require('../utils/apiResponse');

// 获取用户列表（需要管理员权限）
router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']],
    });

    return apiResponse.success(res, users);
  } catch (error) {
    console.error('获取用户列表错误:', error);
    return apiResponse.fail(res, 'INTERNAL', '获取用户列表失败', { status: 500 });
  }
});

// SaveServerChan SendKey (WeChat push notifications)
// IMPORTANT: Named routes must be defined BEFORE the /:id wildcard route
router.put('/sendkey', authMiddleware, async (req, res) => {
  try {
    const { sendKey } = req.body;

    // Allow null/empty to unbind
    const value = sendKey && sendKey.trim() ? sendKey.trim() : null;

    await User.update({ sendKey: value }, { where: { id: req.user.id } });

    return apiResponse.success(res, null, { message: value ? 'SendKey saved' : 'SendKey unbound' });
  } catch (error) {
    console.error('SendKey update error:', error);
    return apiResponse.fail(res, 'INTERNAL', 'Failed to update SendKey', { status: 500 });
  }
});

// Check if SendKey is bound (returns boolean, never the key itself)
router.get('/sendkey-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['sendKey'],
    });

    return apiResponse.success(res, { bound: !!user?.sendKey });
  } catch (error) {
    console.error('SendKey status error:', error);
    return apiResponse.fail(res, 'INTERNAL', 'Failed to check SendKey status', { status: 500 });
  }
});

// 获取用户详情
// IMPORTANT: This wildcard route must be AFTER all named routes
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByPk(id, {
      attributes: { exclude: ['password'] },
    });

    if (!user) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '用户不存在', { status: 404 });
    }

    // 非管理员只能查看自己的信息
    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      return apiResponse.fail(res, 'PERMISSION_DENIED', '无权访问该用户信息', { status: 403 });
    }

    return apiResponse.success(res, user);
  } catch (error) {
    console.error('获取用户详情错误:', error);
    return apiResponse.fail(res, 'INTERNAL', '获取用户详情失败', { status: 500 });
  }
});

module.exports = router;
