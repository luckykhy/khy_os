/**
 * 系统设置 REST API —— 系统参数的读取与更新
 *
 * 架构角色：属于接入与路由层（对应论文第4.2节）
 *   系统设置采用白名单机制，只允许修改预定义的参数键名，
 *   防止通过API篡改敏感配置。
 *
 * 对应论文：第5.1节（认证与中间件实现）
 */
const express = require('express');
const router = express.Router();
const SystemSettingService = require('../services/systemSettingService');
const { isAllowedSettingKey } = require('../config/settingsWhitelist');

// ---------- 公开设置（无需登录） ----------
// GET /public —— 获取所有标记为公开的系统设置，支持按 category 过滤
router.get('/public', async (req, res) => {
  try {
    const { category } = req.query;
    const settings = await SystemSettingService.getAllSettings({ 
      category, 
      isPublic: true 
    });

    res.json({
      success: true,
      data: settings,
      message: '获取公开设置成功'
    });
  } catch (error) {
    console.error('获取公开设置失败:', error);
    res.status(500).json({
      success: false,
      message: '获取公开设置失败',
      error: error.message
    });
  }
});

// GET /public/:key —— 获取单个公开设置项（仅允许访问标记为 public 的设置）
router.get('/public/:key', async (req, res) => {
  try {
    const { key } = req.params;

    // Direct DB lookup by key + isPublic check
    const { SystemSetting } = require('../models');
    const setting = await SystemSetting.findOne({ where: { key, isPublic: true } });

    if (!setting) {
      // Backward compatibility for old frontend clients.
      // Legacy endpoint: /settings/public/kline.enabled_periods
      if (key === 'kline.enabled_periods') {
        return res.json({
          success: true,
          data: { key, value: ['daily'] },
          message: '获取设置成功(默认值)'
        });
      }
      return res.status(404).json({
        success: false,
        message: '设置项不存在或非公开设置'
      });
    }

    res.json({
      success: true,
      data: { key, value: setting.getParsedValue() },
      message: '获取设置成功'
    });
  } catch (error) {
    console.error('获取设置失败:', error);
    res.status(500).json({
      success: false,
      message: '获取设置失败',
      error: error.message
    });
  }
});

// ---------- 管理员设置更新（需管理员权限） ----------
// PUT /:key —— 更新指定键名的系统设置，白名单校验防止越权修改
const { authenticateToken, requireAdmin } = require('../middleware/auth');

router.put('/:key', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { key } = req.params;
    const { value, type, category, description } = req.body;

    if (value === undefined) {
      return res.status(400).json({ success: false, message: 'Missing value' });
    }

    // Validate key against allowed prefixes
    if (!isAllowedSettingKey(key)) {
      return res.status(400).json({ success: false, message: `Not allowed setting key: ${key}` });
    }

    const { isPublic } = req.body;
    const result = await SystemSettingService.setSetting(key, value, {
      type: type || 'string',
      category: category || 'general',
      description: description || '',
      isPublic: isPublic !== undefined ? !!isPublic : false
    });

    res.json({ success: true, data: { key, value: result }, message: 'Setting updated' });
  } catch (error) {
    console.error('Update setting failed:', error);
    res.status(500).json({ success: false, message: 'Update setting failed', error: error.message });
  }
});

module.exports = router;
