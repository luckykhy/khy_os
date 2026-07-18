'use strict';

/**
 * Shared CLI command-availability cache.
 *
 * Several gateway adapters (cliToolAdapter, claudeAdapter, codexAdapter) probe
 * whether an external CLI (`claude`, `codex`, `aider`, ...) exists by running
 * `<cmd> --version` via **synchronous** `spawnSync`. That call blocks the entire
 * Node event loop until the child exits — and crucially, being inside an `async`
 * function does NOT make it non-blocking. During a turn the gateway re-probes
 * availability several times (`detect(true)` force-refresh from preflight,
 * getStatus(), and the periodic/after-failure re-detect pass), so a single
 * submit could fire 3+ synchronous `claude --version` spawns back to back —
 * freezing the interactive UI (the Ink spinner stops animating) for the sum of
 * their latencies. On a slow machine each probe can take seconds (the 5s timeout
 * ceiling × N), turning the first prompt of a session into a multi-second hang.
 *
 * This module collapses that storm: probe results are cached per command with a
 * short TTL, so repeated checks within the same window reuse the result instead
 * of re-spawning. A genuine refresh still happens once the entry goes stale, so
 * a newly-installed CLI is picked up within one TTL window. `prewarm()` primes
 * the cache off the hot path using **async** `execFile`, so a startup hook can
 * populate it before the user submits — making the first request a cache hit
 * with zero synchronous spawns.
 */

const { spawnSync, execFileSync, execFile } = require('child_process');

const DEFAULT_TTL_MS = (() => {
  const parsed = parseInt(String(process.env.KHY_CLI_DETECT_TTL_MS || ''), 10);
  // 0 disables caching (always re-probe); negative/NaN → default.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000;
})();

const PROBE_TIMEOUT_MS = 5000;

// cmd -> { ok: boolean, error: string, at: number }
const _cache = new Map();

/**
 * Synchronous probe: `<cmd> --version`, falling back to a PATH lookup.
 * @param {string} cmd
 * @returns {{ ok: boolean, error: string }}
 */
function _probeSync(cmd) {
  let priorError = '';
  try {
    const r = spawnSync(cmd, ['--version'], {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      env: process.env,
    });
    if (r && !r.error && r.status === 0) return { ok: true, error: '' };
    if (r && r.error) priorError = r.error.message || String(r.error);
    else if (r && typeof r.status === 'number' && r.status !== 0) priorError = `exit ${r.status}`;
  } catch (err) {
    priorError = (err && err.message) || String(err);
  }

  // Fallback: PATH lookup (best-effort). More robust in restricted environments
  // where direct execution may fail with EPERM even when the command is runnable.
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(lookup, [cmd], { stdio: 'pipe', timeout: PROBE_TIMEOUT_MS });
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: priorError || (err && err.message) || String(err) };
  }
}

/**
 * Return the cached availability entry for a command, probing synchronously only
 * when there is no fresh cache entry.
 *
 * @param {string} cmd
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Override the cache TTL for this lookup.
 * @param {boolean} [options.force] - Ignore the cache and re-probe now.
 * @returns {{ ok: boolean, error: string, at: number }}
 */
function check(cmd, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = _cache.get(cmd);
  if (!options.force && hit && ttlMs > 0 && (now - hit.at) < ttlMs) {
    return hit;
  }
  const res = _probeSync(cmd);
  const entry = { ok: res.ok, error: res.error, at: now };
  _cache.set(cmd, entry);
  return entry;
}

/**
 * Convenience boolean wrapper around {@link check}.
 * @param {string} cmd
 * @param {object} [options]
 * @returns {boolean}
 */
function isAvailable(cmd, options) {
  return check(cmd, options).ok;
}

/**
 * Async probe: `<cmd> --version`, falling back to a PATH lookup. Mirrors
 * {@link _probeSync} byte-for-byte in outcome, but runs via `execFile` so it
 * NEVER blocks the Node event loop — the whole reason this exists.
 *
 * On macOS the first execution of a freshly-installed/notarized CLI can stall
 * for seconds under Gatekeeper assessment, and a Node-based CLI (`claude`,
 * `codex`) pays its own interpreter cold-start. Three such probes back-to-back
 * via the synchronous {@link _probeSync} freeze the Ink TUI for the sum of
 * their latencies — the "press Enter, wait tens of seconds before the workspace
 * responds" symptom. The async probe lets the gateway's parallel init keep the
 * loop free (and lets its detect-timeout race actually fire).
 *
 * @param {string} cmd
 * @returns {Promise<{ ok: boolean, error: string }>}
 */
function _probeAsync(cmd) {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (err) => {
      if (!err) return resolve({ ok: true, error: '' });
      const priorError = (err && err.message) || String(err);
      // Fallback: PATH lookup — robust in restricted environments where direct
      // execution may fail with EPERM even when the command is runnable.
      const lookup = process.platform === 'win32' ? 'where' : 'which';
      execFile(lookup, [cmd], { timeout: PROBE_TIMEOUT_MS }, (err2) => {
        if (!err2) return resolve({ ok: true, error: '' });
        resolve({ ok: false, error: priorError });
      });
    });
  });
}

/**
 * Async counterpart of {@link check}: returns the cached availability entry,
 * probing asynchronously (non-blocking) only when there is no fresh cache entry.
 * Shares the SAME cache as the sync path, so a result primed here satisfies a
 * later sync {@link check} (and vice versa) — semantics are identical, only the
 * probe mechanism differs.
 *
 * @param {string} cmd
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Override the cache TTL for this lookup.
 * @param {boolean} [options.force] - Ignore the cache and re-probe now.
 * @returns {Promise<{ ok: boolean, error: string, at: number }>}
 */
async function checkAsync(cmd, options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = _cache.get(cmd);
  if (!options.force && hit && ttlMs > 0 && (now - hit.at) < ttlMs) {
    return hit;
  }
  const res = await _probeAsync(cmd);
  const entry = { ok: res.ok, error: res.error, at: Date.now() };
  _cache.set(cmd, entry);
  return entry;
}

/**
 * Async convenience boolean wrapper around {@link checkAsync}.
 * @param {string} cmd
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
async function isAvailableAsync(cmd, options) {
  return (await checkAsync(cmd, options)).ok;
}

/**
 * Prime the cache off the hot path using async `execFile` (does not block the
 * event loop). Commands already covered by a fresh cache entry are skipped.
 * Never rejects — failures are recorded as "unavailable".
 *
 * @param {string|string[]} cmds
 * @returns {Promise<Array<{ ok: boolean, error: string, at: number }>>}
 */
function prewarm(cmds = []) {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  return Promise.all(list.map((cmd) => new Promise((resolve) => {
    const now = Date.now();
    const hit = _cache.get(cmd);
    if (hit && DEFAULT_TTL_MS > 0 && (now - hit.at) < DEFAULT_TTL_MS) {
      return resolve(hit);
    }
    const store = (ok, error) => {
      const entry = { ok, error: error || '', at: Date.now() };
      _cache.set(cmd, entry);
      resolve(entry);
    };
    execFile(cmd, ['--version'], { timeout: PROBE_TIMEOUT_MS }, (err) => {
      if (!err) return store(true, '');
      // Async PATH fallback mirrors the sync probe's second stage.
      const lookup = process.platform === 'win32' ? 'where' : 'which';
      execFile(lookup, [cmd], { timeout: PROBE_TIMEOUT_MS }, (err2) => {
        if (!err2) return store(true, '');
        store(false, (err.message || String(err)));
      });
    });
  })));
}

/**
 * Clear the cache (primarily for tests and explicit re-detection).
 */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  check,
  isAvailable,
  checkAsync,
  isAvailableAsync,
  prewarm,
  _clearCache,
  DEFAULT_TTL_MS,
};
