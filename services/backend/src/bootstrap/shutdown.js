/**
 * Graceful Shutdown — unified SIGTERM / SIGINT handler.
 *
 * Services register cleanup functions via addShutdownHook().
 * When a shutdown signal arrives, all hooks run in parallel with a timeout.
 *
 * Usage:
 *   const { addShutdownHook, registerShutdownHandlers } = require('./shutdown');
 *   addShutdownHook('db', async () => sequelize.close());
 *   registerShutdownHandlers(); // installs SIGTERM + SIGINT listeners
 */

const state = require('./state');

const _hooks = new Map(); // name → async () => void
let _registered = false;
let _shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 5000;
const FAILSAFE_TIMEOUT_MS = 8000;

/**
 * Register a named cleanup function to run on shutdown.
 * @param {string} name  Identifier (for logging)
 * @param {() => Promise<void>} fn  Cleanup function
 */
function addShutdownHook(name, fn) {
  _hooks.set(name, fn);
}

/**
 * Remove a previously registered hook.
 * @param {string} name
 */
function removeShutdownHook(name) {
  _hooks.delete(name);
}

/**
 * Execute all hooks with a timeout, then exit.
 * @param {string} signal  The signal that triggered shutdown
 */
async function requestShutdown(signal) {
  if (_shuttingDown) return; // Prevent double-fire
  _shuttingDown = true;
  state.set('shutdownRequested', true);

  const logger = _tryRequireLogger();
  if (logger) {
    logger.warn('Shutdown signal received', { signal, hooks: [..._hooks.keys()] });
  } else {
    process.stderr.write(`\n  Shutdown (${signal}) — cleaning up...\n`);
  }

  // Run all hooks in parallel, capped by timeout
  const hookEntries = [..._hooks.entries()];
  const deadline = new Promise((resolve) =>
    setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS)
  );

  const hookPromises = hookEntries.map(async ([name, fn]) => {
    try {
      await fn();
    } catch (err) {
      if (logger) {
        logger.warn(`Shutdown hook "${name}" failed`, { error: err.message });
      }
    }
  });

  await Promise.race([
    Promise.allSettled(hookPromises),
    deadline,
  ]);

  if (logger) {
    logger.info('Server closed gracefully');
  }

  // Failsafe: if process.exit() hangs (native addons, stuck handlers),
  // force kill after a grace period.
  const failsafe = setTimeout(() => {
    try { process.kill(process.pid, 'SIGKILL'); } catch { /* last resort */ }
  }, FAILSAFE_TIMEOUT_MS - SHUTDOWN_TIMEOUT_MS);
  failsafe.unref();

  process.exit(0);
}

/**
 * Install SIGTERM, SIGINT, and SIGHUP handlers.
 * On POSIX, also starts orphan detection (monitors parent process liveness).
 * Safe to call multiple times — only registers once.
 */
function registerShutdownHandlers() {
  if (_registered) return;
  _registered = true;

  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));

  // SIGHUP: only available on POSIX
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => requestShutdown('SIGHUP'));
  }

  // SIGBREAK: Windows-only (Ctrl+Break / console-close). Node does not deliver
  // SIGTERM on Windows, so this is the graceful-shutdown signal there.
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => requestShutdown('SIGBREAK'));
  }

  // Orphan detection: if parent process dies, stdout/stdin become unwritable.
  // Poll every 30s to detect orphaned processes (e.g. if IDE process crashes).
  if (process.platform !== 'win32') {
    const orphanCheck = setInterval(() => {
      if (!process.stdout.writable || !process.stdin.readable) {
        clearInterval(orphanCheck);
        requestShutdown('orphan');
      }
    }, 30000);
    orphanCheck.unref();
  }
}

/**
 * Try to load the project logger without throwing.
 */
function _tryRequireLogger() {
  try {
    return require('../utils/logger');
  } catch {
    return null;
  }
}

module.exports = {
  addShutdownHook,
  removeShutdownHook,
  requestShutdown,
  registerShutdownHandlers,
};
