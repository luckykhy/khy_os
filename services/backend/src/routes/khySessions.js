'use strict';

/**
 * khySessions.js — khy REPL 会话真源的只读 HTTP 暴露（CH-4）。
 *
 * 真源：services/sessionPersistence（.khy/sessions/ 的 JSONL+JSON 双轨持久化，
 * CLI REPL 经 CH-2 直调）。桌面端按 [DESIGN-ARCH-068] L3→L2 仅 HTTP 消费它，
 * 因此这里提供最小的只读视图；一切写操作仍走 CLI/服务层正门，本路由不提供写端点。
 *
 * 挂载：server.js 以 `app.use('/api/khy-sessions', authMiddleware, ...)` 挂载
 * （JWT Bearer / API key，见 src/middleware/auth.js）。
 */

const express = require('express');

const router = express.Router();

const sessionPersistence = require('../services/sessionPersistence');

const MAX_LIST_LIMIT = 200;
const MAX_CHAIN_MESSAGES = 500;

function _clampLimit(raw, fallback, max) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, max);
}

/**
 * GET /api/khy-sessions
 * 列出已持久化的 REPL 会话（按 updatedAt 倒序）。
 */
router.get('/', async (req, res) => {
  try {
    const limit = _clampLimit(req.query.limit, 100, MAX_LIST_LIMIT);
    const sessions = sessionPersistence.listPersistedSessions({ limit });
    res.json({ success: true, data: { sessions, count: sessions.length } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取会话列表失败: ${error.message}`,
    });
  }
});

/**
 * GET /api/khy-sessions/:sessionId
 * 读取单个会话：元数据 + 消息链（uuid 链，leaf 反向遍历）。
 */
router.get('/:sessionId', async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || '').trim();
    // 与 sessionPersistence._safeId 同规则：只放行文件名安全字符
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ success: false, message: '非法的会话 ID' });
    }

    const meta = sessionPersistence.loadSessionMeta(sessionId);
    if (!meta) {
      return res.status(404).json({ success: false, message: '会话不存在' });
    }

    const messages = sessionPersistence
      .buildConversationChain(sessionId)
      .slice(-MAX_CHAIN_MESSAGES);

    res.json({ success: true, data: { session: meta, messages } });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: `读取会话失败: ${error.message}`,
    });
  }
});

module.exports = router;
