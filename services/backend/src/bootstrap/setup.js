/**
 * setup() — per-session initialization.
 *
 * Runs once per CLI session (not per-process).  Handles Node version
 * validation, config checks, optional DB pre-check, and migrations.
 *
 * In khy (lightweight) mode, DB and migrations are skipped entirely.
 *
 * Usage:
 *   const { setup } = require('./setup');
 *   await setup({ mode: 'khy', silent: true });
 */

const path = require('path');
const fs = require('fs');
const state = require('./state');
const { checkpoint } = require('./startupProfiler');

let _done = false;

/**
 * Run session-level setup.
 * @param {{ mode?: string, silent?: boolean }} options
 */
async function setup(options = {}) {
  if (_done) return;

  const { mode = 'khyquant', silent = false } = options;
  checkpoint('setup:start');

  state.set('mode', mode);

  // 1. Node.js version check
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1];
  if (!nodeVersion || parseInt(nodeVersion, 10) < 18) {
    if (!silent) {
      process.stderr.write(
        '\n  Warning: khy OS requires Node.js >= 18. ' +
        `Current: ${process.version}\n\n`
      );
    }
  }

  // 2. Validate critical config files
  const backendRoot = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..');
  const envPath = path.join(backendRoot, '.env');
  if (!fs.existsSync(envPath) && !silent) {
    process.stderr.write(
      '  Warning: .env not found. Run `khy setup` first.\n'
    );
  }

  // 3. In full mode: pre-check database connection
  if (mode === 'khyquant') {
    try {
      const db = require('../config/database');
      if (db.initDatabase) {
        const sequelize = await db.initDatabase();
        if (sequelize) {
          await sequelize.authenticate();
          state.set('dbConnected', true);
          state.set('dbMode', process.env.DB_MODE || null);
        }
      }
    } catch {
      // DB not available — server.js will retry with full logic
      state.set('dbConnected', false);
    }

    // 3.5 Run version-based automatic DB schema migration.
    // This is lightweight and idempotent, and avoids requiring manual `db seed`.
    try {
      if (state.get('dbConnected')) {
        const { runAutoDbMigration } = require('./dbAutoMigration');
        await runAutoDbMigration({ silent, reason: 'setup-khyquant' });
      }
    } catch {
      // Auto migration failure is non-critical; runtime may still proceed.
    }

    // 4. Run migrations (full mode only)
    try {
      const { runMigrations } = require('./migrations');
      await runMigrations();
    } catch {
      // Migration failure is non-critical
    }
  }

  // 5. First-run: idempotently register khyosMarkdown into the OS "Open With"
  //    menu (gated + sentinel-guarded + fire-and-forget). Never blocks startup;
  //    self-contained fail-soft, guarded again here for defence in depth.
  try {
    require('../services/mdEditorRegister').ensureMdRegistered();
  } catch { /* auto-register is best-effort; never block startup */ }

  // 6. Mark session as ready
  state.set('sessionReady', true);
  _done = true;

  checkpoint('setup:done');
}

module.exports = { setup };
