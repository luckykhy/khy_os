'use strict';

/**
 * Express wrapper for the CC-Switch provider-card API.
 *
 * The monolith Express server (server.js) mounts this router at /api/cc-switch.
 * It adapts the raw-http dispatcher (services/ccSwitch/apiHandlers.js) onto
 * Express's req/res so both servers share one implementation. Auth middleware
 * is applied at the mount point (same as /api/proxy-subscriptions).
 */

const express = require('express');

const router = express.Router();

// Re-inject HTTP deps from Express's own send helpers.
const api = require('../services/ccSwitch/apiHandlers');

router.all('*', (req, res, next) => {
  const { sendJson, sendError, parseBody } = _expressAdapters(res, req);
  api.setCcSwitchHttpDeps({
    sendJson,
    sendError,
    parseBody,
    authenticateRequest: () => Promise.resolve(req.authContext || { ok: true, user: req.user || null }),
  });
  const pathname = req.baseUrl ? `${req.baseUrl}${req.path}` : req.originalUrl;
  api
    .handleCcSwitchApi(req, res, pathname)
    .then(() => {
      /* response already sent */
    })
    .catch((err) => {
      try {
        res.status(500).json({ success: false, message: (err && err.message) || String(err) });
      } catch {
        /* ignore */
      }
    });
});

function _expressAdapters(res, req) {
  return {
    sendJson: (status, data) => {
      try {
        res.status(status).json(data);
      } catch {
        /* ignore */
      }
    },
    sendError: (status, message) => {
      try {
        res.status(status).json({ success: false, message });
      } catch {
        /* ignore */
      }
    },
    parseBody: () =>
      new Promise((resolve) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
        req.on('error', () => resolve({}));
      }),
  };
}

module.exports = router;
