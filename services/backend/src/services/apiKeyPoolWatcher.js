/**
 * API Key Pool Watcher — hot-reload the key pool when its sources change,
 * WITHOUT a daemon restart.
 *
 * Why this exists: `apiKeyPool.init()` reads its three sources (POOL_FILE JSON,
 * env vars, builtin fallbacks) exactly once, guarded by `_initialized`. dotenv
 * loads `.env` into process.env only at process startup. So a user who adds a
 * key after boot — by editing `.env`, by `khy gateway add` (a SEPARATE process),
 * or via the Web UI (in-process writer) — used to see "no key / 待配 Key" until a
 * manual restart. This watcher closes that gap.
 *
 * One mechanism covers BOTH trigger sources the user asked for ("文件变动 +
 * CLI/Web 都管"): every path ultimately WRITES a file —
 *   - a direct `.env` edit             → canonical/mirror .env changes;
 *   - the CLI (separate process)       → writes .env and/or api_keys.json;
 *   - the Web writer (in-process)      → same files via gatewayEnvFile/addKey.
 * The watcher detects the file change and calls `apiKeyPool.reload()`, which
 * reconciles in-memory state by key id (preserving cooldown/stats). Because the
 * reload path NEVER calls save(), there is no save→watch→reload loop.
 *
 * Mirrors credentialWatcherService.js: fs.watch (real-time) + 30 s poll
 * fallback (unref'd) + per-file SHA-256 content-hash dedup + debounce. Killable
 * via KHY_DISABLE_KEYPOOL_WATCH=1.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const apiKeyPool = require('./apiKeyPool');
const { resolveEnvPaths } = require('./gatewayEnvFile');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 1200;
const POLL_INTERVAL_MS = 30_000;
const EVENT_RING_SIZE = 100;

// Env vars whose value is API-key material we must overlay into process.env on a
// .env edit BEFORE reload (dotenv won't re-read on its own). Endpoints too, since
// reload reads `<PROVIDER>_API_ENDPOINT`.
const KEY_VAR_RE = /_API_KEY(S)?(_\d+)?$/i;
const ENDPOINT_VAR_RE = /_API_ENDPOINT$/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _started = false;
let _pollTimer = null;
/** @type {Map<string, { watcher: fs.FSWatcher|null, debounce: NodeJS.Timeout|null, hash: string, kind: string }>} */
const _watchers = new Map();
/** @type {Array<{ts:string, path:string, action:string, detail:string}>} */
const _events = [];
let _stats = { reloads: 0, added: 0, removed: 0, updated: 0, errors: 0, lastReloadAt: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function logEvent(filePath, action, detail = '') {
  const entry = { ts: new Date().toISOString(), path: filePath, action, detail: String(detail).slice(0, 300) };
  _events.push(entry);
  if (_events.length > EVENT_RING_SIZE) _events.shift();
  return entry;
}

function safeRead(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/** Nearest existing ancestor dir — lets us watch for a file that doesn't exist yet. */
const nearestExistingDir = require('../utils/nearestExistingDir');

/**
 * Overlay API-key-shaped vars from a parsed .env into process.env (overlay-only,
 * NEVER delete): a key removed from .env should not clobber a key the operator
 * exported in the shell. Genuine pooled-key removals are handled by reload diffing
 * api_keys.json — env keys are a fallback overlay, not an authoritative set.
 */
function overlayEnvFile(filePath) {
  const buf = safeRead(filePath);
  if (!buf) return 0;
  let parsed;
  try {
    parsed = require('dotenv').parse(buf); // parse only — does NOT mutate process.env
  } catch {
    return 0;
  }
  let applied = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (!KEY_VAR_RE.test(k) && !ENDPOINT_VAR_RE.test(k)) continue;
    if (process.env[k] !== v) { process.env[k] = v; applied += 1; }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Core: a watched file changed → maybe reload
// ---------------------------------------------------------------------------
function reloadFrom(filePath) {
  const entry = _watchers.get(filePath);
  const buf = safeRead(filePath);
  // Content-hash dedup: fs.watch fires on metadata-only touches and SQLite WAL
  // churn; only react when bytes actually changed.
  const hash = buf ? sha256(buf) : '';
  if (entry && entry.hash === hash) return false;
  if (entry) entry.hash = hash;

  try {
    // If it's an .env file, overlay its key vars into process.env first so
    // reload() sees the edit (dotenv only reads at startup).
    if (entry && entry.kind === 'env') overlayEnvFile(filePath);

    const result = apiKeyPool.reload();
    _stats.reloads += 1;
    _stats.added += result.added;
    _stats.removed += result.removed;
    _stats.updated += result.updated;
    _stats.lastReloadAt = new Date().toISOString();
    if (result.added || result.removed || result.updated) {
      logEvent(filePath, 'reloaded', `+${result.added} -${result.removed} ~${result.updated} (total ${result.total})`);
    } else {
      logEvent(filePath, 'reload_no_change', `total ${result.total}`);
    }
    return true;
  } catch (err) {
    _stats.errors += 1;
    logEvent(filePath, 'reload_error', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Watcher setup
// ---------------------------------------------------------------------------
function setupWatcher(filePath, kind) {
  if (_watchers.has(filePath)) return;

  const entry = { watcher: null, debounce: null, hash: '', kind };
  // Seed the hash with current content so the initial state isn't treated as a
  // change (init() already loaded it).
  const seed = safeRead(filePath);
  entry.hash = seed ? sha256(seed) : '';
  _watchers.set(filePath, entry);

  const onChange = () => {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      reloadFrom(filePath);
    }, DEBOUNCE_MS);
  };

  const fileExists = fs.existsSync(filePath);
  // Watch the parent dir when the file doesn't exist yet (so creation is caught),
  // and always for atomic-rename writers that replace the inode.
  const watchTarget = fileExists ? filePath : nearestExistingDir(filePath);
  if (!watchTarget) {
    logEvent(filePath, 'watch_skip', 'no accessible parent directory');
    return;
  }

  try {
    const watcher = fs.watch(watchTarget, { persistent: false }, (_eventType, filename) => {
      if (watchTarget !== filePath) {
        const target = path.basename(filePath);
        if (filename && filename !== target) return;
      }
      onChange();
    });

    watcher.on('error', (err) => {
      logEvent(filePath, 'watch_error', err.message);
      entry.watcher = null;
      // Self-heal: re-establish after a short delay (e.g. parent dir recreated).
      setTimeout(() => {
        if (_started && !entry.watcher) {
          _watchers.delete(filePath);
          setupWatcher(filePath, kind);
        }
      }, 5000);
    });

    entry.watcher = watcher;
    logEvent(filePath, 'watch_started', `target=${watchTarget === filePath ? 'file' : 'parent'}`);
  } catch (err) {
    logEvent(filePath, 'watch_failed', err.message);
  }
}

// ---------------------------------------------------------------------------
// Poll fallback — covers NFS / containers / fs.watch blind spots
// ---------------------------------------------------------------------------
function pollAll() {
  if (!_started) return;
  for (const filePath of _watchers.keys()) {
    try { reloadFrom(filePath); } catch { /* logged inside */ }
  }
}

/** The set of files whose change should trigger a reload. */
function watchTargets() {
  const targets = [];
  try {
    for (const p of resolveEnvPaths().targets) targets.push({ path: p, kind: 'env' });
  } catch { /* env paths unresolvable — pool JSON still watched */ }
  try {
    targets.push({ path: apiKeyPool.getPoolFilePath(), kind: 'pool' });
  } catch { /* ignore */ }
  return targets;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function start() {
  if (_started) return;
  if (String(process.env.KHY_DISABLE_KEYPOOL_WATCH || '').toLowerCase() === '1'
    || String(process.env.KHY_DISABLE_KEYPOOL_WATCH || '').toLowerCase() === 'true') {
    return;
  }
  _started = true;

  // Ensure the pool is initialized before we start reconciling against it.
  try { apiKeyPool.init(); } catch { /* init is best-effort; reload re-inits */ }

  for (const { path: filePath, kind } of watchTargets()) {
    setupWatcher(filePath, kind);
  }

  _pollTimer = setInterval(() => pollAll(), POLL_INTERVAL_MS);
  // Standby polling must not pin the event loop — exits with the daemon.
  if (_pollTimer.unref) _pollTimer.unref();

  logEvent('system', 'started', `watching ${_watchers.size} files`);
}

function stop() {
  if (!_started) return;
  _started = false;

  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  for (const [, entry] of _watchers) {
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.watcher) {
      try { entry.watcher.close(); } catch { /* ignore */ }
    }
  }
  _watchers.clear();
  logEvent('system', 'stopped', '');
}

/** Force an immediate reload (ignores content-hash dedup). For tests / manual refresh. */
function triggerReloadNow() {
  for (const [, entry] of _watchers) entry.hash = '__force__';
  const result = apiKeyPool.reload();
  _stats.reloads += 1;
  _stats.lastReloadAt = new Date().toISOString();
  // Re-seed hashes so the next genuine change is detected.
  for (const [filePath, entry] of _watchers) {
    const buf = safeRead(filePath);
    entry.hash = buf ? sha256(buf) : '';
  }
  return result;
}

function getStatus() {
  return {
    running: _started,
    watcherCount: _watchers.size,
    watchers: [..._watchers.entries()].map(([filePath, e]) => ({
      path: filePath,
      kind: e.kind,
      watching: !!e.watcher,
    })),
    stats: { ..._stats },
    recentEvents: _events.slice(-30),
  };
}

module.exports = { start, stop, triggerReloadNow, getStatus, __testHooks: { overlayEnvFile, reloadFrom, watchTargets } };
