'use strict';

/**
 * crossPlatform.js — REST API routes for cross-platform sync.
 *
 * Device management and cross-platform state endpoints.
 * WebSocket upgrade is handled by the syncServer attached to the HTTP server.
 *
 * @module routes/crossPlatform
 */

const express = require('express');
const router = express.Router();

const apiResponse = require('../utils/apiResponse');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Every endpoint below is a state mutation or device/session enumeration. The two
// most sensitive ones (POST /start-platform, POST /start-all) spawn child
// processes, so unauthenticated access is not a read-only leak but remote
// command execution. All routes are gated; callers without a Bearer token get 401.
router.use(authMiddleware);

// ── Lazy-loaded services ────────────────────────────────────────────
let _hub = null;
let _syncServer = null;

function getHub() {
  if (!_hub) {
    try {
      const { hub } = require('../services/crossPlatform/crossPlatformHub');
      _hub = hub;
    } catch {
      return null;
    }
  }
  return _hub;
}

function getSyncServer() {
  if (!_syncServer) {
    try {
      _syncServer = require('../services/crossPlatform/ws/syncServer');
    } catch {
      return null;
    }
  }
  return _syncServer;
}

// ── Routes ──────────────────────────────────────────────────────────

/**
 * GET /api/cross-platform/status
 * Get cross-platform sync server status.
 */
router.get('/status', (req, res) => {
  const server = getSyncServer();
  const hub = getHub();

  apiResponse.success(res, {
    wsEndpoint: '/ws/cross-platform',
    syncServer: server ? server.getStatus() : null,
    hub: hub ? hub.getStatus() : null,
  });
});

/**
 * GET /api/cross-platform/devices
 * List all connected devices for the current user.
 */
router.get('/devices', async (req, res) => {
  const hub = getHub();
  if (!hub) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Cross-platform hub not available', { status: 503 });
  }

  // Presence is per-user: listing the whole hub would expose other accounts' devices.
  const devices = hub.listDevices({ userId: String(req.user.id), connectedOnly: true });
  apiResponse.success(res, devices);
});

/**
 * POST /api/cross-platform/devices/register
 * Register a new device (REST fallback for WebSocket registration).
 */
router.post('/devices/register', async (req, res) => {
  const hub = getHub();
  if (!hub) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Cross-platform hub not available', { status: 503 });
  }

  const { deviceId, platform, deviceName, capabilities } = req.body;
  if (!deviceId || !platform) {
    return apiResponse.fail(res, 'INVALID_ARGUMENT', 'deviceId and platform required', { status: 400 });
  }

  try {
    const device = hub.registerDevice({
      deviceId,
      platform,
      userId: String(req.user.id),
      deviceName,
      capabilities,
    });
    apiResponse.success(res, device);
  } catch (err) {
    apiResponse.fail(res, 'INVALID_ARGUMENT', err.message, { status: 400 });
  }
});

/**
 * DELETE /api/cross-platform/devices/:deviceId
 * Unregister a device.
 */
router.delete('/devices/:deviceId', (req, res) => {
  const hub = getHub();
  if (!hub) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Cross-platform hub not available', { status: 503 });
  }

  hub.unregisterDevice(req.params.deviceId);
  apiResponse.success(res, null, { message: 'Device unregistered' });
});

/**
 * GET /api/cross-platform/sessions
 * List active sessions.
 */
router.get('/sessions', (req, res) => {
  const hub = getHub();
  if (!hub) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Cross-platform hub not available', { status: 503 });
  }

  // Return session IDs and metadata (not full state)
  const sessions = [];
  if (hub._sessions) {
    for (const [id, session] of hub._sessions) {
      sessions.push({
        sessionId: id,
        version: session.version,
        lastModified: session.lastModified,
        modifiedBy: session.modifiedBy,
      });
    }
  }
  apiResponse.success(res, sessions);
});

/**
 * GET /api/cross-platform/sessions/:sessionId
 * Get session state.
 */
router.get('/sessions/:sessionId', (req, res) => {
  const hub = getHub();
  if (!hub) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Cross-platform hub not available', { status: 503 });
  }

  const session = hub.getSession(req.params.sessionId);
  if (!session) {
    return apiResponse.fail(res, 'MODEL_NOT_FOUND', 'Session not found', { status: 404 });
  }

  apiResponse.success(res, session);
});

/**
 * POST /api/cross-platform/notify
 * Send a cross-platform notification.
 */
router.post('/notify', (req, res) => {
  const server = getSyncServer();
  const { title, body, data } = req.body;

  if (!title) {
    return apiResponse.fail(res, 'INVALID_ARGUMENT', 'title required', { status: 400 });
  }

  // The target is the caller's own other devices. Taking userId from the body
  // let any authenticated account push notifications into another account's
  // device set.
  if (server) {
    server.notifyUser(String(req.user.id), title, body, data || {});
    apiResponse.success(res, null, { message: 'Notification sent' });
  } else {
    apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Sync server not available', { status: 503 });
  }
});

/**
 * POST /api/cross-platform/broadcast
 * Broadcast a message to all connected clients.
 *
 * Admin only: this reaches every authenticated user's devices, not just the
 * caller's, so it is not a per-user operation.
 */
router.post('/broadcast', adminMiddleware, (req, res) => {
  const server = getSyncServer();
  if (!server) {
    return apiResponse.fail(res, 'SERVICE_UNAVAILABLE', 'Sync server not available', { status: 503 });
  }

  server.broadcast(req.body);
  apiResponse.success(res, null, { message: 'Broadcast sent' });
});

/**
 * POST /api/cross-platform/start-platform
 * Start another platform (cross-platform launch).
 */
router.post('/start-platform', async (req, res) => {
  const { startPlatform } = require('../services/crossPlatform/crossLauncher');
  const { platform } = req.body;

  if (!platform) {
    return apiResponse.fail(res, 'INVALID_ARGUMENT', 'platform required', { status: 400 });
  }

  const result = await startPlatform(platform);
  if (result.success) {
    apiResponse.success(res, { pid: result.pid }, { message: `${platform} started` });
  } else {
    apiResponse.fail(res, 'INTERNAL', result.error, { status: 500 });
  }
});

/**
 * POST /api/cross-platform/start-all
 * Start all platforms.
 */
router.post('/start-all', async (req, res) => {
  const { startMultiple } = require('../services/crossPlatform/crossLauncher');
  const results = await startMultiple(['backend', 'web', 'desktop']);
  apiResponse.success(res, results);
});

/**
 * GET /api/cross-platform/status-all
 * Get status of all platforms.
 */
router.get('/status-all', async (req, res) => {
  const { getPlatformStatus } = require('../services/crossPlatform/crossLauncher');
  const status = await getPlatformStatus();
  apiResponse.success(res, status);
});

module.exports = router;
