// khy.ai-backend/routes/tasks —— 移动端本地任务「云端影子」
//
// 挂载点：/api/tasks（mobile companion 用）
// 鉴权：authenticateToken（与 userGateway 同一套）
// 数据：services/taskSyncStore.js（per-user JSON 文件）
//
// 端点：
//   GET    /api/tasks/probe                  — 健康探测（无副作用）
//   GET    /api/tasks?since=<ms>             — 拉取；since>0 时为增量
//   GET    /api/tasks/:id                    — 单个
//   POST   /api/tasks                        — 增量同步 { tasks: [...] }
//   PUT    /api/tasks/:id                    — 单条 upsert
//   DELETE /api/tasks/:id                    — 删除
//
// 约定：每个 task = { id, name, prompt, provider, model, schedule, status, lastRunAt, lastResult, history, updatedAt }
//
// 安全：
//   - 数据按 userId 隔离；用 reqUserId 单点真源
//   - 单条 task 大小限制 8KB（防恶意大 payload）
//   - 端点最大同步条数 200 / 请求

'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const userId = require('../utils/reqUserId');
const store = require('../services/taskSyncStore');

const MAX_TASK_BYTES = 8 * 1024;
const MAX_BULK = 200;

function fail(res, err) {
  const code = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = (err && err.message) || 'Internal server error';
  if (code >= 500) console.error('[tasks]', err);
  res.status(code).json({ success: false, message });
}

function sanitize(task) {
  if (!task || typeof task !== 'object') return null;
  const id = String(task.id || '').trim();
  if (!id) return null;
  // 截断过大的 history 字段，避免磁盘膨胀
  const history = Array.isArray(task.history) ? task.history.slice(-50) : [];
  return {
    id,
    name: String(task.name || '').slice(0, 120),
    prompt: String(task.prompt || '').slice(0, 2000),
    provider: String(task.provider || '').slice(0, 64) || undefined,
    model: String(task.model || '').slice(0, 120) || undefined,
    schedule: task.schedule,
    status: task.status,
    lastRunAt: Number(task.lastRunAt) || undefined,
    lastResult: String(task.lastResult || '').slice(0, 2000) || undefined,
    history,
    updatedAt: Number(task.updatedAt) || Date.now(),
    createdAt: Number(task.createdAt) || undefined,
  };
}

function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj || {}), 'utf8');
}

router.use(authenticateToken);

// 探测：移动端用来"这个后端有没有这个路由"
router.get('/probe', (req, res) => {
  res.json({ success: true, data: { supported: true, server: 'khy-ai-backend', route: 'tasks' } });
});

router.get('/', (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const tasks = store.list(userId(req), { since });
    res.json({ success: true, data: { tasks, serverUpdatedAt: Date.now() } });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/:id', (req, res) => {
  try {
    const { tasks } = store.readAll(userId(req));
    const t = tasks.find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ success: false, message: '任务不存在' });
    res.json({ success: true, data: t });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.tasks) ? req.body.tasks : null;
    if (!incoming) return fail(res, Object.assign(new Error('body 必须是 {tasks: [...] }'), { statusCode: 400 }));
    if (incoming.length > MAX_BULK) {
      return fail(res, Object.assign(new Error(`单次最多 ${MAX_BULK} 条`), { statusCode: 413 }));
    }
    const clean = incoming.map(sanitize).filter(Boolean);
    if (byteSize(clean) > MAX_TASK_BYTES * 50) {
      return fail(res, Object.assign(new Error('payload 过大'), { statusCode: 413 }));
    }
    const result = store.bulkUpsert(userId(req), clean);
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/:id', express.json({ limit: '16kb' }), (req, res) => {
  try {
    const clean = sanitize(req.body);
    if (!clean) return fail(res, Object.assign(new Error('非法 task'), { statusCode: 400 }));
    if (clean.id !== req.params.id) {
      return fail(res, Object.assign(new Error('URL id 与 body id 不一致'), { statusCode: 400 }));
    }
    if (byteSize(clean) > MAX_TASK_BYTES) {
      return fail(res, Object.assign(new Error('单条 task 超过 8KB'), { statusCode: 413 }));
    }
    const saved = store.upsert(userId(req), clean);
    res.json({ success: true, data: saved });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ok = store.remove(userId(req), req.params.id);
    res.json({ success: true, data: { removed: ok } });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;