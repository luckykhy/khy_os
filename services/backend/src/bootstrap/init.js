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

const { checkpoint } = require('./startupProfiler');
const state = require('./state');

let _promise = null;
let _dbHealthInitPromise = null;

/**
 * Get the in-flight deferred dbHealthService.init() promise (or null once it
 * settled / when deferral is disabled). Lets shutdown paths await a still
 * running background integrity check instead of racing it.
 * @returns {Promise<void>|null}
 */
function getDbHealthInitPromise() {
  return _dbHealthInitPromise;
}

/**
 * Run all one-time initialization steps.
 * Memoized: first call creates the promise, subsequent calls return it.
 * @param {{ machineReadable?: boolean }} [options]
 * @returns {Promise<void>}
 */
function init(options = {}) {
  if (_promise) {
    return _promise;
  }
  _promise = _doInit(options);
  return _promise;
}

async function _doInit(options) {
  checkpoint('init:start');

  // 1. Load .env from canonical env file
  try {
    const envPath = process.env.KHY_ENV_FILE
      ? path.resolve(process.env.KHY_ENV_FILE)
      : path.resolve(process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..'), '.env');
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
    const userEnvPath = (() => {
      try {
        return path.join(require('../utils/dataHome').getDataHome(), '.env');
      } catch {
        return path.join(os.homedir(), '.khy', '.env');
      }
    })();
    require('dotenv').config({ path: userEnvPath, override: false });
  } catch {
    // Overlay is optional; absence is the common case.
  }

  // 1.15 Expand `{env:VAR}` cross-references now that BOTH env layers are loaded
  //      (canonical .env + ~/.khy/.env overlay). Must run after the overlay so a
  //      placeholder can point at a variable defined in either file. dotenv does
  //      not do this itself — without it `RELAY_API_KEY={env:STEPFUN_API_KEY}`
  //      ships literally as `Bearer {env:STEPFUN_API_KEY}` → 401 on every relay call.
  try {
    const { expandEnvPlaceholders } = require('./expandEnvPlaceholders');
    expandEnvPlaceholders(process.env);
  } catch {
    /* expansion is best-effort; raw values still flow through */
  }

  // 1.3-1.7 并行执行 5 个非关键初始化步骤（原串行 .then() 链，改为 Promise.allSettled）
  //          每个步骤独立 try/catch，互不阻塞，减少 ~200-500ms 串行等待。
  await Promise.allSettled([
    (async () => {
      try {
        const { ensureProxyCoreEnv } = require('./ensureProxyCoreEnv');
        ensureProxyCoreEnv({
          log: (m) => {
            try {
              console.warn(`  ⚠ ${m}`);
            } catch {
              /* ignore */
            }
          },
        });
      } catch {
        /* ensureProxyCoreEnv not available */
      }
    })(),
    (async () => {
      try {
        const { ensureJwtSecret } = require('./ensureAuthSecret');
        ensureJwtSecret({
          log: (m) => {
            try {
              console.warn(`  ⚠ ${m}`);
            } catch {
              /* ignore */
            }
          },
        });
      } catch {
        /* ensureAuthSecret not available */
      }
    })(),
    (async () => {
      try {
        const proxyConfig = require('../services/proxyConfigService');
        proxyConfig.initFromConfig();
      } catch {
        /* proxy config is optional */
      }
    })(),
    (async () => {
      try {
        const backendDir = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..');
        const appRegistry = require('../services/appRegistry');
        appRegistry.autoRegisterDev(backendDir);
      } catch {
        /* appRegistry not available */
      }
    })(),
    (async () => {
      try {
        const dynamicFreeModelService = require('../services/dynamicFreeModelService');
        dynamicFreeModelService.warmUp();
      } catch {
        /* dynamicFreeModelService not available */
      }
    })(),
  ]);

  // 2. Database health service initialization.
  //    Deferred by default (KHY_DB_HEALTH_DEFER=0 restores the legacy blocking
  //    await): the startup integrity check is pure defense — nothing in the
  //    boot path consumes its result — yet it serially opens and integrity-
  //    checks every known SQLite file (~100ms warm, growing with DB count and
  //    size) before the REPL input box is ready. Run it on the background tick
  //    instead and export the in-flight promise for shutdown/diagnostics.
  checkpoint('init:dbHealth:start');
  const _deferDbHealth = String(process.env.KHY_DB_HEALTH_DEFER ?? '1').trim() !== '0';
  try {
    const dbHealthService = require('../services/dbHealthService');
    const _initDbHealth = async () => {
      try {
        await dbHealthService.init({ silentConsole: options.machineReadable === true });
      } catch (err) {
        // Non-fatal: log and continue. Database health is defensive — if init fails,
        // the databases might still work, just without auto-healing.
        try {
          console.warn(`  ⚠ Database health service init failed: ${err.message}`);
        } catch {
          /* ignore */
        }
      } finally {
        checkpoint('init:dbHealth:done');
      }
    };
    if (_deferDbHealth) {
      _dbHealthInitPromise = Promise.resolve().then(_initDbHealth);
    } else {
      await _initDbHealth();
    }
  } catch {
    /* dbHealthService not available — it is defensive only */
  }

  // 8. Mark as initialized
  state.set('initialized', true);

  checkpoint('init:done');
}

/**
 * Check if init has completed without triggering it.
 */
function isComplete() {
  return state.get('initialized');
}

module.exports = { init, isComplete, getDbHealthInitPromise };
