/**
 * Auto DB Migration Runner
 *
 * Runs lightweight schema migration automatically on startup.
 * It tracks the last successful app version to avoid repeating
 * migration work on every boot.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

let _runPromise = null;

function compareVersions(a = '0.0.0', b = '0.0.0') {
  const pa = String(a || '0.0.0').split('.').map(v => parseInt(v, 10) || 0);
  const pb = String(b || '0.0.0').split('.').map(v => parseInt(v, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function resolveCurrentVersion() {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return String(process.env.npm_package_version || '0.0.0');
  }
}

function resolveStateFile() {
  if (process.env.KHY_DB_MIGRATION_STATE_FILE) {
    return path.resolve(process.env.KHY_DB_MIGRATION_STATE_FILE);
  }
  const candidates = [
    getLegacyDataHome(),
    getDataHome(),
    path.join(os.tmpdir(), 'khyquant'),
  ];
  const writable = candidates.find(isWritableDir) || candidates[candidates.length - 1];
  return path.join(writable, 'db_migration_state.json');
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {
      lastMigratedVersion: '0.0.0',
      updatedAt: null,
      history: [],
    };
  }
}

function writeState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

function isWritableDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, '.db_migration_probe');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function log(message, meta = {}) {
  try {
    const logger = require('../utils/logger');
    logger.info(message, meta);
  } catch {
    // logger may be unavailable in early bootstrap
  }
}

function warn(message, meta = {}) {
  try {
    const logger = require('../utils/logger');
    logger.warn(message, meta);
  } catch {
    // logger may be unavailable in early bootstrap
  }
}

async function _run({ silent = false, force = false, reason = 'startup' } = {}) {
  const autoEnabled = String(process.env.KHY_AUTO_DB_MIGRATE || 'true').toLowerCase() !== 'false';
  const alwaysRun = String(process.env.KHY_AUTO_DB_MIGRATE_ALWAYS || 'false').toLowerCase() === 'true';
  if (!autoEnabled && !force) {
    return { ran: false, skipped: true, reason: 'disabled' };
  }

  const currentVersion = resolveCurrentVersion();
  const stateFile = resolveStateFile();
  const state = readState(stateFile);
  const lastVersion = String(state.lastMigratedVersion || '0.0.0');
  const shouldRun = force || alwaysRun || compareVersions(currentVersion, lastVersion) > 0;

  if (!shouldRun) {
    return {
      ran: false,
      skipped: true,
      reason: 'up-to-date',
      currentVersion,
      lastVersion,
    };
  }

  if (!silent) {
    console.log(`Auto DB migration: ${lastVersion} -> ${currentVersion}`);
  }

  try {
    const seed = require('../../scripts/seed');
    await seed.ensureBaseTables();
    await seed.migrate();

    const now = new Date().toISOString();
    const nextState = {
      ...state,
      lastMigratedVersion: currentVersion,
      updatedAt: now,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        {
          from: lastVersion,
          to: currentVersion,
          at: now,
          reason,
        },
      ].slice(-50),
    };
    const persisted = writeState(stateFile, nextState);

    if (!silent) {
      console.log('Auto DB migration completed');
    }
    if (!persisted) {
      warn('Auto DB migration state persistence failed', { stateFile });
    }
    log('Auto DB migration completed', { from: lastVersion, to: currentVersion, reason });
    return { ran: true, from: lastVersion, to: currentVersion, stateFile, persisted };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err || 'unknown');
    if (!silent) {
      console.warn(`Auto DB migration failed: ${msg}`);
    }
    warn('Auto DB migration failed', { error: msg, reason, currentVersion, lastVersion });
    return { ran: false, skipped: false, error: msg, currentVersion, lastVersion };
  }
}

async function runAutoDbMigration(options = {}) {
  if (_runPromise) return _runPromise;
  _runPromise = _run(options).finally(() => {
    _runPromise = null;
  });
  return _runPromise;
}

module.exports = {
  runAutoDbMigration,
};
