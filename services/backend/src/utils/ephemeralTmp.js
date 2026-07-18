'use strict';

/**
 * ephemeralTmp.js — single source of truth for one-shot ("用完即毁") temp
 * working directories: extracting an archive, dropping a one-off script, any
 * scratch space that must not outlive the operation that created it.
 *
 * Two guarantees the scattered `fs.mkdtempSync(...)` + ad-hoc `finally` idiom
 * did not provide uniformly:
 *   1. Deterministic teardown — `withTempDir` removes the directory in a
 *      `finally`, so it is destroyed whether the body resolves, throws, or
 *      rejects.
 *   2. Crash safety net — every live ephemeral dir is registered for removal on
 *      process `exit`/`SIGINT`/`SIGTERM`, and all dirs use the `khy-` prefix so
 *      the age-based sweep in cleanupService reclaims anything a hard kill (-9)
 *      leaves behind.
 *
 * Engineering rules: base dir is env-tunable (KHY_OS_TEMP_DIR, shared with
 * cleanupService) — no hardcoded path; teardown is best-effort and never throws
 * over the caller's own result; no timer kills a long-running body.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Prefix MUST stay within the set cleanupService.isManagedOsTempEntry() sweeps
// ('khy-'), so a hard-killed process still gets its scratch dirs reclaimed.
const PREFIX = 'khy-ephemeral-';

/** @type {Set<string>} live ephemeral dirs awaiting disposal (exit safety net) */
const _live = new Set();
let _exitHooksInstalled = false;

function _baseDir() {
  const configured = String(process.env.KHY_OS_TEMP_DIR || '').trim();
  return configured || os.tmpdir();
}

function _removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: a locked/already-gone dir must not crash teardown. The
    // cleanupService age-based sweep is the backstop for whatever survives.
  }
}

function _installExitHooks() {
  if (_exitHooksInstalled) return;
  _exitHooksInstalled = true;

  // 'exit' must be synchronous — no async fs here.
  process.on('exit', () => {
    for (const dir of _live) _removeDir(dir);
    _live.clear();
  });

  // Signals: dispose, then re-raise so we don't swallow the caller's intended
  // exit semantics. Guarded so we only act if there is something to clean.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      for (const dir of _live) _removeDir(dir);
      _live.clear();
      // Re-raise with the default disposition so exit codes stay conventional.
      process.removeAllListeners(sig);
      try { process.kill(process.pid, sig); } catch { process.exit(0); }
    });
  }
}

/**
 * Create an ephemeral temp directory and return a handle. Caller is responsible
 * for calling `handle.dispose()`; the exit safety net covers crashes. Prefer
 * `withTempDir` when the lifetime maps cleanly onto a function scope.
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix] - Extra label folded into the dir name (sanitized).
 * @returns {{ path: string, dispose: () => void }}
 */
function createEphemeralDir(opts = {}) {
  _installExitHooks();
  const label = String(opts.prefix || '')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .slice(0, 40);
  const stem = label ? `${PREFIX}${label}-` : PREFIX;
  const dir = fs.mkdtempSync(path.join(_baseDir(), stem));
  _live.add(dir);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    _live.delete(dir);
    _removeDir(dir);
  };

  return { path: dir, dispose };
}

/**
 * Run `fn` with a freshly created ephemeral temp directory and destroy it
 * afterward — regardless of success, throw, or rejection. The directory path is
 * passed to `fn`. Supports both sync and async `fn` (a returned promise is
 * awaited before teardown).
 *
 * @template T
 * @param {(dir: string) => (T | Promise<T>)} fn
 * @param {object} [opts] - Forwarded to createEphemeralDir (e.g. { prefix }).
 * @returns {Promise<T>}
 */
async function withTempDir(fn, opts = {}) {
  const handle = createEphemeralDir(opts);
  try {
    return await fn(handle.path);
  } finally {
    handle.dispose();
  }
}

module.exports = { withTempDir, createEphemeralDir };
