'use strict';

const express = require('express');
const router = express.Router();
const { GuiEvalTask, GuiEvalRun } = require('@khy/shared/models');
const apiResponse = require('../utils/apiResponse');

const { authenticateToken, requireAdmin } = require('khy-ai-backend/middleware/auth');

// ── helpers ──────────────────────────────────────────────────────────

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function statusFilter(where, status) {
  if (!status || status === 'all') {
    return;
  }
  const s = String(status).toLowerCase();
  const valid = new Set([
    'draft',
    'active',
    'archived',
    'deprecated',
    'queued',
    'preparing',
    'running',
    'evaluating',
    'completed',
    'failed',
    'cancelled',
    'timeout',
    'pending',
    'pass',
    'partial',
    'fail',
    'pending_review',
  ]);
  if (valid.has(s)) {
    where.status = s;
  }
}

function serializeTask(t) {
  if (!t) {
    return null;
  }
  const r = t.toJSON ? t.toJSON() : { ...t };
  return r;
}

function serializeRun(r) {
  if (!r) {
    return null;
  }
  const o = r.toJSON ? r.toJSON() : { ...r };
  return o;
}

// ── Task CRUD ────────────────────────────────────────────────────────

// GET /api/gui-eval/tasks — list with pagination and filters
router.get('/tasks', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, safeNum(req.query.page, 1));
    const pageSize = Math.min(100, Math.max(1, safeNum(req.query.pageSize, 20)));
    const offset = (page - 1) * pageSize;
    const where = {};
    statusFilter(where, req.query.status);
    if (req.query.difficulty) {
      where.difficulty = String(req.query.difficulty);
    }
    if (req.query.category) {
      where.category = String(req.query.category);
    }
    if (req.query.q) {
      const q = String(req.query.q);
      where.name = { [require('sequelize').Op.iLike]: `%${q}%` };
    }
    if (req.query.tag) {
      const tag = String(req.query.tag);
      where.tags = { [require('sequelize').Op.contains]: [tag] };
    }
    const { rows, count } = await GuiEvalTask.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset,
    });
    return apiResponse.success(res, { tasks: rows.map(serializeTask), total: count, page, pageSize });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取任务列表失败', { status: 500 });
  }
});

// GET /api/gui-eval/tasks/:id — task detail with runs
router.get('/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const task = await GuiEvalTask.findByPk(req.params.id, {
      include: [{ model: GuiEvalRun, as: 'runs', limit: 20, order: [['createdAt', 'DESC']] }],
    });
    if (!task) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '任务不存在', { status: 404 });
    }
    return apiResponse.success(res, serializeTask(task));
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取任务详情失败', { status: 500 });
  }
});

// POST /api/gui-eval/tasks — create task (admin)
router.post('/tasks', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const data = {
      name: String(body.name || '').trim(),
      description: body.description ? String(body.description) : null,
      difficulty: ['easy', 'medium', 'hard', 'expert'].includes(body.difficulty)
        ? body.difficulty
        : 'medium',
      category: body.category ? String(body.category) : null,
      status: ['draft', 'active', 'archived', 'deprecated'].includes(body.status)
        ? body.status
        : 'draft',
      materials: Array.isArray(body.materials) ? body.materials : [],
      environment: body.environment && typeof body.environment === 'object' ? body.environment : {},
      checkpoints: Array.isArray(body.checkpoints) ? body.checkpoints : [],
      gold_standard:
        body.goldStandard && typeof body.goldStandard === 'object' ? body.goldStandard : {},
      pricing: body.pricing && typeof body.pricing === 'object' ? body.pricing : { basePrice: 320 },
      tags: Array.isArray(body.tags) ? body.tags : [],
      max_duration: safeNum(body.maxDuration, 300),
      retry_allowed: body.retryAllowed !== false,
      created_by: req.user && req.user.id ? req.user.id : 0,
    };
    if (!data.name) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '任务名称不能为空', { status: 400 });
    }
    const task = await GuiEvalTask.create(data);
    return apiResponse.created(res, serializeTask(task));
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '创建任务失败', { status: 500 });
  }
});

// PUT /api/gui-eval/tasks/:id — update task (admin)
router.put('/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const task = await GuiEvalTask.findByPk(req.params.id);
    if (!task) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '任务不存在', { status: 404 });
    }
    const body = req.body || {};
    const allowed = [
      'name',
      'description',
      'difficulty',
      'category',
      'status',
      'materials',
      'environment',
      'checkpoints',
      'gold_standard',
      'pricing',
      'tags',
      'max_duration',
      'retry_allowed',
    ];
    const update = {};
    for (const key of allowed) {
      const map = {
        name: 'name',
        description: 'description',
        difficulty: 'difficulty',
        category: 'category',
        status: 'status',
        materials: 'materials',
        environment: 'environment',
        checkpoints: 'checkpoints',
        gold_standard: 'gold_standard',
        pricing: 'pricing',
        tags: 'tags',
        max_duration: 'max_duration',
        retry_allowed: 'retry_allowed',
      };
      if (body[map[key]] !== undefined) {
        update[key] = body[map[key]];
      }
    }
    if (update.status && !['draft', 'active', 'archived', 'deprecated'].includes(update.status)) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '无效的 status 值', { status: 400 });
    }
    if (update.difficulty && !['easy', 'medium', 'hard', 'expert'].includes(update.difficulty)) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '无效的 difficulty 值', { status: 400 });
    }
    await task.update(update);
    return apiResponse.success(res, serializeTask(task));
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '更新任务失败', { status: 500 });
  }
});

// DELETE /api/gui-eval/tasks/:id — delete task (admin)
router.delete('/tasks/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const task = await GuiEvalTask.findByPk(req.params.id);
    if (!task) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '任务不存在', { status: 404 });
    }
    await task.destroy();
    return apiResponse.success(res, null, { message: '任务已删除' });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '删除任务失败', { status: 500 });
  }
});

// ── Run (execution) ─────────────────────────────────────────────────

// POST /api/gui-eval/tasks/:id/run — execute task
router.post('/tasks/:id/run', authenticateToken, async (req, res) => {
  try {
    const task = await GuiEvalTask.findByPk(req.params.id);
    if (!task) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '任务不存在', { status: 404 });
    }
    if (task.status !== 'active') {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '任务状态非 active，无法执行', { status: 400 });
    }

    const body = req.body || {};
    const run = await GuiEvalRun.create({
      task_id: task.id,
      guarded_run_id: body.guardedRunId || null,
      agent_model: body.agentModel || null,
      agent_config: body.agentConfig || {},
      status: 'queued',
      user_id: req.user && req.user.id ? req.user.id : 0,
    });

    return apiResponse.created(res, { runId: run.id, status: run.status, message: '任务已入队，开始执行' });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '启动任务执行失败', { status: 500 });
  }
});

// GET /api/gui-eval/runs — list runs
router.get('/runs', authenticateToken, async (req, res) => {
  try {
    const page = Math.max(1, safeNum(req.query.page, 1));
    const pageSize = Math.min(100, Math.max(1, safeNum(req.query.pageSize, 20)));
    const offset = (page - 1) * pageSize;
    const where = {};
    statusFilter(where, req.query.status);
    if (req.query.verdict) {
      const v = String(req.query.verdict);
      if (['pass', 'partial', 'fail', 'pending', 'pending_review'].includes(v)) {
        where.verdict = v;
      }
    }
    if (req.query.taskId) {
      where.task_id = safeNum(req.query.taskId);
    }
    if (req.query.userId) {
      where.user_id = safeNum(req.query.userId);
    }
    const { rows, count } = await GuiEvalRun.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: pageSize,
      offset,
      include: [{ model: GuiEvalTask, as: 'task', attributes: ['id', 'name', 'difficulty'] }],
    });
    return apiResponse.success(res, { runs: rows.map(serializeRun), total: count, page, pageSize });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取执行记录失败', { status: 500 });
  }
});

// GET /api/gui-eval/runs/:id — run detail
router.get('/runs/:id', authenticateToken, async (req, res) => {
  try {
    const run = await GuiEvalRun.findByPk(req.params.id, {
      include: [{ model: GuiEvalTask, as: 'task' }],
    });
    if (!run) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '执行记录不存在', { status: 404 });
    }
    return apiResponse.success(res, serializeRun(run));
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取执行记录详情失败', { status: 500 });
  }
});

// POST /api/gui-eval/runs/:id/evaluate — trigger auto-evaluation (admin)
router.post('/runs/:id/evaluate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const run = await GuiEvalRun.findByPk(req.params.id, {
      include: [{ model: GuiEvalTask, as: 'task' }],
    });
    if (!run) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '执行记录不存在', { status: 404 });
    }
    if (run.status !== 'running' && run.status !== 'completed' && run.status !== 'failed') {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', '当前状态不可评测', { status: 400 });
    }
    // Evaluation is handled by the runEngine — here we just flip the state
    // and return a signal that the engine should run checkpoints.
    await run.update({ status: 'evaluating' });
    return apiResponse.success(res, { runId: run.id, status: 'evaluating', message: '评测已触发' });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '触发评测失败', { status: 500 });
  }
});

// POST /api/gui-eval/runs/:id/review — human review submission (admin)
router.post('/runs/:id/review', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const run = await GuiEvalRun.findByPk(req.params.id);
    if (!run) {
      return apiResponse.fail(res, 'MODEL_NOT_FOUND', '执行记录不存在', { status: 404 });
    }
    const body = req.body || {};
    const manualScore = safeNum(body.manualScore);
    if (manualScore < 0 || manualScore > 1) {
      return apiResponse.fail(res, 'INVALID_ARGUMENT', 'manualScore 须在 0~1 之间', { status: 400 });
    }
    await run.update({
      manual_score: manualScore,
      verdict: manualScore >= 0.8 ? 'pass' : manualScore >= 0.5 ? 'partial' : 'fail',
    });
    return apiResponse.success(res, { runId: run.id, manualScore, verdict: run.verdict });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '提交复核失败', { status: 500 });
  }
});

// ── Stats & leaderboard ─────────────────────────────────────────────

// GET /api/gui-eval/stats — aggregate stats
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const totalRuns = await GuiEvalRun.count();
    const passRuns = await GuiEvalRun.count({ where: { verdict: 'pass' } });
    const partialRuns = await GuiEvalRun.count({ where: { verdict: 'partial' } });
    const failRuns = await GuiEvalRun.count({ where: { verdict: 'fail' } });
    const pendingRuns = await GuiEvalRun.count({
      where: { verdict: { [require('sequelize').Op.in]: ['pending', 'pending_review'] } },
    });
    const totalTasks = await GuiEvalTask.count();
    const activeTasks = await GuiEvalTask.count({ where: { status: 'active' } });
    const payoutRaw = await GuiEvalRun.sum('payout_amount');
    const payout = safeNum(payoutRaw, 0);
    return apiResponse.success(res, {
      runs: {
        total: totalRuns,
        pass: passRuns,
        partial: partialRuns,
        fail: failRuns,
        pending: pendingRuns,
      },
      tasks: { total: totalTasks, active: activeTasks },
      payout: { total: payout },
    });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取统计失败', { status: 500 });
  }
});

// GET /api/gui-eval/leaderboard — per-model / per-agent ranking
router.get('/leaderboard', authenticateToken, async (req, res) => {
  try {
    const raw = await GuiEvalRun.findAll({
      where: { agent_model: { [require('sequelize').Op.ne]: null } },
      attributes: [
        ['agent_model', 'model'],
        [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'runs'],
        [require('sequelize').fn('AVG', require('sequelize').col('overall_score')), 'avgScore'],
        [require('sequelize').fn('SUM', require('sequelize').col('payout_amount')), 'totalPayout'],
      ],
      group: ['agent_model'],
      order: [['avgScore', 'DESC']],
    });
    const rows = raw.map((r) => {
      const d = r.toJSON ? r.toJSON() : r;
      return {
        model: d.model,
        runs: safeNum(d.runs, 0),
        avgScore: safeNum(d.avgScore, 0),
        totalPayout: safeNum(d.totalPayout, 0),
      };
    });
    return apiResponse.success(res, { leaderboard: rows });
  } catch (err) {
    return apiResponse.fail(res, 'INTERNAL', err.message || '获取排行榜失败', { status: 500 });
  }
});

module.exports = router;
