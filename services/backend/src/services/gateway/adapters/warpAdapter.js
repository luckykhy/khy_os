/**
 * Warp Adapter — bridge Warp usage through authenticated clipboard relay.
 *
 * Warp currently does not expose a stable local chat API for this gateway, so
 * prompts are routed through the generic clipboard relay (transport only).
 *
 * Availability is STRICT: Warp is "available" only when it is locally installed
 * AND there is a genuine Warp login token on disk. The presence of a clipboard
 * tool (xclip/pbcopy) is merely the transport mechanism — it does NOT mean Warp
 * is installed or logged in, and must never gate availability.
 */
const clipboardRelayAdapter = require('./clipboardRelayAdapter');
const { buildSuccess, buildFailure } = require('./_responseBuilder');

let _available = null;
let _loginState = { installed: false, hasLogin: false, email: null };

/**
 * Probe for a genuine local Warp install + login (read-only, no pool writes).
 * Delegates to accountPool.detectWarpLocalLogin() which reuses the single-source
 * WARP_STORAGE_PATHS + ideDetector install paths.
 * @returns {{ installed: boolean, hasLogin: boolean, email: string|null }}
 */
function detectWarpLogin() {
  try {
    const pool = require('../../accountPool');
    if (typeof pool.detectWarpLocalLogin === 'function') {
      const r = pool.detectWarpLocalLogin() || {};
      return {
        installed: !!r.installed,
        hasLogin: !!r.hasLogin,
        email: r.email || null,
      };
    }
  } catch { /* fall through to "not detected" */ }
  return { installed: false, hasLogin: false, email: null };
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _loginState = detectWarpLogin();
  // Strict: installed AND logged in. Clipboard relay is transport, not a gate.
  _available = !!(_loginState.installed && _loginState.hasLogin);
  return _available;
}

async function listModels() {
  return [
    { id: 'warp-web', name: 'Warp Web Relay', isDefault: true, provider: 'warp', description: '' },
  ];
}

async function generate(prompt, options = {}) {
  const result = await clipboardRelayAdapter.generate(prompt, {
    ...options,
    service: 'warp',
  });

  if (!result || !result.success) {
    return buildFailure(result?.error || result?.content || 'warp relay failed', {
      adapter: 'warp',
      provider: 'Warp',
      errorType: result?.errorType || 'unknown',
      attempts: result?.attempts || [{ provider: 'Warp', success: false, error: result?.error || 'relay_failed' }],
    });
  }

  return buildSuccess(result.content, {
    adapter: 'warp',
    provider: 'Warp (relay)',
    model: 'warp-web',
    attempts: [{ provider: 'Warp', success: true }],
  });
}

function getStatus() {
  // Recompute synchronously so a stale `_available` cannot report a false
  // "available" after a logout/uninstall.
  detect(true);
  const clipboardReady = clipboardRelayAdapter.detect();
  let detail;
  if (_available) {
    detail = clipboardReady
      ? 'Warp 已登录（剪贴板中继可用）'
      : 'Warp 已登录，但剪贴板中继不可用 — 请安装 xclip/pbcopy';
  } else if (_loginState.installed) {
    detail = 'Warp 已安装，未检测到登录态 — 请先登录 Warp';
  } else {
    detail = '未检测到 Warp 安装';
  }
  return {
    name: 'Warp',
    type: 'warp',
    available: _available,
    transport: 'clipboard-relay',
    clipboardReady,
    detail,
  };
}

function destroy() {
  _available = null;
  _loginState = { installed: false, hasLogin: false, email: null };
}

module.exports = { detect, listModels, generate, getStatus, destroy };
