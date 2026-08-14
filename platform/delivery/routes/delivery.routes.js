/**
 * delivery.routes.js — Express routes for the cross-platform delivery tool.
 *
 * Mount at: app.use('/api/delivery', deliveryRoutes)
 *
 * Prerequisites: app must have express.json() middleware.
 */

const express = require('express');
const { DeliveryController } = require('../deliveryController');
const crypto = require('crypto');

function deliveryRoutes(options = {}) {
  const router = express.Router();
  const controller = new DeliveryController(options.deliveryConfig || {});
  let _initPromise = null;

  // Lazy init (first request)
  function ensureInit() {
    if (!_initPromise) {
      _initPromise = controller.init();
    }
    return _initPromise;
  }

  // ── POST /api/delivery/send ─────────────────────────────────────────────
  // Main endpoint: deliver content to specified platforms.
  router.post('/send', async (req, res) => {
    try {
      await ensureInit();
      const { content, format, platforms, priority, metadata } = req.body;

      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'bad_request', message: 'content (string) is required.' });
      }

      const taskId = req.headers['x-task-id'] || crypto.randomUUID();
      const report = await controller.deliver({
        task_id: taskId,
        content,
        format: format || 'markdown',
        platforms: Array.isArray(platforms) ? platforms : undefined,
        priority: priority || 5,
        metadata: metadata || {},
      });

      res.json(report);
    } catch (err) {
      console.error('[delivery/send] Error:', err);
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── GET /api/delivery/status/:taskId ────────────────────────────────────
  // Get task status and results.
  router.get('/status/:taskId', async (req, res) => {
    try {
      await ensureInit();
      const task = controller.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'not_found', message: 'Task not found.' });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── GET /api/delivery/tasks ─────────────────────────────────────────────
  // List tasks with optional filters.
  router.get('/tasks', async (req, res) => {
    try {
      await ensureInit();
      const filter = {
        status: req.query.status,
        platforms: req.query.platforms ? req.query.platforms.split(',') : undefined,
        limit: parseInt(req.query.limit) || 50,
      };
      const tasks = controller.listTasks(filter);
      res.json({ tasks, total: tasks.length });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── GET /api/delivery/adapters ──────────────────────────────────────────
  // Get status of all registered adapters.
  router.get('/adapters', async (req, res) => {
    try {
      await ensureInit();
      res.json({ adapters: controller.getAdapterStatus() });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── POST /api/delivery/adapters/:platform/detect ────────────────────────
  // Manually trigger adapter detection.
  router.post('/adapters/:platform/detect', async (req, res) => {
    try {
      await ensureInit();
      const platform = req.params.platform;
      const status = controller.getAdapterStatus().find((a) => a.platform === platform);
      if (!status) return res.status(404).json({ error: 'not_found', message: `Adapter '${platform}' not found.` });
      res.json({ platform, available: status.available, configValid: status.configValid });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── GET /api/delivery/templates ─────────────────────────────────────────
  // List available prompt templates.
  router.get('/templates', async (req, res) => {
    try {
      await ensureInit();
      const templates = controller.listTemplates().map((name) => {
        const content = controller.getPrompt(name);
        return { name, preview: content?.slice(0, 200) || null };
      });
      res.json({ templates });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── GET /api/delivery/templates/:name ───────────────────────────────────
  // Get a specific prompt template.
  router.get('/templates/:name', async (req, res) => {
    try {
      await ensureInit();
      const content = controller.getPrompt(req.params.name);
      if (!content) return res.status(404).json({ error: 'not_found', message: `Template '${req.params.name}' not found.` });
      res.json({ name: req.params.name, content });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── POST /api/delivery/validate ─────────────────────────────────────────
  // Validate input without actually delivering.
  router.post('/validate', async (req, res) => {
    try {
      await ensureInit();
      const { content, format, platforms } = req.body;
      const errors = [];
      const warnings = [];

      if (!content) errors.push('content is required');
      if (content && typeof content !== 'string') errors.push('content must be a string');
      if (platforms && !Array.isArray(platforms)) errors.push('platforms must be an array');

      // Check adapter availability
      const targetPlatforms = platforms || ['markdown', 'notion', 'slack', 'webhook'];
      for (const name of targetPlatforms) {
        const status = controller.getAdapterStatus().find((a) => a.platform === name);
        if (!status) {
          warnings.push(`No adapter registered for '${name}'`);
        } else if (!status.available) {
          errors.push(`Adapter '${name}' is not available (check config)`);
        }
      }

      res.json({
        valid: errors.length === 0,
        errors,
        warnings,
        platforms_checked: targetPlatforms,
      });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  // ── POST /api/delivery/retry/:taskId ────────────────────────────────────
  // Retry a failed delivery task.
  router.post('/retry/:taskId', async (req, res) => {
    try {
      await ensureInit();
      const existing = controller.getTask(req.params.taskId);
      if (!existing) return res.status(404).json({ error: 'not_found', message: 'Task not found.' });

      const report = await controller.deliver({
        task_id: req.params.taskId,
        content: existing.content,
        format: existing.format,
        platforms: existing.platforms,
        metadata: existing.metadata,
      });

      res.json(report);
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err.message });
    }
  });

  return router;
}

module.exports = { deliveryRoutes };
