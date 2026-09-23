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
 *
 * "Public" means *unauthenticated*, not *unreachable*: every handler below sits
 * behind `requireLoopback` + `originGuard` (see middleware/auth.js). Without
 * those, any web page the user visits could POST to 127.0.0.1 and kill the
 * daemon — loopback binding alone is not a security boundary.
 */

const express = require('express');
const router = express.Router();

const lifecycle = require('../services/aiManageDaemonLifecycle');
const { requireLoopback, originGuard } = require('../middleware/originGuard');

// 本路由保持公开(登录页需在用户拿到任何凭据之前拉起/停掉守护进程),但**不对外**:
// 叠加两道正交防线 —— 仅接受本机回环来源,且拒绝不可信的浏览器来源。
// 这堵掉了 POST /shutdown、/ensure 可被任意网页跨站触达的问题(DoS 面)。
router.use(requireLoopback, originGuard);

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

// Frontend idle keepalive: the SPA calls this every ~30s to prevent the
// daemon's WS-session idle timeout (30 min) from closing the chat session
// while the user's page is still open. Idempotent — if the daemon is already
// running it returns instantly with the current snapshot.
router.post('/keepalive', async (_req, res) => {
  const result = await lifecycle.ensureStarted();
  const ok = result.state === 'running' || result.state === 'skipped';
  res.json({
    success: ok,
    data: {
      state: result.state,
      runtime: result.runtime,
      lastCheckedAt: Date.now(),
    },
  });
});

module.exports = router;
