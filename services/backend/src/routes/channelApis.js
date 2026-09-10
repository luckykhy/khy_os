'use strict';

/**
 * channelApis.js — 渠道 API 注册表 REST 路由。
 *
 * 全部端点需登录且需 admin 角色（渠道 Key 是全机共享的凭证，不给普通用户）。
 * 写操作（POST/PUT/DELETE）由 server.js 的全局 auditLog 中间件自动记录；
 * POST /:id/reveal 另外在服务层写一条显式 reveal 审计。
 *
 * 路由顺序注意：/guide 必须在 /:id 之前声明，否则会被 /:id 吞掉。
 */

const express = require('express');

const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const channelApiService = require('../services/channelApiService');
const apiResponse = require('../utils/apiResponse');

const { ChannelApiValidationError } = channelApiService;

const router = express.Router();

router.use(authMiddleware);
router.use(adminMiddleware);

/** 把路径参数转成正整数 id，非法值走 400。 */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ChannelApiValidationError(`id 必须是正整数（收到 ${String(raw)}）`);
  }
  return id;
}

/** 服务层异常 → HTTP 映射。 */
function statusFor(err) {
  if (err instanceof ChannelApiValidationError) {
    return err.code === 'MODEL_NOT_FOUND' ? 404 : 400;
  }
  return 500;
}

/** 统一失败出口：校验错误用原始 code，其余归为 INTERNAL。 */
function handleFailure(req, res, err) {
  if (err instanceof ChannelApiValidationError) {
    return apiResponse.fail(res, err.code, err.message, { status: statusFor(err) });
  }
  console.error('渠道 API 请求失败:', err);
  return apiResponse.fail(res, 'INTERNAL', err.message || '渠道 API 请求失败', {
    status: 500,
  });
}

// ── 列表 / 指南索引 ──────────────────────────────────────────────

// 列出所有渠道（Key 脱敏）。q 支持渠道名/供应商/端点/环境变量名模糊匹配。
router.get('/', async (req, res) => {
  try {
    const channels = await channelApiService.listChannels({ q: req.query.q });
    apiResponse.success(res, { channels, total: channels.length });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// 内置 Agent 渠道配置文档索引（不依赖数据库行）。
router.get('/guide', async (req, res) => {
  try {
    const agents = channelApiService.listAgentGuides();
    apiResponse.success(res, { agents, total: agents.length });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// ── 单条渠道 ─────────────────────────────────────────────────────

// 单条渠道详情（Key 脱敏）。
router.get('/:id', async (req, res) => {
  try {
    const channel = await channelApiService.getChannel(parseId(req.params.id));
    if (!channel) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', `渠道不存在 (id=${req.params.id})`, {
        status: 404,
      });
    }
    apiResponse.success(res, channel);
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// 新建渠道。
router.post('/', async (req, res) => {
  try {
    const channel = await channelApiService.createChannel(req.body || {});
    apiResponse.created(res, channel, { message: '渠道已创建' });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// 更新渠道（api_key 传空串表示清空，不传则保留原值）。
router.put('/:id', async (req, res) => {
  try {
    const channel = await channelApiService.updateChannel(parseId(req.params.id), req.body || {});
    apiResponse.success(res, channel, { message: '渠道已更新' });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// 删除渠道。
router.delete('/:id', async (req, res) => {
  try {
    const result = await channelApiService.deleteChannel(parseId(req.params.id));
    if (!result.existed) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', `渠道不存在 (id=${req.params.id})`, {
        status: 404,
      });
    }
    apiResponse.success(res, result, { message: '渠道已删除' });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// ── 明文揭示 / 配置指南 ──────────────────────────────────────────

// 一次性返回明文 Key + 已替换真实 Key 的配置块，并写审计日志。
router.post('/:id/reveal', async (req, res) => {
  try {
    const result = await channelApiService.revealChannelKey(
      parseId(req.params.id),
      req.user || {}
    );
    apiResponse.success(res, result, { message: '已揭示明文 Key（本次访问已记入审计）' });
  } catch (err) {
    handleFailure(req, res, err);
  }
});

// 返回该渠道的配置指南（含 shell/json/yaml/toml 代码块，Key 为占位符）。
router.get('/:id/config', async (req, res) => {
  try {
    const config = await channelApiService.getConfigGuide(parseId(req.params.id));
    apiResponse.success(res, config);
  } catch (err) {
    handleFailure(req, res, err);
  }
});

module.exports = router;
