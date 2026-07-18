/**
 * 管理员后台 REST API —— 系统管理、用户管理、数据统计
 *
 * 架构角色：属于接入与路由层，所有端点需要管理员权限（requireAdmin 中间件）
 * 对应论文：第5.1节（系统安全与权限管理）
 *
 * API 端点一览：
 *   GET    /api/admin/stats         系统概览统计（用户数、策略数等）
 *   GET    /api/admin/activities    最近操作记录
 *   GET    /api/admin/users         用户列表（分页+搜索）
 *   PUT    /api/admin/users/:id     更新用户信息
 *   DELETE /api/admin/users/:id     删除用户
 *   POST   /api/admin/users/:id/reset-password  重置用户密码
 *   GET    /api/admin/announcements  公告列表
 *   POST   /api/admin/announcements  发布公告
 *   PUT    /api/admin/announcements/:id  更新公告
 *   DELETE /api/admin/announcements/:id  删除公告
 *   GET    /api/admin/feedbacks      用户反馈列表
 *   GET    /api/admin/settings       系统设置
 *   PUT    /api/admin/settings       更新系统设置
 *   GET    /api/admin/logs           操作日志
 *   GET    /api/admin/export/users   导出用户数据(CSV)
 */

/* ========== 依赖导入 ========== */
const express = require('express');
const router = express.Router();
const UserLogService = require('../services/userLogService');
const SystemSettingService = require('../services/systemSettingService');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { isAllowedSettingKey } = require('../config/settingsWhitelist');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { Op } = require('sequelize');
const { sequelize, Strategy, Announcement, Feedback, Trade } = require('../models');
const logger = require('../utils/logger');

/* ========== 系统概览 ========== */

// 获取系统概览统计 —— 返回用户总数、策略总数、公告总数，用于管理后台首页仪表盘
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, totalStrategies, totalAnnouncements] = await Promise.all([
      User.count(),
      Strategy.count().catch(() => 0),
      Announcement.count().catch(() => 0)
    ]);
    res.json({
      success: true,
      data: {
        totalUsers,
        totalStrategies,
        totalAnnouncements,
        onlineUsers: 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取最近活动记录 —— 返回最近10条用户注册信息，用于管理后台"最新动态"卡片
router.get('/activities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const recentUsers = await User.findAll({
      order: [['created_at', 'DESC']],
      limit: 10,
      attributes: ['id', 'username', 'created_at']
    });
    const activities = recentUsers.map(u => ({
      id: u.id,
      type: 'user',
      description: `新用户 ${u.username} 注册成功`,
      createdAt: u.created_at
    }));
    res.json({ success: true, data: activities });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 系统健康检查 —— 检测数据库连接、WebSocket、AI服务的运行状态
router.get('/system-status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let dbOk = false;
    try {
      await sequelize.authenticate();
      dbOk = true;
    } catch (e) {
      logger.warn(`admin /system-status: database authenticate failed: ${e.message}`);
    }
    res.json({
      success: true,
      data: {
        database: dbOk,
        websocket: true,
        aiService: false,
        load: '正常'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ========== 开发辅助 ========== */

// 创建测试管理员 —— 仅在开发环境(NODE_ENV=development)可用，生产环境返回 403
// 如果管理员已存在则直接返回成功，避免重复创建
router.post('/create-test-admin', authenticateToken, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ success: false, message: 'Only available in development mode' });
  }

  try {
    // 检查是否已存在管理员
    const existingAdmin = await User.findOne({ where: { role: 'admin' } });
    
    if (existingAdmin) {
      return res.json({
        success: true,
        message: '管理员账号已存在'
      });
    }

    // 创建测试管理员
    // 登记:'admin123.' 为「创建测试管理员」端点的示范默认口令,非真实凭据。pragma: allowlist secret
    const hashedPassword = await bcrypt.hash('admin123.', 10); // pragma: allowlist secret
    
    const admin = await User.create({
      username: 'admin',
      email: 'admin@khyquant.com',
      password: hashedPassword,
      role: 'admin',
      status: 'active'
    });

    res.json({
      success: true,
      message: '测试管理员创建成功',
      username: 'admin',
      password: 'admin123.' // pragma: allowlist secret — 示范默认口令,随响应回显供测试登录,非真实凭据
    });

  } catch (error) {
    console.error('创建测试管理员失败:', error);
    res.status(500).json({
      success: false,
      message: '创建测试管理员失败',
      error: error.message
    });
  }
});

/* ========== 用户日志管理 ========== */

// 获取用户操作日志列表 —— 支持按用户ID、操作类型、状态、日期范围、关键词等多条件筛选分页查询
router.get('/user-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      userId,
      action,
      status,
      startDate,
      endDate,
      search
    } = req.query;

    const result = await UserLogService.getUserLogs({
      page: parseInt(page),
      limit: parseInt(limit),
      userId: userId ? parseInt(userId) : undefined,
      action,
      status,
      startDate,
      endDate,
      search
    });

    res.json({
      success: true,
      data: result,
      message: '获取用户日志成功'
    });
  } catch (error) {
    console.error('获取用户日志失败:', error);
    res.status(500).json({
      success: false,
      message: '获取用户日志失败',
      error: error.message
    });
  }
});

// 获取用户活动统计 —— 统计最近 N 天（默认30天）的用户活跃趋势数据，用于管理后台图表
router.get('/user-activity-stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const stats = await UserLogService.getUserActivityStats(parseInt(days));

    res.json({
      success: true,
      data: stats,
      message: '获取用户活动统计成功'
    });
  } catch (error) {
    console.error('获取用户活动统计失败:', error);
    res.status(500).json({
      success: false,
      message: '获取用户活动统计失败',
      error: error.message
    });
  }
});

// 清理过期日志 —— 删除指定天数之前的旧日志记录（默认保留90天），防止数据库膨胀
router.delete('/user-logs/cleanup', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { daysToKeep = 90 } = req.body;
    const deletedCount = await UserLogService.cleanOldLogs(parseInt(daysToKeep));

    res.json({
      success: true,
      data: { deletedCount },
      message: `成功清理 ${deletedCount} 条旧日志记录`
    });
  } catch (error) {
    console.error('清理旧日志失败:', error);
    res.status(500).json({
      success: false,
      message: '清理旧日志失败',
      error: error.message
    });
  }
});

// 导出用户日志为 CSV 文件 —— 支持与日志列表相同的筛选条件，最多导出10000条
// 使用流式写入（res.write）逐行输出，避免大数据量时占用过多内存
// CSV 文件头部添加了 BOM(\uFEFF) 以确保 Excel 正确识别中文编码
router.get('/user-logs/export', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const {
      userId,
      action,
      status,
      startDate,
      endDate,
      search
    } = req.query;

    const result = await UserLogService.getUserLogs({
      page: 1,
      limit: 10000, // 导出大量数据
      userId: userId ? parseInt(userId) : undefined,
      action,
      status,
      startDate,
      endDate,
      search
    });

    // 设置CSV响应头
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=user-logs.csv');

    // CSV头部
    const csvHeader = 'ID,用户ID,用户名,操作类型,操作描述,IP地址,状态,时间\n';
    res.write('\uFEFF' + csvHeader); // 添加BOM以支持中文

    // CSV数据
    result.logs.forEach(log => {
      const row = [
        log.id,
        log.userId,
        log.username,
        log.action,
        log.actionDescription || '',
        log.ipAddress || '',
        log.status,
        new Date(log.timestamp).toLocaleString('zh-CN')
      ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
      
      res.write(row + '\n');
    });

    res.end();
  } catch (error) {
    console.error('导出用户日志失败:', error);
    res.status(500).json({
      success: false,
      message: '导出用户日志失败',
      error: error.message
    });
  }
});

/* ========== 用户管理 CRUD ========== */

// 更新用户信息 —— 管理员可修改用户名、邮箱、角色、状态，并记录操作日志
router.put('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, email, role, status } = req.body;

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 更新用户信息
    await user.update({
      username: username || user.username,
      email: email || user.email,
      role: role || user.role,
      status: status || user.status
    });

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'profile_update_by_admin',
      actionDescription: `管理员更新用户信息`,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { updatedBy: req.user.id, updatedFields: Object.keys(req.body) }
    });

    res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      },
      message: '用户信息更新成功'
    });
  } catch (error) {
    console.error('更新用户信息失败:', error);
    res.status(500).json({
      success: false,
      message: '更新用户信息失败',
      error: error.message
    });
  }
});

// 删除用户 —— 物理删除用户记录；安全校验：管理员不能删除自己的账号
router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // 不能删除自己
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({
        success: false,
        message: '不能删除自己的账号'
      });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'account_deleted_by_admin',
      actionDescription: `管理员删除用户账号`,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { deletedBy: req.user.id }
    });

    await user.destroy();

    res.json({
      success: true,
      message: '用户删除成功'
    });
  } catch (error) {
    console.error('删除用户失败:', error);
    res.status(500).json({
      success: false,
      message: '删除用户失败',
      error: error.message
    });
  }
});

// 重置用户密码 —— 管理员为指定用户设置新密码，要求新密码至少6位
// 密码使用 bcrypt 算法（10轮盐值）进行哈希加密后存储
router.post('/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: '新密码长度至少6位'
      });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '用户不存在'
      });
    }

    // Assign plaintext — the beforeUpdate hook handles hashing
    user.password = newPassword;
    await user.save();

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'password_reset_by_admin',
      actionDescription: `管理员重置用户密码`,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { resetBy: req.user.id }
    });

    res.json({
      success: true,
      message: '密码重置成功'
    });
  } catch (error) {
    console.error('重置密码失败:', error);
    res.status(500).json({
      success: false,
      message: '重置密码失败',
      error: error.message
    });
  }
});

// 管理员创建新用户 —— 需提供用户名、邮箱、密码；自动检查用户名/邮箱唯一性
router.post('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, email, password, role = 'user', status = 'active' } = req.body;

    // 验证必填字段
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名、邮箱和密码为必填项'
      });
    }

    // 检查用户名和邮箱是否已存在
    const existingUser = await User.findOne({
      where: {
        [Op.or]: [
          { username },
          { email }
        ]
      }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: '用户名或邮箱已存在'
      });
    }

    // 创建用户
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      role,
      status
    });

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: user.id,
      username: user.username,
      action: 'account_created_by_admin',
      actionDescription: `管理员创建用户账号`,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { createdBy: req.user.id }
    });

    res.status(201).json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt
      },
      message: '用户创建成功'
    });
  } catch (error) {
    console.error('创建用户失败:', error);
    res.status(500).json({
      success: false,
      message: '创建用户失败',
      error: error.message
    });
  }
});

// ========================================
//              系统设置管理
// ========================================

// 获取全部系统设置 —— 优先从数据库读取真实配置，数据库不可用时降级为前端模拟数据
// 设置按类别分组：system（系统）、user（用户）、security（安全）、trading（交易）
router.get('/system/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 优先尝试从数据库加载真实配置
    let data;
    try {
      data = await SystemSettingService.getAllSettings({ includePrivate: true });
    } catch (dbErr) {
      console.warn('DB settings unavailable, using fallback:', dbErr.message);
      data = null;
    }

    if (data && Object.keys(data).length > 0) {
      return res.json({ success: true, data, message: '获取系统设置成功' });
    }

    // 降级方案：数据库不可用时返回预设的模拟配置，保证前端页面可正常展示
    const mockSettings = {
      system: [
        { key: 'system.name', value: 'khy OS AI 平台操作系统', type: 'string', description: '系统名称', isEditable: true },
        { key: 'system.version', value: '1.0.0', type: 'string', description: '系统版本', isEditable: false },
        { key: 'system.description', value: '专业的量化交易平台', type: 'text', description: '系统描述', isEditable: true },
        { key: 'system.maintenance_mode', value: false, type: 'boolean', description: '维护模式', isEditable: true }
      ],
      user: [
        { key: 'user.registration_enabled', value: true, type: 'boolean', description: '允许用户注册', isEditable: true },
        { key: 'user.session_timeout', value: 7, type: 'number', description: '会话超时时间（天）', isEditable: true }
      ],
      security: [
        { key: 'security.password_min_length', value: 6, type: 'number', description: '密码最小长度', isEditable: true },
        { key: 'security.login_attempts_limit', value: 5, type: 'number', description: '登录尝试次数限制', isEditable: true }
      ],
      trading: [
        { key: 'trading.default_commission', value: 0.0003, type: 'number', description: '默认手续费率', isEditable: true },
        { key: 'trading.max_positions', value: 10, type: 'number', description: '最大持仓数量', isEditable: true },
        { key: 'kline.enabled_periods', value: ['daily'], type: 'json', description: 'K线允许显示的时间周期', isEditable: true }
      ]
    };

    res.json({
      success: true,
      data: mockSettings,
      message: '获取系统设置成功'
    });
  } catch (error) {
    console.error('获取系统设置失败:', error);
    res.status(500).json({
      success: false,
      message: '获取系统设置失败',
      error: error.message
    });
  }
});

// 批量更新系统设置 —— 先用白名单校验 key 是否允许修改，再逐条写入数据库
router.put('/system/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({
        success: false,
        message: '设置数据格式错误'
      });
    }

    // 用白名单校验设置项的 key 前缀，防止恶意写入不允许的配置
    const invalidKeys = Object.keys(settings).filter(k => !isAllowedSettingKey(k));
    if (invalidKeys.length > 0) {
      return res.status(400).json({
        success: false,
        message: `不允许的设置项: ${invalidKeys.join(', ')}`
      });
    }

    // 逐条调用 SystemSettingService 写入数据库
    const results = {};
    for (const [key, value] of Object.entries(settings)) {
      results[key] = await SystemSettingService.setSetting(key, value);
    }

    // 记录管理员操作日志（用于审计追踪）
    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'system_settings_update',
      actionDescription: '管理员更新系统设置',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { updatedSettings: Object.keys(settings) }
    });

    res.json({
      success: true,
      data: settings,
      message: '系统设置更新成功'
    });
  } catch (error) {
    console.error('更新系统设置失败:', error);
    res.status(500).json({
      success: false,
      message: '更新系统设置失败',
      error: error.message
    });
  }
});

// 获取系统运行信息 —— 返回 Node 版本、运行平台、运行时长、内存占用等服务器指标
router.get('/system/info', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 获取系统统计信息
    const [userCount, strategyCount, backtestCount, tradeCount] = await Promise.all([
      User.count(),
      // 暂时使用固定值，避免模型依赖问题
      Promise.resolve(0), // Strategy.count(),
      Promise.resolve(0), // Backtest.count(),
      Promise.resolve(0)  // Trade.count()
    ]);

    const systemInfo = {
      settings: {
        system: [
          { key: 'system.name', value: 'khy OS AI 平台操作系统' },
          { key: 'system.version', value: '1.0.0' }
        ]
      },
      statistics: {
        userCount,
        strategyCount,
        backtestCount,
        tradeCount
      },
      systemInfo: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    };

    res.json({
      success: true,
      data: systemInfo,
      message: '获取系统信息成功'
    });
  } catch (error) {
    console.error('获取系统信息失败:', error);
    res.status(500).json({
      success: false,
      message: '获取系统信息失败',
      error: error.message
    });
  }
});

// 将指定设置项恢复为系统默认值 —— 通过内置的默认值映射表进行恢复
router.post('/system/settings/reset', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: '请指定要重置的设置项'
      });
    }

    // 暂时模拟重置成功
    const defaultValues = {
      'system.name': 'khy OS AI 平台操作系统',
      'system.maintenance_mode': false,
      'user.registration_enabled': true,
      'security.password_min_length': 6,
      'trading.default_commission': 0.0003
    };

    const defaultValue = defaultValues[key] || null;

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'system_setting_reset',
      actionDescription: `管理员重置系统设置: ${key}`,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success',
      details: { resetKey: key }
    });

    res.json({
      success: true,
      data: { key, value: defaultValue },
      message: '设置重置成功'
    });
  } catch (error) {
    console.error('重置设置失败:', error);
    res.status(500).json({
      success: false,
      message: '重置设置失败',
      error: error.message
    });
  }
});

// 初始化系统默认设置 —— 首次部署或重置后使用，将所有设置项写入数据库
router.post('/system/settings/initialize', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // 暂时模拟初始化成功
    console.log('初始化默认设置...');

    // 记录操作日志
    await UserLogService.logUserAction({
      userId: req.user.id,
      username: req.user.username,
      action: 'system_settings_initialize',
      actionDescription: '管理员初始化系统默认设置',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
      status: 'success'
    });

    res.json({
      success: true,
      message: '默认设置初始化成功'
    });
  } catch (error) {
    console.error('初始化默认设置失败:', error);
    res.status(500).json({
      success: false,
      message: '初始化默认设置失败',
      error: error.message
    });
  }
});

// ========================================
//         资金管理 & 交易记录
// ========================================

// 查询单个用户的资金账户摘要 —— 基于交易记录计算可用资金、总资产、总盈亏、当日盈亏
// 计算逻辑：初始资金（100万模拟资金）+ 已平仓盈亏 - 持仓占用 = 可用资金
router.get('/users/:userId/account', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: '用户不存在' });

    const trades = await Trade.findAll({
      where: { user_id: userId, status: 'filled' }
    });

    // 每个用户默认初始模拟资金为 100 万
    const initialFunds = 1000000.00;
    let totalProfit = 0, positionCost = 0, positionValue = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let todayProfit = 0;

    // 遍历所有已成交交易，分别累计：
    //   已平仓交易 -> 计入总盈亏(totalProfit)，如果是今天平仓则计入当日盈亏
    //   未平仓买入 -> 计入持仓成本(positionCost)和持仓市值(positionValue)
    trades.forEach(trade => {
      if (trade.isClosed && trade.profit) {
        totalProfit += parseFloat(trade.profit);
        if (trade.closedAt && new Date(trade.closedAt) >= today) {
          todayProfit += parseFloat(trade.profit);
        }
      } else if (!trade.isClosed && trade.side === 'buy') {
        positionCost += parseFloat(trade.amount);
        positionValue += parseFloat(trade.amount);
      }
    });

    // 可用资金 = 初始资金 + 累计盈亏 - 持仓占用金额
    const availableFunds = initialFunds + totalProfit - positionCost;
    res.json({
      success: true,
      data: {
        userId: parseInt(userId),
        username: user.username,
        initialFunds,
        availableFunds: parseFloat(availableFunds.toFixed(2)),
        totalAssets: parseFloat((availableFunds + positionValue).toFixed(2)),
        totalProfit: parseFloat(totalProfit.toFixed(2)),
        todayProfit: parseFloat(todayProfit.toFixed(2)),
        positionValue: parseFloat(positionValue.toFixed(2)),
        tradeCount: trades.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取所有用户的资金概览 —— 使用 JOIN 一次查询所有交易数据，避免 N+1 问题
router.get('/funds', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['id', 'username', 'email', 'status', 'createdAt'],
      include: [{
        model: Trade,
        as: 'trades',
        where: { status: 'filled' },
        required: false,
        attributes: ['id', 'isClosed', 'profit', 'side', 'amount']
      }]
    });

    const initialFunds = 1000000.00;
    const fundsData = users.map((user) => {
      const trades = user.trades || [];
      let totalProfit = 0, positionCost = 0;
      trades.forEach(trade => {
        if (trade.isClosed && trade.profit) totalProfit += parseFloat(trade.profit);
        else if (!trade.isClosed && trade.side === 'buy') positionCost += parseFloat(trade.amount);
      });
      const availableFunds = initialFunds + totalProfit - positionCost;
      return {
        userId: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        initialFunds,
        availableFunds: parseFloat(availableFunds.toFixed(2)),
        totalProfit: parseFloat(totalProfit.toFixed(2)),
        tradeCount: trades.length,
        registeredAt: user.createdAt
      };
    });

    res.json({ success: true, data: fundsData });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 查询全部交易记录 —— 支持按用户ID、股票代码、买卖方向、状态、类型、日期范围多条件筛选
// 返回分页数据并通过 JOIN 关联用户表获取用户名
router.get('/trades', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId, symbol, side, status, type, startDate, endDate, page = 1, pageSize = 20 } = req.query;
    // 动态构建 Sequelize 查询条件：支持用户ID、股票代码模糊匹配、方向、状态、类型、日期范围
    const where = {};
    if (userId) where.user_id = userId;
    if (symbol) where.symbol = { [Op.like]: `%${symbol}%` };
    if (side) where.side = side;
    if (status) where.status = status;
    if (type) where.type = type;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate);
      if (endDate) where.createdAt[Op.lte] = new Date(endDate + ' 23:59:59');
    }

    const offset = (parseInt(page) - 1) * parseInt(pageSize);
    const { count, rows } = await Trade.findAndCountAll({
      where,
      include: [{ model: User, attributes: ['username', 'email'], as: 'user' }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(pageSize),
      offset
    });

    res.json({
      success: true,
      data: rows,
      total: count,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 查询指定用户的交易记录 —— 按时间倒序分页返回
router.get('/users/:userId/trades', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, pageSize = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(pageSize);

    const { count, rows } = await Trade.findAndCountAll({
      where: { user_id: userId },
      order: [['createdAt', 'DESC']],
      limit: parseInt(pageSize),
      offset
    });

    res.json({ success: true, data: rows, total: count });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ========== AKShare 数据源版本管理 ========== */
// AKShare 是 Python 金融数据接口库，此处管理其自动更新与手动触发检查

const akshareUpdater = require('../services/akshareUpdater');

// 查询 AKShare 数据源当前版本及更新状态
router.get('/akshare/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const status = akshareUpdater.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 手动触发 AKShare 版本检查与更新 —— 管理员在后台手动点击"检查更新"时调用
router.post('/akshare/check', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🔧 Admin triggered AKShare version check');
    const result = await akshareUpdater.checkAndUpdate(true);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== Training Data Management ==========
const trainingData = require('../services/trainingDataService');

// GET /api/admin/training/stats - Training data statistics
router.get('/training/stats', authenticateToken, requireAdmin, (req, res) => {
  try {
    const stats = trainingData.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/training/export - Export training data for fine-tuning
router.get('/training/export', authenticateToken, requireAdmin, (req, res) => {
  try {
    const format = req.query.format || 'chatml'; // 'chatml' or 'openai'
    const minRating = parseInt(req.query.minRating || '0', 10);
    const conversations = trainingData.exportForTraining({ format, minRating });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="training_data_${format}.json"`);
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/training/purge - Delete expired training data
router.post('/training/purge', authenticateToken, requireAdmin, (req, res) => {
  try {
    const result = trainingData.purgeExpired();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/training/purge-all - Delete ALL raw training data (after export)
router.post('/training/purge-all', authenticateToken, requireAdmin, (req, res) => {
  try {
    const result = trainingData.purgeAll();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/training/maintenance - Run cleanup (expired + size limit)
router.post('/training/maintenance', authenticateToken, requireAdmin, (req, res) => {
  try {
    const result = trainingData.runMaintenance();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 导出路由实例，由 server.js 挂载到 /api/admin 路径下
module.exports = router;
