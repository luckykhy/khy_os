/**
 * Marketplace catalog routes (multi-tenant).
 *
 * Mounts at /api/marketplace with `authenticateToken` only — every install/
 * uninstall is scoped to `req.user.id`. Browse/search/detail/categories read the
 * shared catalog; install/uninstall create/remove the caller's UserInstalledPlugin.
 * Mirrors the workflow.js surface: `userId(req)`, `{ success, data }`, `fail()`.
 *
 * @pattern Proxy
 */
'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const svc = require('../services/marketplaceService');

router.use(authenticateToken);

// 收敛到 utils/reqUserId 单一真源(逐字节委托,调用点不变)
const userId = require('../utils/reqUserId');

function fail(res, err) {
  const code = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = (err && err.message) || 'Internal server error';
  if (code >= 500) console.error('[marketplace]', err);
  res.status(code).json({ success: false, message });
}

// GET /api/marketplace — browse the catalog (?search=&category=&official=)
router.get('/', async (req, res) => {
  try {
    const data = await svc.list({
      search: req.query.search,
      category: req.query.category,
      official: req.query.official != null ? req.query.official === 'true' : undefined,
    });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/marketplace/categories — distinct categories (before /:id)
router.get('/categories', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.categories() });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/marketplace/:id — catalog detail (+ operations + install state)
router.get('/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.detail(userId(req), req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/marketplace/:id/install — install for the calling user (body.authConfig?)
router.post('/:id/install', async (req, res) => {
  try {
    const data = await svc.install(userId(req), req.params.id, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/marketplace/:id/uninstall — remove the calling user's install
router.post('/:id/uninstall', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.uninstall(userId(req), req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
