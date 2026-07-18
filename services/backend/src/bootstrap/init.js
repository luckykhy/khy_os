/**
 * init() — memoized, once-only process-level initialization.
 *
 * Runs exactly once per process regardless of how many times it is called.
 * Replaces the inline environment setup scattered across khyquant.js and
 * bootstrap.js.
 *
 * Each step is individually try/caught so a single failure does not block
 * the entire initialization pipeline.
 *
 * Usage:
 *   const { init } = require('./init');
 *   await init(); // safe to call multiple times — returns same promise
 */

const path = require('path');
const state = require('./state');
const { checkpoint } = require('./startupProfiler');

let _promise = null;

/**
 * Run all one-time initialization steps.
 * Memoized: first call creates the promise, subsequent calls return it.
 * @returns {Promise<void>}
 */
function init() {
  if (_promise) return _promise;
  _promise = _doInit();
  return _promise;
}

async function _doInit() {
  checkpoint('init:start');

  // 1. Load .env from canonical env file
  try {
    const envPath = process.env.KHY_ENV_FILE
      ? path.resolve(process.env.KHY_ENV_FILE)
      : path.resolve(
        process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..'),
        '.env'
      );
    require('dotenv').config({ path: envPath });
  } catch {
    // dotenv not available or .env missing — proceed with process.env as-is
  }

  // 1.2 Load the user-level persistent env overlay (~/.khy/.env). This is where
  //     `khy claude adopt-env` stores the reused Claude Code credentials
  //     (ANTHROPIC_BASE_URL relay + ANTHROPIC_AUTH_TOKEN, etc.). It lives OUTSIDE
  //     site-packages, so `pip install -U` never overwrites it — configure once,
  //     every future upgrade still works. Loaded with override:false so a real
  //     shell env always wins; it only fills vars that are otherwise unset, which
  //     reproduces the normal env code path (source-aware AUTH_TOKEN → Bearer).
  try {
    const os = require('os');
    const userEnvPath = path.join(os.homedir(), '.khy', '.env');
    require('dotenv').config({ path: userEnvPath, override: false });
  } catch {
    // Overlay is optional; absence is the common case.
  }

  // 1.3 「装完即用」自动配置代理内核出站门(KHY_PROXY_CORE)。安装后首启把它一次性播种进上面刚加载的
  //     升级安全 overlay(~/.khy/.env),让用户选中 raw 协议节点时不再撞「请设 KHY_PROXY_CORE=1」那道
  //     门、无需手改 shell profile。尊重用户显式值(真实 env / .env / overlay 已设过含 =0 → 不覆盖),
  //     幂等(播种一次后读到「已设」即跳过)。meta 门 KHY_PROXY_CORE_AUTOSEED(默认开)关 → 逐字节回退。
  //     fail-soft:自播种绝不阻断启动。必须在 1.2 加载 overlay 之后运行(才知道 overlay 里有没有)。
  try {
    const { ensureProxyCoreEnv } = require('./ensureProxyCoreEnv');
    ensureProxyCoreEnv({ log: (m) => { try { console.warn(`  ⚠ ${m}`); } catch { /* ignore */ } } });
  } catch {
    // ensureProxyCoreEnv not available — user can still set KHY_PROXY_CORE manually
  }

  // 1.5 Ensure the JWT signing secret exists (self-provision + persist if
  //     the canonical .env lacks it). Must run before any auth path reads
  //     process.env.JWT_SECRET. Single source of truth for the secret.
  try {
    const { ensureJwtSecret } = require('./ensureAuthSecret');
    ensureJwtSecret({ log: (m) => { try { console.warn(`  ⚠ ${m}`); } catch { /* ignore */ } } });
  } catch {
    // ensureAuthSecret not available — login will report a clear error itself
  }

  // 2. Apply environment defaults (DB_TYPE, PORT, etc.)
  try {
    const { applyEnvDefaults } = require('../config/env');
    applyEnvDefaults();
  } catch {
    // config/env not available — non-critical
  }

  // 2.5 Initialize saved proxy settings for all runtime modes.
  // This ensures non-REPL commands (e.g. `khy gateway ...`) also honor
  // previously configured Clash/HTTP/SOCKS proxy preferences.
  try {
    const proxyConfig = require('../services/proxyConfigService');
    proxyConfig.initFromConfig();
  } catch {
    // proxy config is optional — continue with direct network path
  }

  // 3. Ensure KHYQUANT_ROOT is set
  if (!process.env.KHYQUANT_ROOT) {
    process.env.KHYQUANT_ROOT = path.resolve(__dirname, '../..');
  }

  // 4. Register graceful shutdown handlers
  try {
    const { registerShutdownHandlers } = require('./shutdown');
    registerShutdownHandlers();
  } catch {
    // shutdown module not available — non-critical
  }

  // 5. Apply custom CA certificates (must happen before first TLS handshake)
  try {
    if (process.env.NODE_EXTRA_CA_CERTS) {
      const fs = require('fs');
      const certPath = process.env.NODE_EXTRA_CA_CERTS;
      if (fs.existsSync(certPath)) {
        // Node.js respects NODE_EXTRA_CA_CERTS natively; just verify the file
        // exists so we can warn early if it's missing.
      }
    }
  } catch {
    // CA cert check is non-critical
  }

  // 6. Auto-register khyquant in app registry (dev mode)
  try {
    const backendDir = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..');
    const appRegistry = require('../services/appRegistry');
    appRegistry.autoRegisterDev(backendDir);
  } catch {
    // appRegistry not available or registration failed — non-critical
  }

  // 7. Mark as initialized
  state.set('initialized', true);

  checkpoint('init:done');
}

/**
 * Check if init has completed without triggering it.
 */
function isComplete() {
  return state.get('initialized');
}

module.exports = { init, isComplete };
