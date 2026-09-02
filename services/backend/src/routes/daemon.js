'use strict';

/**
 * routes/daemon.js — lightweight HTTP surface over the khychat daemon
 * lifecycle.
 *
 * Frontend (Login.vue) calls GET /api/daemon/ensure on mount to ask
 * "is the daemon up, and if not, please start it." The handler is
 * idempotent and non-blocking on the hot path: when the daemon is already
 * running we return in <100ms with a snapshot. When it has to spawn, we
 * wait up to KHY_DAEMON_SPAWN_TIMEOUT_MS for the daemon to publish its
 * runtime file and answer /status on its control API.
 *
 * Auth: this route is **public** by design. The khychat login page has to
 * be reachable *before* the user has any credential, and the only thing
 * it does is start a local daemon — no business endpoint, no data leak.
 * The daemon's own login endpoint stays behind JWT as before.
 *
 * POST /api/daemon/shutdown is also public for the same reason (lets a
 * user kill a stuck daemon from the login page's "khychat won't start"
 * troubleshooting UI). It is best-effort and never throws.
 */

const express = require('express');
const router = express.Router();

const lifecycle = require('../services/aiManageDaemonLifecycle');

router.get('/status', (_req, res) => {
  try {
    return res.json({ success: true, data: lifecycle.snapshot() });
  } catch (e) {
    return res.status(500).json({ success: false, message: e && e.message });
  }
});

// Idempotent "make sure the daemon is up". The Login.vue composable calls
// this on mount; it is safe to call any number of times.
router.get('/ensure', async (_req, res) => {
  const result = await lifecycle.ensureStarted();
  const status =
    result.state === 'running'
      ? 200
      : result.state === 'skipped'
        ? 200
        : 503; // failed — caller (the SPA) shows a hint and the user retries
  res.status(status).json({ success: result.state === 'running' || result.state === 'skipped', data: result });
});

router.post('/ensure', async (_req, res) => {
  const result = await lifecycle.ensureStarted();
  const status =
    result.state === 'running'
      ? 200
      : result.state === 'skipped'
        ? 200
        : 503;
  res.status(status).json({ success: result.state === 'running' || result.state === 'skipped', data: result });
});

router.post('/shutdown', async (_req, res) => {
  const result = await lifecycle.requestShutdown();
  res.json({ success: result.ok, data: result });
});

module.exports = router;
