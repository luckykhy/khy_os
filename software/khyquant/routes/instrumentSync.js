const express = require('express');
const router = express.Router();
const instrumentSyncService = require('../services/instrumentSyncService');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

/**
 * 获取同步状态
 * GET /api/instrument-sync/status
 */
router.get('/status', authMiddleware, (req, res) => {
  try {
    const status = instrumentSyncService.getStatus();
    
    res.json({
      success: true,
      data: {
        ...status,
        syncIntervalMinutes: status.syncInterval / 1000 / 60,
        lastSyncTimeFormatted: status.lastSyncTime 
          ? status.lastSyncTime.toLocaleString('zh-CN')
          : '尚未同步',
        nextSyncTimeFormatted: status.nextSyncTime
          ? status.nextSyncTime.toLocaleString('zh-CN')
          : '未知'
      }
    });
  } catch (error) {
    console.error('获取同步状态失败:', error);
    res.status(500).json({
      success: false,
      message: '获取同步状态失败',
      error: error.message
    });
  }
});

/**
 * 手动触发同步
 * POST /api/instrument-sync/trigger
 * 需要管理员权限
 */
router.post('/trigger', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    console.log(`🔄 管理员 ${req.user.username} 手动触发标的同步`);
    
    // 异步执行同步,不阻塞响应
    instrumentSyncService.triggerSync().catch(error => {
      console.error('手动同步失败:', error);
    });
    
    res.json({
      success: true,
      message: '同步任务已触发,正在后台执行'
    });
  } catch (error) {
    console.error('触发同步失败:', error);
    res.status(500).json({
      success: false,
      message: '触发同步失败',
      error: error.message
    });
  }
});

/**
 * 启动同步服务
 * POST /api/instrument-sync/start
 * 需要管理员权限
 */
router.post('/start', authMiddleware, adminMiddleware, (req, res) => {
  try {
    instrumentSyncService.start();
    
    res.json({
      success: true,
      message: '同步服务已启动'
    });
  } catch (error) {
    console.error('启动同步服务失败:', error);
    res.status(500).json({
      success: false,
      message: '启动同步服务失败',
      error: error.message
    });
  }
});

/**
 * 停止同步服务
 * POST /api/instrument-sync/stop
 * 需要管理员权限
 */
router.post('/stop', authMiddleware, adminMiddleware, (req, res) => {
  try {
    instrumentSyncService.stop();
    
    res.json({
      success: true,
      message: '同步服务已停止'
    });
  } catch (error) {
    console.error('停止同步服务失败:', error);
    res.status(500).json({
      success: false,
      message: '停止同步服务失败',
      error: error.message
    });
  }
});

module.exports = router;
