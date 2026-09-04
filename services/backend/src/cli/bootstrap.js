/**
 * CLI Bootstrap — initialize environment and database for CLI commands.
 * Mirrors the startup sequence in server.js but without HTTP/WebSocket/cron.
 */
const path = require('path');

let _initialized = false;
let _sequelize = null;

async function bootstrap({ syncSchema = false, silent = false, onProgress = null } = {}) {
  if (_initialized) {
    return { sequelize: _sequelize };
  }

  // When the TUI is running a CLI command, show progress even if silent=true
  // because the TUI has cleared its frame and the user would see nothing.
  let _tuiCli = false;
  try {
    _tuiCli = require('./formatters').isTuiRunningCliCommand();
  } catch {
    /* ignore */
  }
  const _effectiveSilent = silent && !_tuiCli && !onProgress;

  const _emit = (msg) => {
    if (onProgress) {
      onProgress(msg);
    } else if (!_effectiveSilent) {
      console.log(msg);
    }
  };

  // Delegate to bootstrap pipeline if available (env, defaults, shutdown handlers)
  _emit('初始化环境...');
  try {
    const { init } = require('../bootstrap/init');
    await init();
  } catch {
    // Fallback: inline env loading if bootstrap module not available
    const envPath = process.env.KHY_ENV_FILE
      ? path.resolve(process.env.KHY_ENV_FILE)
      : path.resolve(__dirname, '../../.env');
    require('dotenv').config({ path: envPath });
    // User-level persistent overlay (~/.khy/.env) — see bootstrap/init.js step 1.2.
    // Where `khy claude adopt-env` persists reused Claude Code credentials; survives
    // pip upgrades. override:false so real shell env wins.
    try {
      const os = require('os');
      require('dotenv').config({
        path: (() => {
          try {
            return path.join(require('../utils/dataHome').getDataHome(), '.env');
          } catch {
            return path.join(os.homedir(), '.khy', '.env');
          }
        })(),
        override: false,
      });
    } catch {
      /* overlay optional */
    }
    const { applyEnvDefaults } = require('../config/env');
    applyEnvDefaults();
  }

  // 3. Initialize database (auto-detect PG vs SQLite)
  //    Mute database.js module-level console output in silent mode
  _emit('初始化数据库...');
  const origLog = console.log;
  const origWarn = console.warn;
  if (silent && !_tuiCli) {
    console.log = () => {};
    console.warn = () => {};
  }
  const db = require('../config/database');
  _sequelize = await db.initDatabase();
  if (silent && !_tuiCli) {
    console.log = origLog;
    console.warn = origWarn;
  }

  // 3.5 Auto-migrate DB schema once per app version.
  // Keeps CLI/database features healthy after upgrades without manual commands.
  try {
    const { runAutoDbMigration } = require('../bootstrap/dbAutoMigration');
    await runAutoDbMigration({ silent: silent && !onProgress, reason: 'cli-bootstrap' });
  } catch {
    // Non-critical: command handlers can still run with best-effort schema.
  }

  // 3.6 Auto-repair config and reset gateway if needed (post-upgrade maintenance).
  // Fire-and-forget: config repair doesn't block command execution.
  Promise.resolve()
    .then(async () => {
      try {
        const { repairConfigIfNeeded } = require('../services/configRepairService');
        const { maybeResetGateway } = require('../services/gatewayResetService');

        const repairResult = await repairConfigIfNeeded();
        if (repairResult.repaired && !silent) {
          console.log(`  配置文件已修复 (移除 ${repairResult.removed} 行)`);
        }

        const resetResult = await maybeResetGateway({
          interactive: false,
          configCorrupted: repairResult.repaired || false,
        });
        if (resetResult.reset && !silent) {
          console.log(`  网关配置已重置: ${resetResult.reason}`);
        } else if (resetResult.reason && !silent) {
          console.warn(`  建议运行 'khy config reset' 重置网关配置`);
        }
      } catch {
        // Non-critical: config repair/reset failures don't block bootstrap.
      }
    })
    .catch(() => {});

  // 3.7 Auto-heal corrupted/missing runtime source files (self-heal).
  // Fire-and-forget: self-heal is throttled (24h) and doesn't block command execution.
  Promise.resolve()
    .then(() => {
      try {
        const { runStartupHeal } = require('../services/sourceHealService');
        const r = runStartupHeal({ reason: 'cli-bootstrap', silent });
        if (r && r.healed > 0 && !silent) {
          console.log(`  源码自愈: 修复 ${r.healed} 个文件`);
        }
      } catch {
        // Non-critical: self-heal never blocks bootstrap.
      }
    })
    .catch(() => {});

  // 4. Register all model associations
  _emit('注册数据模型...');
  require('../models');

  // 5. Verify connection
  _emit('验证数据库连接...');
  try {
    await _sequelize.authenticate();
    _emit(`数据库已连接 (${process.env.DB_MODE || 'unknown'})`);
  } catch (err) {
    if (!silent) {
      console.error('  Database connection failed:', err.message);
    }
  }

  // 6. Sync schema if requested
  if (syncSchema) {
    _emit('同步数据库结构...');
    try {
      await _sequelize.sync({ force: false });
      _emit('数据库结构已同步');
    } catch (err) {
      if (!silent) {
        console.error('  Schema sync failed:', err.message);
      }
    }
  }

  _initialized = true;
  return { sequelize: _sequelize };
}

function isInitialized() {
  return _initialized;
}

/**
 * Suppress database.js module-level console output during first require.
 * Call before any require() that transitively loads database.js or models.
 * Safe to call multiple times (no-op after first restore).
 */
let _muted = false;
let _origLog, _origWarn;

function muteDbLogs() {
  if (_muted) {
    return;
  }
  _muted = true;
  _origLog = console.log;
  _origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
}

function restoreDbLogs() {
  if (!_muted) {
    return;
  }
  _muted = false;
  console.log = _origLog;
  console.warn = _origWarn;
}

module.exports = { bootstrap, isInitialized, muteDbLogs, restoreDbLogs };
