const express = require('express');
const router = express.Router();
const { Announcement, AnnouncementRead, User } = require('../models');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { Op } = require('sequelize');
const notificationService = require('../services/notificationService');

// 管理员创建公告
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {
      title,
      content,
      type = 'info',
      priority = 'normal',
      publishAt,
      expireAt,
      isSticky = false,
      isPopup = false,
      targetUsers = []
    } = req.body;

    if (!title || !content) {
      return res.status(400).json({
        success: false,
        message: '标题和内容不能为空'
      });
    }

    const announcement = await Announcement.create({
      title,
      content,
      type,
      priority,
      status: 'published',
      publishAt: publishAt || new Date(),
      expireAt,
      isSticky,
      isPopup,
      targetUsers,
      author_id: req.user.id,
      metadata: {
        createdBy: req.user.username,
        createdAt: new Date().toISOString()
      }
    });

    // 获取完整的公告信息（包含作者信息）
    const fullAnnouncement = await Announcement.findByPk(announcement.id, {
      include: [
        {
          model: User,
          as: 'author',
          attributes: [...User.PUBLIC_ATTRIBUTES]
        }
      ]
    });

    // 实时广播新公告通知
    try {
      const broadcastCount = notificationService.broadcastAnnouncement(fullAnnouncement);
      console.log(`📢 新公告已广播给 ${broadcastCount} 个用户: "${title}"`);
    } catch (broadcastError) {
      console.error('广播公告通知失败:', broadcastError);
    }

    res.json({
      success: true,
      message: '公告发布成功',
      data: fullAnnouncement
    });

  } catch (error) {
    console.error('创建公告错误:', error);
    res.status(500).json({
      success: false,
      message: '创建公告失败',
      error: error.message
    });
  }
});

// 管理员获取所有公告（包括草稿）
router.get('/admin', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, status, type, priority } = req.query;
    const offset = (page - 1) * pageSize;

    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (priority) where.priority = priority;

    const announcements = await Announcement.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: 'author',
          attributes: [...User.PUBLIC_ATTRIBUTES]
        }
      ],
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['isSticky', 'DESC'], ['publishAt', 'DESC']]
    });

    // 获取每个公告的阅读统计（单次分组聚合，避免 N+1 查询 —— [MGMT-RPT-020] REQ-2026-007）
    const announcementIds = announcements.rows.map((a) => a.id);
    if (announcementIds.length > 0) {
      const readCounts = await AnnouncementRead.findAll({
        attributes: [
          'announcement_id',
          [Announcement.sequelize.fn('COUNT', Announcement.sequelize.col('id')), 'count'],
        ],
        where: { announcement_id: { [Op.in]: announcementIds } },
        group: ['announcement_id'],
        raw: true,
      });
      const countById = new Map(
        readCounts.map((r) => [String(r.announcement_id), Number(r.count) || 0]),
      );
      for (const announcement of announcements.rows) {
        announcement.dataValues.actualReadCount = countById.get(String(announcement.id)) || 0;
      }
    }

    res.json({
      success: true,
      data: {
        list: announcements.rows,
        total: announcements.count,
        page: parseInt(page),
        pageSize: parseInt(pageSize)
      }
    });

  } catch (error) {
    console.error('获取管理员公告列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取公告列表失败',
      error: error.message
    });
  }
});

// 用户获取公告列表
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, pageSize = 10, type, unreadOnly = false } = req.query;
    const offset = (page - 1) * pageSize;

    const where = {
      status: 'published',
      [Op.or]: [
        { publishAt: { [Op.lte]: new Date() } },
        { publishAt: null }
      ],
      [Op.or]: [
        { expireAt: { [Op.gte]: new Date() } },
        { expireAt: null }
      ]
    };

    if (type) where.type = type;

    let include = [
      {
        model: User,
        as: 'author',
        attributes: [...User.REFERENCE_ATTRIBUTES]
      }
    ];

    // 如果只要未读的，添加条件
    if (unreadOnly === 'true') {
      include.push({
        model: AnnouncementRead,
        as: 'reads',
        where: { user_id: req.user.id },
        required: false
      });
      
      // 在查询后过滤未读的
    }

    const announcements = await Announcement.findAndCountAll({
      where,
      include,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['isSticky', 'DESC'], ['publishAt', 'DESC']]
    });

    // 标记用户的阅读状态
    const userReads = await AnnouncementRead.findAll({
      where: {
        user_id: req.user.id,
        announcement_id: announcements.rows.map(a => a.id)
      }
    });

    const readMap = {};
    userReads.forEach(read => {
      readMap[read.announcement_id] = read;
    });

    const result = announcements.rows.map(announcement => {
      const read = readMap[announcement.id];
      return {
        ...announcement.toJSON(),
        isRead: !!read,
        readAt: read?.readAt,
        isLiked: read?.isLiked || false
      };
    });

    // 如果只要未读的，过滤结果
    const finalResult = unreadOnly === 'true' 
      ? result.filter(item => !item.isRead)
      : result;

    res.json({
      success: true,
      data: {
        list: finalResult,
        total: unreadOnly === 'true' ? finalResult.length : announcements.count,
        page: parseInt(page),
        pageSize: parseInt(pageSize),
        unreadCount: result.filter(item => !item.isRead).length
      }
    });

  } catch (error) {
    console.error('获取公告列表错误:', error);
    res.status(500).json({
      success: false,
      message: '获取公告列表失败',
      error: error.message
    });
  }
});

// 获取单个公告详情
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await Announcement.findByPk(id, {
      include: [
        {
          model: User,
          as: 'author',
          attributes: [...User.PUBLIC_ATTRIBUTES]
        }
      ]
    });

    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: '公告不存在'
      });
    }

    // 检查用户是否有权限查看
    if (announcement.status !== 'published' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: '无权限查看此公告'
      });
    }

    // 检查是否已读
    const read = await AnnouncementRead.findOne({
      where: {
        user_id: req.user.id,
        announcement_id: id
      }
    });

    // 如果未读，标记为已读
    if (!read) {
      await AnnouncementRead.create({
        user_id: req.user.id,
        announcement_id: id
      });

      // 更新阅读计数
      await announcement.increment('readCount');
    }

    res.json({
      success: true,
      data: {
        ...announcement.toJSON(),
        isRead: !!read,
        readAt: read?.readAt,
        isLiked: read?.isLiked || false
      }
    });

  } catch (error) {
    console.error('获取公告详情错误:', error);
    res.status(500).json({
      success: false,
      message: '获取公告详情失败',
      error: error.message
    });
  }
});

// 用户点赞/取消点赞公告
router.post('/:id/like', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: '公告不存在'
      });
    }

    const [read, created] = await AnnouncementRead.findOrCreate({
      where: {
        user_id: req.user.id,
        announcement_id: id
      },
      defaults: {
        isLiked: true
      }
    });

    if (!created) {
      // 切换点赞状态
      read.isLiked = !read.isLiked;
      await read.save();
    }

    res.json({
      success: true,
      message: read.isLiked ? '点赞成功' : '取消点赞',
      data: {
        isLiked: read.isLiked
      }
    });

  } catch (error) {
    console.error('点赞公告错误:', error);
    res.status(500).json({
      success: false,
      message: '操作失败',
      error: error.message
    });
  }
});

// 管理员更新公告
router.put('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: '公告不存在'
      });
    }

    await announcement.update({
      ...updateData,
      metadata: {
        ...announcement.metadata,
        updatedBy: req.user.username,
        updatedAt: new Date().toISOString()
      }
    });

    res.json({
      success: true,
      message: '公告更新成功',
      data: announcement
    });

  } catch (error) {
    console.error('更新公告错误:', error);
    res.status(500).json({
      success: false,
      message: '更新公告失败',
      error: error.message
    });
  }
});

// 管理员删除公告
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    const announcement = await Announcement.findByPk(id);
    if (!announcement) {
      return res.status(404).json({
        success: false,
        message: '公告不存在'
      });
    }

    // 删除相关的阅读记录
    await AnnouncementRead.destroy({
      where: { announcement_id: id }
    });

    // 删除公告
    await announcement.destroy();

    res.json({
      success: true,
      message: '公告删除成功'
    });

  } catch (error) {
    console.error('删除公告错误:', error);
    res.status(500).json({
      success: false,
      message: '删除公告失败',
      error: error.message
    });
  }
});

// 获取公告统计信息（管理员）
router.get('/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalCount = await Announcement.count();
    const publishedCount = await Announcement.count({ where: { status: 'published' } });
    const draftCount = await Announcement.count({ where: { status: 'draft' } });
    const stickyCount = await Announcement.count({ where: { isSticky: true } });

    const typeStats = await Announcement.findAll({
      attributes: [
        'type',
        [Announcement.sequelize.fn('COUNT', Announcement.sequelize.col('id')), 'count']
      ],
      group: ['type']
    });

    const priorityStats = await Announcement.findAll({
      attributes: [
        'priority',
        [Announcement.sequelize.fn('COUNT', Announcement.sequelize.col('id')), 'count']
      ],
      group: ['priority']
    });

    res.json({
      success: true,
      data: {
        total: totalCount,
        published: publishedCount,
        draft: draftCount,
        sticky: stickyCount,
        typeStats: typeStats.map(item => ({
          type: item.type,
          count: parseInt(item.dataValues.count)
        })),
        priorityStats: priorityStats.map(item => ({
          priority: item.priority,
          count: parseInt(item.dataValues.count)
        }))
      }
    });

  } catch (error) {
    console.error('获取公告统计错误:', error);
    res.status(500).json({
      success: false,
      message: '获取统计信息失败',
      error: error.message
    });
  }
});

module.exports = router;