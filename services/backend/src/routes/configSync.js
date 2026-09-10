'use strict';

/**
 * configSync.js — 四端配置同步 REST API + SSE。
 *
 * 端点:
 *   GET    /api/config-sync              — 获取当前用户所有配置
 *   GET    /api/config-sync/:key         — 获取单个配置
 *   PUT    /api/config-sync/:key         — 设置配置
 *   DELETE /api/config-sync/:key         — 删除配置
 *   POST   /api/config-sync/bulk         — 批量同步(设备间拉齐)
 *   GET    /api/config-sync/stream       — SSE 实时推送配置变更
 *
 * 所有端点需认证(authMiddleware)。
 * 后端不可用时, 客户端自动降级读本地文件。
 */

const express = require('express');
const router = express.Router();

const apiResponse = require('../utils/apiResponse');
const { authMiddleware } = require('../middleware/auth');
const configSync = require('../services/configSyncService');

// 所有端点需登录
router.use(authMiddleware);

// 门控: KHY_CONFIG_SYNC=0 时返回 503, 客户端降级本地
router.use((req, res, next) => {
  if (!configSync.isEnabled(process.env)) {
    return apiResponse.fail(res, 'SYNC_DISABLED', '配置同步已关闭, 请使用本地配置', { status: 503 });
  }
  next();
});

/**
 * GET /api/config-sync — 获取当前用户所有配置
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
    }
    const settings = await configSync.getAllSettings(userId);
    apiResponse.success(res, { settings, syncedAt: Date.now() });
  } catch (err) {
    apiResponse.fail(res, 'INTERNAL', err.message, { status: 500 });
  }
});

/**
 * GET /api/config-sync/:key — 获取单个配置
 */
router.get('/:key', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
    }
    const key = req.params.key;
    const result = await configSync.getSetting(userId, key);
    apiResponse.success(res, {
      key,
      value: result.value,
      updatedAt: result.updatedAt,
      fromCloud: result.fromCloud,
    });
  } catch (err) {
    apiResponse.fail(res, 'INTERNAL', err.message, { status: 500 });
  }
});

/**
 * PUT /api/config-sync/:key — 设置配置
 */
router.put('/:key', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
    }
    const key = req.params.key;
    const value = req.body?.value;
    const deviceId = req.body?.deviceId || req.headers['x-device-id'] || null;

    if (value === undefined) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', 'value is required', { status: 400 });
    }

    const result = await configSync.setSetting(userId, key, value, { deviceId });

    // 广播变更给其他连接
    configSync.notifyChange(userId, key, value);

    apiResponse.success(res, { key, fromCloud: result.fromCloud });
  } catch (err) {
    apiResponse.fail(res, 'INTERNAL', err.message, { status: 500 });
  }
});

/**
 * DELETE /api/config-sync/:key — 删除配置
 */
router.delete('/:key', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
    }
    const key = req.params.key;
    await configSync.deleteSetting(userId, key);

    // 广播删除
    configSync.notifyChange(userId, key, null);

    apiResponse.success(res, { key, deleted: true });
  } catch (err) {
    apiResponse.fail(res, 'INTERNAL', err.message, { status: 500 });
  }
});

/**
 * POST /api/config-sync/bulk — 批量同步
 * Body: { settings: { key: value, ... }, deviceId?: string }
 */
router.post('/bulk', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
    }
    const settings = req.body?.settings || {};
    const deviceId = req.body?.deviceId || req.headers['x-device-id'] || null;

    const result = await configSync.syncSettings(userId, settings, deviceId);

    // 广播所有变更
    for (const key of Object.keys(settings)) {
      configSync.notifyChange(userId, key, settings[key]);
    }

    apiResponse.success(res, {
      upserted: result.upserted,
      conflicts: result.conflicts,
    });
  } catch (err) {
    apiResponse.fail(res, 'INTERNAL', err.message, { status: 500 });
  }
});

/**
 * GET /api/config-sync/stream — SSE 实时推送配置变更
 */
router.get('/stream', (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return apiResponse.fail(res, 'AUTH_INVALID', '未认证', { status: 401 });
  }

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 注册监听
  configSync.addListener(userId, res);

  // 心跳保活
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      cleanup();
    }
  }, 30000);

  // 客户端断开清理
  const cleanup = () => {
    clearInterval(heartbeat);
    configSync.removeListener(userId, res);
  };

  req.on('close', cleanup);
});

module.exports = router;
