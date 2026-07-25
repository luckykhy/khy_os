/**
 * Web Relay Adapter — local HTTP + WebSocket server that acts as
 * a manual AI relay bridge. The user copies prompts from the page,
 * pastes them into any AI web interface, and submits the response back.
 *
 * Always available as a last-resort adapter.
 */
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const { buildRelayHTML } = require('../relayPage');
const { requireFeatureAccess } = require('../../authGuard');
const {
  buildProxyRelayFeatureLabel,
  getFeatureFamilyPrefix,
  joinFeatureKey,
} = require('../../featureKeyBuilder');
const { buildSuccess, buildFailure } = require('./_responseBuilder');

const DEFAULT_PORT = 9099;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_CLIENT_WAIT_MS = 30 * 1000; // no browser connected fast-fail window

let _server = null;
let _wss = null;
let _port = null;
let _pending = null; // { id, text, resolve, reject, timer }
let _token = null;   // per-session auth token

/**
 * Ensure the relay server is running.
 * Lazy-starts on first call; subsequent calls are no-ops.
 */
function ensureServer() {
  if (_server) return Promise.resolve(_port);

  const rawPort = parseInt(process.env.GATEWAY_RELAY_PORT, 10) || DEFAULT_PORT;
  const port = (rawPort > 0 && rawPort <= 65535) ? rawPort : DEFAULT_PORT;

  // Generate a per-session token for WS auth
  if (!_token) _token = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(buildRelayHTML(_port || port, _token));
        return;
      }
      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', pending: !!_pending }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    const wss = new WebSocket.Server({
      server: srv,
      maxPayload: 1024 * 1024, // 1 MB limit
      verifyClient: ({ req }) => {
        // Require token via query param: ws://localhost:PORT/?token=XXX
        const url = new URL(req.url, `http://${req.headers.host}`);
        return url.searchParams.get('token') === _token;
      },
    });

    // Declare settle helpers before registering event handlers to avoid
    // ReferenceError if wss emits 'error' synchronously during construction.
    let settled = false;
    const settleResolve = (resolvedPort) => {
      if (settled) return;
      settled = true;
      _port = resolvedPort;
      _server = srv;
      _wss = wss;
      resolve(resolvedPort);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      try { wss.close(); } catch { /* ignore */ }
      try {
        srv.close(() => reject(err));
      } catch {
        reject(err);
      }
    };

    wss.on('error', (err) => {
      // Surface bind/startup errors through ensureServer() promise path.
      settleReject(err);
    });

    wss.on('connection', (ws) => {
      // If there's a pending prompt, send it immediately to the new client
      if (_pending) {
        ws.send(JSON.stringify({
          type: 'prompt',
          id: _pending.id,
          text: _pending.text,
          timestamp: new Date().toISOString(),
        }));
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'response' && msg.id && msg.text) {
            // Match to pending request
            if (_pending && _pending.id === msg.id) {
              clearTimeout(_pending.timer);
              _pending.resolve(msg.text);
              _pending = null;

              // Acknowledge all connected clients
              broadcast(wss, { type: 'status', message: '回复已接收 ✓' });
            }
          }

          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch { /* ignore malformed messages */ }
      });
    });

    const bind = (targetPort, allowFallback) => {
      const onError = (err) => {
        const retryable = ['EADDRINUSE', 'EACCES', 'EPERM'].includes(err.code);
        if (allowFallback && retryable) {
          // Fall back to an ephemeral port if the configured port is blocked/occupied.
          bind(0, false);
          return;
        }
        settleReject(err);
      };

      srv.once('error', onError);
      srv.listen(targetPort, '127.0.0.1', () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        const resolvedPort = addr && typeof addr === 'object' ? addr.port : targetPort;
        settleResolve(resolvedPort);
      });
    };

    bind(port, true);
  });
}

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 */
function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

/**
 * Check if the relay adapter is available (always true — it's the fallback).
 */
function detect() {
  return true;
}

/**
 * Generate a response by relaying the prompt through the web page.
 * Starts the server if needed, broadcasts the prompt, waits for human response.
 */
async function generate(prompt, _options = {}) {
  const auth = requireFeatureAccess(
    joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), 'web'),
    buildProxyRelayFeatureLabel('web')
  );
  if (!auth.ok) {
    return buildFailure(auth.error, {
      adapter: 'web_relay',
      provider: 'web-relay',
      errorType: auth.errorType || 'auth',
      attempts: [{ provider: 'web-relay', success: false, error: auth.error }],
    });
  }

  let port;
  try {
    port = await ensureServer();
  } catch (err) {
    return buildFailure(`Web 中转服务不可用: ${err.message || err}`, {
      adapter: 'web_relay',
      provider: 'web-relay',
      errorType: 'network',
      attempts: [{ provider: 'web-relay', success: false, error: err.message || String(err) }],
    });
  }
  const timeoutMs = parseInt(process.env.GATEWAY_RELAY_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;
  const clientWaitMs = parseInt(process.env.GATEWAY_RELAY_CLIENT_WAIT, 10) || DEFAULT_CLIENT_WAIT_MS;

  // Cancel any existing pending request
  if (_pending) {
    clearTimeout(_pending.timer);
    _pending.reject(new Error('Superseded by new request'));
    _pending = null;
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  return new Promise((resolve, reject) => {
    let clientTimer = null;
    const timer = setTimeout(() => {
      _pending = null;
      resolve(buildFailure('中转超时 — 未在限定时间内收到回复', {
        adapter: 'web_relay',
        provider: 'web-relay',
        attempts: [{ provider: `web-relay (port ${port})`, success: false, error: 'timeout' }],
      }));
    }, timeoutMs);

    _pending = { id, text: prompt, resolve: onResponse, reject: onError, timer };

    function onResponse(text) {
      if (clientTimer) clearTimeout(clientTimer);
      resolve(buildSuccess(text, {
        adapter: 'web_relay',
        provider: 'web-relay',
        attempts: [{ provider: `web-relay (port ${port})`, success: true }],
      }));
    }

    function onError(err) {
      if (clientTimer) clearTimeout(clientTimer);
      resolve(buildFailure(err.message || '中转出错', {
        adapter: 'web_relay',
        provider: 'web-relay',
        attempts: [{ provider: `web-relay (port ${port})`, success: false, error: err.message }],
      }));
    }

    // Broadcast prompt to all connected browsers
    if (_wss) {
      broadcast(_wss, {
        type: 'prompt',
        id,
        text: prompt,
        timestamp: new Date().toISOString(),
      });
    }

    // UX guard: if no browser is connected, fail fast instead of looking frozen.
    if (!_wss || _wss.clients.size === 0) {
      clientTimer = setTimeout(() => {
        if (!_pending || _pending.id !== id) return;
        clearTimeout(timer);
        _pending = null;
        resolve(buildFailure('no_browser_client', {
          adapter: 'web_relay',
          provider: 'web-relay',
          errorType: 'network',
          attempts: [{ provider: `web-relay (port ${port})`, success: false, error: 'no_browser_client' }],
        }));
      }, Math.max(3000, clientWaitMs));
    }
  });
}

/**
 * Get relay server status.
 */
function getStatus() {
  const running = !!_server;
  const clients = _wss ? _wss.clients.size : 0;
  const timeoutMs = parseInt(process.env.GATEWAY_RELAY_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;
  return {
    name: 'Web 中转服务',
    type: 'relay',
    available: true, // always available as last resort
    detail: running
      ? `运行中 (http://localhost:${_port}) · ${clients} 个浏览器连接 · 超时 ${Math.round(timeoutMs / 60000)} 分钟`
      : '待命 — 需要时自动启动',
  };
}

/**
 * Get the relay server port (for display).
 */
function getPort() {
  return _port;
}

/**
 * Check if the server is currently running.
 */
function isRunning() {
  return !!_server;
}

/**
 * Get current connected browser client count.
 */
function getClientCount() {
  return _wss ? _wss.clients.size : 0;
}

/**
 * Cancel current pending relay request (used by Ctrl+C interruption).
 * @returns {boolean} true if a pending request was cancelled
 */
function cancelPending(reason = 'Cancelled by user') {
  if (!_pending) return false;
  clearTimeout(_pending.timer);
  const rej = _pending.reject;
  _pending = null;
  try { rej(new Error(reason)); } catch { /* ignore */ }
  try { if (_wss) broadcast(_wss, { type: 'status', message: '请求已取消' }); } catch { /* ignore */ }
  return true;
}

/**
 * Explicitly start the relay server (for `gateway relay` command).
 */
async function start() {
  const auth = requireFeatureAccess(
    joinFeatureKey(getFeatureFamilyPrefix('proxy', 'relay'), 'web'),
    buildProxyRelayFeatureLabel('web')
  );
  if (!auth.ok) throw new Error(auth.error);
  return ensureServer();
}

/**
 * Shut down the relay server.
 */
async function destroy() {
  if (_pending) {
    clearTimeout(_pending.timer);
    _pending.reject(new Error('Server shutting down'));
    _pending = null;
  }

  return new Promise((resolve) => {
    if (_wss) {
      _wss.clients.forEach((client) => client.terminate());
      _wss.close();
      _wss = null;
    }
    if (_server) {
      _server.close(() => {
        _server = null;
        _port = null;
        _token = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  detect,
  generate,
  getStatus,
  getPort,
  isRunning,
  getClientCount,
  cancelPending,
  start,
  destroy,
};
