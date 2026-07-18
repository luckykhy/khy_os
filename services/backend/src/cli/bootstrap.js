/**
 * CLI Bootstrap — initialize environment and database for CLI commands.
 * Mirrors the startup sequence in server.js but without HTTP/WebSocket/cron.
 */
const path = require('path');

let _initialized = false;
let _sequelize = null;

async function bootstrap({ syncSchema = false, silent = false } = {}) {
  if (_initialized) return { sequelize: _sequelize };

  // Delegate to bootstrap pipeline if available (env, defaults, shutdown handlers)
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
      require('dotenv').config({ path: path.join(os.homedir(), '.khy', '.env'), override: false });
    } catch { /* overlay optional */ }
    const { applyEnvDefaults } = require('../config/env');
    applyEnvDefaults();
  }

  // 3. Initialize database (auto-detect PG vs SQLite)
  //    Mute database.js module-level console output in silent mode
  const origLog = console.log;
  const origWarn = console.warn;
  if (silent) {
    console.log = () => {};
    console.warn = () => {};
  }
  const db = require('../config/database');
  _sequelize = await db.initDatabase();
  if (silent) {
    console.log = origLog;
    console.warn = origWarn;
  }

  // 3.5 Auto-migrate DB schema once per app version.
  // Keeps CLI/database features healthy after upgrades without manual commands.
  try {
    const { runAutoDbMigration } = require('../bootstrap/dbAutoMigration');
    await runAutoDbMigration({ silent, reason: 'cli-bootstrap' });
  } catch {
    // Non-critical: command handlers can still run with best-effort schema.
  }

  // 3.6 Auto-repair config and reset gateway if needed (post-upgrade maintenance).
  // Repairs manually corrupted .env files and suggests gateway reset when config is broken.
  try {
    const { repairConfigIfNeeded } = require('../services/configRepairService');
    const { maybeResetGateway } = require('../services/gatewayResetService');

    // 1. Repair config if corrupted
    const repairResult = await repairConfigIfNeeded();
    if (repairResult.repaired && !silent) {
      console.log(`  配置文件已修复 (移除 ${repairResult.removed} 行)`);
      if (repairResult.backupPath) {
        console.log(`  备份: ${path.basename(repairResult.backupPath)}`);
      }
    }

    // 2. Check if gateway reset is needed
    const resetResult = await maybeResetGateway({
      interactive: false, // 非交互模式,只检查不询问
      configCorrupted: repairResult.repaired || false,
    });
    if (resetResult.reset && !silent) {
      console.log(`  网关配置已重置: ${resetResult.reason}`);
    } else if (resetResult.reason && !silent) {
      // 建议重置但未执行
      console.warn(`  建议运行 'khy config reset' 重置网关配置`);
    }
  } catch {
    // Non-critical: config repair/reset failures don't block bootstrap.
  }

  // 3.7 Auto-heal corrupted/missing runtime source files (self-heal).
  // Covers goal trigger points ① khy CLI startup ④ server deployment ⑤ khy restart
  // ⑥ computer restart — all funnel through bootstrap(). Restores individual missing
  // files or spot-corrupted sources (e.g. a function name with a dropped letter) from
  // the bundled encrypted pristine snapshot, per-file by SHA-256 manifest — NOT a
  // whole-tree overwrite. Throttled by snapshot fingerprint + time window
  // (KHY_SOURCE_HEAL_INTERVAL_HOURS, default 24h) so it costs ~1ms on the healthy
  // steady state; a fingerprint change (= pip/npm update installed new sources) forces
  // an immediate re-check, which is exactly trigger point ③. Guarded by version-match
  // + too-many-changes rails so it NEVER mass-reverts on drift (recommends `khy restore`
  // instead). Fail-soft: self-heal never blocks or fails bootstrap.
  try {
    const { runStartupHeal } = require('../services/sourceHealService');
    const r = runStartupHeal({ reason: 'cli-bootstrap', silent });
    if (r && r.healed > 0 && !silent) {
      console.log(`  源码自愈: 修复 ${r.healed} 个文件`);
    }
  } catch {
    // Non-critical: self-heal never blocks bootstrap.
  }

  // 4. Register all model associations
  require('../models');

  // 5. Verify connection
  try {
    await _sequelize.authenticate();
    if (!silent) {
      const mode = process.env.DB_MODE || 'unknown';
      console.log(`  Database connected (${mode})`);
    }
  } catch (err) {
    if (!silent) {
      console.error('  Database connection failed:', err.message);
    }
  }

  // 6. Sync schema if requested
  if (syncSchema) {
    try {
      await _sequelize.sync({ force: false });
      if (!silent) console.log('  Schema synchronized');
    } catch (err) {
      if (!silent) console.error('  Schema sync failed:', err.message);
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
  if (_muted) return;
  _muted = true;
  _origLog = console.log;
  _origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
}

function restoreDbLogs() {
  if (!_muted) return;
  _muted = false;
  console.log = _origLog;
  console.warn = _origWarn;
}

module.exports = { bootstrap, isInitialized, muteDbLogs, restoreDbLogs };
