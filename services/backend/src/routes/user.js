const express = require('express');
const router = express.Router();
const { User } = require('../models');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// 获取用户列表（需要管理员权限）
router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']]
    });

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取用户列表失败',
      error: error.message
    });
  }
});

// SaveServerChan SendKey (WeChat push notifications)
// IMPORTANT: Named routes must be defined BEFORE the /:id wildcard route
router.put('/sendkey', authMiddleware, async (req, res) => {
  try {
    const { sendKey } = req.body;

    // Allow null/empty to unbind
    const value = (sendKey && sendKey.trim()) ? sendKey.trim() : null;

    await User.update(
      { sendKey: value },
      { where: { id: req.user.id } }
    );

    res.json({
      success: true,
      message: value ? 'SendKey saved' : 'SendKey unbound'
    });
  } catch (error) {
    console.error('SendKey update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update SendKey' });
  }
});

// Check if SendKey is bound (returns boolean, never the key itself)
router.get('/sendkey-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ['sendKey']
    });

    res.json({
      success: true,
      data: { bound: !!user?.sendKey }
    });
  } catch (error) {
    console.error('SendKey status error:', error);
    res.status(500).json({ success: false, message: 'Failed to check SendKey status' });
  }
});

// 获取用户详情
// IMPORTANT: This wildcard route must be AFTER all named routes
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findByPk(id, {
      attributes: { exclude: ['password'] }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 非管理员只能查看自己的信息
    if (req.user.role !== 'admin' && req.user.id !== parseInt(id)) {
      return res.status(403).json({
        success: false,
        message: '无权访问该用户信息'
      });
    }

    res.json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('获取用户详情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取用户详情失败',
      error: error.message
    });
  }
});

module.exports = router;
