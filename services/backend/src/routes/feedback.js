const express = require('express');
const router = express.Router();
const { Feedback, User } = require('../models');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { Op } = require('sequelize');

// 获取用户的反馈列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, type, status } = req.query;
    const offset = (page - 1) * pageSize;

    const whereClause = {
      userId: req.user.id
    };

    if (type) whereClause.type = type;
    if (status) whereClause.status = status;

    const { count, rows } = await Feedback.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'admin',
          attributes: [...User.REFERENCE_ATTRIBUTES],
          required: false
        }
      ],
      order: [['created_at', 'DESC']],
      limit: parseInt(pageSize),
      offset: offset
    });

    res.json({
      success: true,
      data: {
        list: rows,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取反馈列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取反馈列表失败'
    });
  }
});

// 获取反馈详情
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const feedback = await Feedback.findOne({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      include: [
        {
          model: User,
          as: 'user',
          attributes: [...User.REFERENCE_ATTRIBUTES]
        },
        {
          model: User,
          as: 'admin',
          attributes: [...User.REFERENCE_ATTRIBUTES],
          required: false
        }
      ]
    });

    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: '反馈不存在'
      });
    }

    res.json({
      success: true,
      data: feedback
    });
  } catch (error) {
    console.error('获取反馈详情失败:', error);
    res.status(500).json({
      success: false,
      message: '获取反馈详情失败'
    });
  }
});

// 提交新反馈
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, content, type, priority, contactInfo, metadata } = req.body;

    // 验证必填字段
    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: '标题和内容不能为空'
      });
    }

    const feedback = await Feedback.create({
      userId: req.user.id,
      title: title.trim(),
      content: content.trim(),
      type: type || 'suggestion',
      priority: priority || 'normal',
      contactInfo: contactInfo?.trim(),
      metadata: metadata || {}
    });

    // 获取完整的反馈信息
    const fullFeedback = await Feedback.findByPk(feedback.id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: [...User.REFERENCE_ATTRIBUTES]
        }
      ]
    });

    res.status(201).json({
      success: true,
      message: '反馈提交成功',
      data: fullFeedback
    });
  } catch (error) {
    console.error('提交反馈失败:', error);
    res.status(500).json({
      success: false,
      message: '提交反馈失败'
    });
  }
});

// 管理员获取所有反馈列表
router.get('/admin/list', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { 
      page = 1, 
      pageSize = 10, 
      type, 
      status, 
      priority,
      userId,
      search 
    } = req.query;
    const offset = (page - 1) * pageSize;

    const whereClause = {};

    if (type) whereClause.type = type;
    if (status) whereClause.status = status;
    if (priority) whereClause.priority = priority;
    if (userId) whereClause.userId = userId;
    
    if (search) {
      whereClause[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { content: { [Op.iLike]: `%${search}%` } }
      ];
    }

    const { count, rows } = await Feedback.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: User,
          as: 'user',
          attributes: [...User.PUBLIC_ATTRIBUTES]
        },
        {
          model: User,
          as: 'admin',
          attributes: [...User.REFERENCE_ATTRIBUTES],
          required: false
        }
      ],
      order: [
        ['priority', 'DESC'],
        ['created_at', 'DESC']
      ],
      limit: parseInt(pageSize),
      offset: offset
    });

    res.json({
      success: true,
      data: {
        list: rows,
        total: count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });
  } catch (error) {
    console.error('获取反馈列表失败:', error);
    res.status(500).json({
      success: false,
      message: '获取反馈列表失败'
    });
  }
});

// 管理员获取反馈统计
router.get('/admin/stats', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const total = await Feedback.count();
    const pending = await Feedback.count({ where: { status: 'pending' } });
    const processing = await Feedback.count({ where: { status: 'processing' } });
    const resolved = await Feedback.count({ where: { status: 'resolved' } });
    const closed = await Feedback.count({ where: { status: 'closed' } });

    const byType = await Feedback.findAll({
      attributes: [
        'type',
        [require('sequelize').fn('COUNT', '*'), 'count']
      ],
      group: ['type']
    });

    const byPriority = await Feedback.findAll({
      attributes: [
        'priority',
        [require('sequelize').fn('COUNT', '*'), 'count']
      ],
      group: ['priority']
    });

    res.json({
      success: true,
      data: {
        total,
        pending,
        processing,
        resolved,
        closed,
        byType: byType.reduce((acc, item) => {
          acc[item.type] = parseInt(item.dataValues.count);
          return acc;
        }, {}),
        byPriority: byPriority.reduce((acc, item) => {
          acc[item.priority] = parseInt(item.dataValues.count);
          return acc;
        }, {})
      }
    });
  } catch (error) {
    console.error('获取反馈统计失败:', error);
    res.status(500).json({
      success: false,
      message: '获取反馈统计失败'
    });
  }
});

// 管理员回复反馈
router.put('/admin/:id/reply', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { adminReply, status } = req.body;

    if (!adminReply) {
      return res.status(400).json({
        success: false,
        message: '回复内容不能为空'
      });
    }

    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: '反馈不存在'
      });
    }

    await feedback.update({
      adminReply: adminReply.trim(),
      adminId: req.user.id,
      repliedAt: new Date(),
      status: status || 'processing'
    });

    // 获取更新后的完整信息
    const updatedFeedback = await Feedback.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: [...User.PUBLIC_ATTRIBUTES]
        },
        {
          model: User,
          as: 'admin',
          attributes: [...User.REFERENCE_ATTRIBUTES]
        }
      ]
    });

    res.json({
      success: true,
      message: '回复成功',
      data: updatedFeedback
    });
  } catch (error) {
    console.error('回复反馈失败:', error);
    res.status(500).json({
      success: false,
      message: '回复反馈失败'
    });
  }
});

// 管理员更新反馈状态
router.put('/admin/:id/status', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const { status } = req.body;

    if (!['pending', 'processing', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: '无效的状态值'
      });
    }

    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: '反馈不存在'
      });
    }

    await feedback.update({ status });

    res.json({
      success: true,
      message: '状态更新成功'
    });
  } catch (error) {
    console.error('更新反馈状态失败:', error);
    res.status(500).json({
      success: false,
      message: '更新反馈状态失败'
    });
  }
});

// 管理员删除反馈
router.delete('/admin/:id', [authMiddleware, adminMiddleware], async (req, res) => {
  try {
    const feedback = await Feedback.findByPk(req.params.id);
    if (!feedback) {
      return res.status(404).json({
        success: false,
        message: '反馈不存在'
      });
    }

    await feedback.destroy();

    res.json({
      success: true,
      message: '反馈删除成功'
    });
  } catch (error) {
    console.error('删除反馈失败:', error);
    res.status(500).json({
      success: false,
      message: '删除反馈失败'
    });
  }
});

module.exports = router;