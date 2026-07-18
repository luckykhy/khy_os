/**
 * Migration System — version-driven idempotent migrations.
 *
 * Each migration runs once per version bump.  State is persisted to
 * ~/.khyquant/bootstrap_version.json (via dataHome utility).
 *
 * Migrations are idempotent and individually try/caught: a single failure
 * does not block startup or prevent later migrations from running.
 *
 * Usage:
 *   const { runMigrations } = require('./migrations');
 *   const result = await runMigrations();
 *   // result = { ran: ['1.0.0', '1.0.1'], skipped: [] }
 */

const fs = require('fs');
const path = require('path');

/**
 * Compare two semver strings.  Returns -1, 0, or 1.
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

// ── Migration definitions ────────────────────────────────────────────────
// Each migration must be idempotent (safe to re-run).

const MIGRATIONS = [
  {
    version: '1.0.0',
    description: 'Initialize data directory structure',
    up: async () => {
      const { getDataDir } = require('../utils/dataHome');
      // Ensure standard subdirectories exist
      getDataDir('cache');
      getDataDir('logs');
      getDataDir('conversations');
      getDataDir('backups');
    },
  },
  {
    version: '1.0.1',
    description: 'Clean up stale cache files',
    up: async () => {
      const { getDataDir } = require('../utils/dataHome');
      const cacheDir = getDataDir('cache');
      try {
        const now = Date.now();
        const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const entries = fs.readdirSync(cacheDir);
        for (const entry of entries) {
          const full = path.join(cacheDir, entry);
          try {
            const stat = fs.statSync(full);
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
              fs.unlinkSync(full);
            }
          } catch { /* skip individual file errors */ }
        }
      } catch { /* cache dir may not exist yet */ }
    },
  },
];

// ── Version file I/O ─────────────────────────────────────────────────────

function _getVersionFilePath() {
  const { getDataHome } = require('../utils/dataHome');
  return path.join(getDataHome(), 'bootstrap_version.json');
}

function _readVersionFile() {
  try {
    const raw = fs.readFileSync(_getVersionFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: '0.0.0', migrations: [] };
  }
}

function _writeVersionFile(data) {
  try {
    fs.writeFileSync(_getVersionFilePath(), JSON.stringify(data, null, 2));
  } catch { /* non-critical */ }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Run all pending migrations.
 * @returns {Promise<{ ran: string[], skipped: string[] }>}
 */
async function runMigrations() {
  const state = require('./state');
  const versionData = _readVersionFile();
  const currentVersion = versionData.version || '0.0.0';

  const pending = MIGRATIONS
    .filter((m) => compareVersions(m.version, currentVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version));

  if (pending.length === 0) {
    state.set('bootstrapVersion', currentVersion);
    return { ran: [], skipped: [] };
  }

  const ran = [];
  const skipped = [];

  for (const migration of pending) {
    try {
      await migration.up();
      ran.push(migration.version);
      versionData.migrations = versionData.migrations || [];
      versionData.migrations.push({
        version: migration.version,
        description: migration.description,
        appliedAt: new Date().toISOString(),
      });
      versionData.version = migration.version;
    } catch (err) {
      skipped.push(migration.version);
      try {
        const logger = require('../utils/logger');
        logger.warn(`Migration ${migration.version} failed`, {
          description: migration.description,
          error: err.message,
        });
      } catch { /* logger not available */ }
    }
  }

  _writeVersionFile(versionData);
  state.set('bootstrapVersion', versionData.version);

  return { ran, skipped };
}

/**
 * Get the current bootstrap version without running migrations.
 */
function getCurrentVersion() {
  return _readVersionFile().version || '0.0.0';
}

module.exports = { runMigrations, getCurrentVersion, MIGRATIONS, compareVersions };
