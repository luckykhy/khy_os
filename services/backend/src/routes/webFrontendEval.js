'use strict';

/**
 * Web Frontend Eval routes — 2D/3D Web 前端轨迹标注平台 API。
 *
 * Auth stacked at mount: authenticateToken + requireAdmin.
 */
const express = require('express');

const router = express.Router();
const { Op } = require('sequelize');

const service = require('../services/webFrontendEval');

const { WebFrontendEvalTask, WebFrontendEvalRun } = require('@khy/shared/models');

// ── Helpers ──────────────────────────────────────────────────────

function safeNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

function serializeTask(t) {
  if (!t) {
    return null;
  }
  const { password, ...safe } = t.toJSON ? t.toJSON() : t;
  return safe;
}

function serializeRun(r) {
  if (!r) {
    return null;
  }
  return r.toJSON ? r.toJSON() : r;
}

// ── Task CRUD ────────────────────────────────────────────────────

router.get('/tasks', (req, res) => {
  const opts = {
    page: safeNum(req.query.page, 1),
    pageSize: safeNum(req.query.pageSize, 20),
    level: req.query.level || null,
    category: req.query.category || null,
    status: req.query.status || null,
    q: req.query.q || null,
    tag: req.query.tag || null,
  };
  service
    .listTasks(opts)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, data: result.data });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.get('/tasks/:id', (req, res) => {
  service
    .getTask(Number(req.params.id))
    .then((result) => {
      if (!result.success) {
        return res.status(404).json(result);
      }
      res.json({ success: true, data: serializeTask(result.data) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.post('/tasks', (req, res) => {
  const data = {
    name: req.body?.name || req.body?.title,
    description: req.body?.description || '',
    level: req.body?.level || 'L1',
    category: req.body?.category || '2d',
    status: req.body?.status || 'draft',
    prompt_md: req.body?.promptMd || req.body?.prompt_md || '',
    assets: Array.isArray(req.body?.assets) ? req.body.assets : [],
    acceptance_criteria: Array.isArray(req.body?.acceptanceCriteria)
      ? req.body.acceptanceCriteria
      : [],
    assets_root: req.body?.assetsRoot || req.body?.assets_root || '',
    tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
    lock_dependencies: !!req.body?.lockDependencies,
    created_by: req.body?.createdBy || 0,
  };
  if (!data.name) {
    return res.status(400).json({ success: false, message: 'name is required' });
  }

  service
    .createTask(data)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.status(201).json({ success: true, data: serializeTask(result.data) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.put('/tasks/:id', (req, res) => {
  const allowed = [
    'name',
    'description',
    'level',
    'category',
    'status',
    'prompt_md',
    'promptMd',
    'assets',
    'acceptance_criteria',
    'acceptanceCriteria',
    'assets_root',
    'assetsRoot',
    'tags',
    'lock_dependencies',
    'lockDependencies',
  ];
  const data = {};
  for (const key of allowed) {
    if (key in req.body) {
      // Normalize camelCase → snake_case for DB
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      data[dbKey] = req.body[key];
    }
  }
  service
    .updateTask(Number(req.params.id), data)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, data: serializeTask(result.data) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.delete('/tasks/:id', (req, res) => {
  service
    .deleteTask(Number(req.params.id))
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, message: 'Deleted' });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

// ── Run Lifecycle ────────────────────────────────────────────────

router.post('/tasks/:id/runs', (req, res) => {
  service
    .startRun(Number(req.params.id), {
      aiModel: req.body?.aiModel,
      annotatorId: req.body?.annotatorId || 0,
    })
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.status(201).json({ success: true, data: serializeRun(result.data) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.get('/runs', (req, res) => {
  const opts = {
    page: safeNum(req.query.page, 1),
    pageSize: safeNum(req.query.pageSize, 20),
    status: req.query.status || null,
    taskId: req.query.taskId ? Number(req.query.taskId) : null,
  };
  service
    .listRuns(opts)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, data: result.data });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.get('/runs/:id', (req, res) => {
  service
    .getRun(Number(req.params.id))
    .then((result) => {
      if (!result.success) {
        return res.status(404).json(result);
      }
      res.json({ success: true, data: serializeRun(result.data) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.put('/runs/:id', (req, res) => {
  const allowed = [
    'package_path',
    'packagePath',
    'ai_model',
    'aiModel',
    'api_call_rounds',
    'apiCallRounds',
    'status',
    'annotator_id',
    'annotatorId',
    'notes',
    'rejection_reason',
    'rejectionReason',
    'total_duration',
    'totalDuration',
  ];
  const data = {};
  for (const key of allowed) {
    if (key in req.body) {
      const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      data[dbKey] = req.body[key];
    }
  }
  const { WebFrontendEvalRun: RunModel } = require('@khy/shared/models');
  RunModel.findByPk(Number(req.params.id))
    .then((run) => {
      if (!run) {
        return res.status(404).json({ success: false, message: 'Run not found' });
      }
      return run.update(data).then(() => run);
    })
    .then((run) => {
      if (!run || run instanceof Response) {
        return;
      }
      res.json({ success: true, data: serializeRun(run) });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

// ── Package Assembly & QC ────────────────────────────────────────

router.post('/runs/:id/assemble', (req, res) => {
  const runId = Number(req.params.id);
  service
    .assemblePackage(runId, req.body || {})
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, data: result.data });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.post('/runs/:id/complete', (req, res) => {
  service
    .completeRun(Number(req.params.id), req.body || {})
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, message: 'Run completed' });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.post('/runs/:id/reject', (req, res) => {
  const reason = req.body?.reason || '未通过 QC 审核';
  service
    .rejectRun(Number(req.params.id), reason)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, message: 'Run rejected' });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

router.post('/runs/:id/self-check', (req, res) => {
  const selfCheck = req.body?.selfCheck || req.body?.self_check;
  if (!selfCheck) {
    return res.status(400).json({ success: false, message: 'selfCheck is required' });
  }
  service
    .submitSelfCheck(Number(req.params.id), selfCheck)
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, message: 'Self-check submitted' });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

// ── Stats ────────────────────────────────────────────────────────

router.get('/stats', (req, res) => {
  service
    .getStats()
    .then((result) => {
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ success: true, data: result.data });
    })
    .catch((err) => res.status(500).json({ success: false, message: err.message }));
});

// ── Levels & Categories (reference data) ────────────────────────

router.get('/reference/levels', (req, res) => {
  res.json({
    success: true,
    data: [
      { value: 'L1', label: 'L1 — 静态展示', description: 'HTML/CSS 静态页面，基础布局与样式' },
      {
        value: 'L2',
        label: 'L2 — 交互响应',
        description: '含用户交互、状态切换、表单验证等动态行为',
      },
      {
        value: 'L3',
        label: 'L3 — 复杂 3D/物理/动画',
        description: 'Three.js/WebGL 3D 场景、物理引擎、复杂动画',
      },
    ],
  });
});

router.get('/reference/categories', (req, res) => {
  res.json({
    success: true,
    data: [
      { value: '2d', label: '2D Web 前端', description: 'HTML/CSS/JS 二维页面' },
      { value: '3d', label: '3D Web 前端', description: 'Three.js / WebGL / WebGPU 三维页面' },
    ],
  });
});

module.exports = router;
