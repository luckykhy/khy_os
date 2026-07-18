/**
 * Per-user plugin management routes (multi-tenant).
 *
 * Mounts at /api/plugins with `authenticateToken` only — every handler is scoped
 * to `req.user.id` (ownership enforced in the service). `:id` here is the
 * UserInstalledPlugin id. Mirrors workflow.js: `userId(req)`, `{ success, data }`,
 * `fail()`. Literal sub-paths (preview/import) are declared before /:id.
 *
 * @pattern Proxy
 */
'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const svc = require('../services/pluginService');

router.use(authenticateToken);

// 收敛到 utils/reqUserId 单一真源(逐字节委托,调用点不变)
const userId = require('../utils/reqUserId');

function fail(res, err) {
  const code = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = (err && err.message) || 'Internal server error';
  if (code >= 500) console.error('[plugins]', err);
  res.status(code).json({ success: false, message });
}

// GET /api/plugins — list the calling user's installed plugins
router.get('/', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.listInstalled(userId(req)) });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/plugins/tools — callable tool descriptors for the user's enabled
// plugins (`plugin__<slug>__<op>`), for the workflow toolCall picker. Literal
// path, before /:id so "tools" is not captured as an id.
router.get('/tools', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.listTools(userId(req)) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/plugins/preview — normalize an import WITHOUT persisting (before /:id)
router.post('/preview', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.preview(req.body || {}) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/plugins/import — publish a private plugin + auto-install (before /:id)
router.post('/import', async (req, res) => {
  try {
    const data = await svc.importAndInstall(userId(req), req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/plugins/:id — enable/disable ({ enabled })
router.patch('/:id', async (req, res) => {
  try {
    const data = await svc.setEnabled(userId(req), req.params.id, !!(req.body || {}).enabled);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/plugins/:id/auth — replace the auth config ({ authConfig })
router.put('/:id/auth', async (req, res) => {
  try {
    const data = await svc.setAuth(userId(req), req.params.id, (req.body || {}).authConfig);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/plugins/:id/test — one-shot test invoke ({ operationId, args })
router.post('/:id/test', async (req, res) => {
  try {
    const data = await svc.test(userId(req), req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/plugins/:id — uninstall
router.delete('/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await svc.remove(userId(req), req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
