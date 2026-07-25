'use strict';

/**
 * daemonSpawnLocation — pure decision for where the detached AI-management
 * daemon should be spawned so it does NOT lock the site-packages bundle.
 *
 * Why this exists: the detached daemon (`ai-manage-daemon.js`) was spawned with
 * its cwd inside the pip bundle (gateway.js: `process.env.KHYQUANT_ROOT ||
 * path.resolve(__dirname, '../..')` → `site-packages/khy_os/bundled/services/
 * backend/src`). On Windows a running process's cwd locks that directory and all
 * of its ancestors against rename/delete, so `pip install --upgrade khy-os`
 * fails with WinError 32, aborts the uninstall half-way, and corrupts the
 * install. The node binary lives in a user-writable dir (not the lock); the cwd
 * is the lock.
 *
 * Fix: on Windows, spawn the daemon with its cwd in the user-writable data home
 * (`~/.khy`) instead, and pin KHYQUANT_ROOT in the daemon's env so every path
 * consumer — which resolves via `KHYQUANT_ROOT || path.resolve(__dirname, …)`,
 * never `process.cwd()` — behaves byte-identically. Then pip can overwrite the
 * bundle even while khy is running: nothing needs to be stopped.
 *
 * This module is a pure leaf (judgment/execution separation): all inputs are
 * passed in, it performs no IO, and it never throws — the caller does the IO
 * (getDataHome / fs.existsSync) and the spawn.
 */

/**
 * Decide the cwd and env patch for the detached daemon spawn.
 *
 * @param {object} input
 * @param {string} input.platform      process.platform (e.g. 'win32' | 'linux').
 * @param {string} input.resolvedRoot  the current/legacy cwd value the caller
 *   would otherwise use (KHYQUANT_ROOT || path.resolve(__dirname, '../..')).
 * @param {?string} input.dataHome     a validated, existing, writable data-home
 *   directory (`~/.khy`), or null/'' if unavailable.
 * @param {boolean} input.gateEnabled  KHY_DAEMON_SITEPKG_UNLOCK gate state.
 * @returns {{cwd: string, envPatch: object}} cwd to spawn with, and env keys to
 *   merge onto the daemon environment. On any non-qualifying input the current
 *   behavior is preserved exactly: `{ cwd: resolvedRoot, envPatch: {} }`.
 */
function resolveDaemonSpawnLocation(input) {
  const safe = input && typeof input === 'object' ? input : {};
  const platform = typeof safe.platform === 'string' ? safe.platform : '';
  const resolvedRoot = typeof safe.resolvedRoot === 'string' ? safe.resolvedRoot : '';
  const dataHome = typeof safe.dataHome === 'string' ? safe.dataHome.trim() : '';
  const gateEnabled = safe.gateEnabled === true;

  const NO_CHANGE = { cwd: resolvedRoot, envPatch: {} };

  // Only relocate on Windows (the only OS where cwd locks a directory). Unix and
  // macOS can delete a directory that is a process's cwd, so cwd-in-bundle is
  // harmless there → keep byte-identical behavior.
  if (platform !== 'win32') return NO_CHANGE;
  if (!gateEnabled) return NO_CHANGE;
  // No usable data home, or it is the same place we'd already use → nothing to
  // gain, keep current behavior.
  if (!dataHome) return NO_CHANGE;
  if (resolvedRoot && dataHome === resolvedRoot) return NO_CHANGE;

  // Move cwd out of site-packages, and pin KHYQUANT_ROOT so path resolution that
  // used to fall back to the (now-changed) cwd/root stays exactly the same.
  return {
    cwd: dataHome,
    envPatch: resolvedRoot ? { KHYQUANT_ROOT: resolvedRoot } : {},
  };
}

module.exports = { resolveDaemonSpawnLocation };
