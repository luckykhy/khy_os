/**
 * Credential Watcher Service — real-time IDE credential file monitor.
 *
 * Watches Cursor / Windsurf / Trae / Kiro local credential files for changes.
 * When a login, account switch (e.g. via Nirvana), or token refresh is detected,
 * the service extracts credentials and persists them to both `account_pool`
 * (backend raw DB) and `ai_accounts` (ai-backend Sequelize model).
 *
 * Dual strategy: fs.watch() for real-time + 30 s interval for fallback.
 * Triple dedup: 1500 ms debounce → SHA-256 content hash → DB token_hash unique index.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 1500;
const POLL_INTERVAL_MS = 30_000;
const EVENT_RING_SIZE = 200;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _started = false;
let _pollTimer = null;
/** @type {Map<string, { watcher: fs.FSWatcher|null, debounce: NodeJS.Timeout|null, hash: string, provider: string, type: string }>} */
const _watchers = new Map();
/** @type {Array<{ts: string, provider: string, path: string, action: string, detail: string}>} */
const _events = [];
let _stats = { scans: 0, detections: 0, errors: 0, lastScanAt: null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function logEvent(provider, filePath, action, detail = '') {
  const entry = {
    ts: new Date().toISOString(),
    provider,
    path: filePath,
    action,
    detail: String(detail).slice(0, 300),
  };
  _events.push(entry);
  if (_events.length > EVENT_RING_SIZE) _events.shift();
  return entry;
}

function safeReadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Find the nearest existing ancestor directory for a file path.
 * Used when the target file doesn't exist yet — we watch the parent
 * so we can detect when the file gets created.
 */
const nearestExistingDir = require('../utils/nearestExistingDir');

// ---------------------------------------------------------------------------
// Core: per-file scan
// ---------------------------------------------------------------------------
async function scanFile(filePath, provider, fileType) {
  const buf = safeReadFile(filePath);
  if (!buf) return false;

  const hash = sha256(buf);
  const entry = _watchers.get(filePath);
  if (entry && entry.hash === hash) return false; // unchanged
  if (entry) entry.hash = hash;

  _stats.scans += 1;
  _stats.lastScanAt = new Date().toISOString();

  try {
    const pool = require('./accountPool');
    await pool.init();
    const result = await pool.importProviderTokens(provider, {
      activateIfNone: true,
      includeNirvana: false,
    });

    const changed = (result.inserted || 0) + (result.updated || 0);
    if (changed > 0) {
      _stats.detections += changed;
      logEvent(provider, filePath, 'credential_detected', `+${result.inserted} new, ~${result.updated} updated`);

      // Bridge to ai_accounts table
      await syncToAiAccounts(provider);
    } else {
      logEvent(provider, filePath, 'scan_no_change', `found ${result.found} candidates, 0 new`);
    }
    return changed > 0;
  } catch (err) {
    _stats.errors += 1;
    logEvent(provider, filePath, 'scan_error', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sync to ai_accounts (ai-backend Sequelize model)
// ---------------------------------------------------------------------------
async function syncToAiAccounts(provider) {
  try {
    const pool = require('./accountPool');
    await pool.init();
    const accounts = await pool.getAllAccounts(provider);

    let AIAccount;
    try {
      AIAccount = require('../../packages/shared/src/models/AIAccount');
    } catch {
      try {
        AIAccount = require('@khy/shared/models/AIAccount');
      } catch {
        // ai_accounts model not available in this runtime
        return;
      }
    }

    for (const acct of (accounts || [])) {
      const accessToken = String(acct.access_token || acct.accessToken || '').trim();
      if (!accessToken) continue;

      const email = String(acct.email || '').trim();
      const label = String(acct.label || '').trim();
      const where = email
        ? { provider, email }
        : { provider, label: label || `${provider}:pool:${acct.id}` };

      try {
        await AIAccount.findOrCreate({
          where,
          defaults: {
            provider,
            label: label || email || `${provider}:auto`,
            email: email || '',
            apiKey: accessToken,
            tier: 'FREE',
            status: 'active',
          },
        }).then(([record, created]) => {
          if (!created) {
            // Update token if changed
            record.apiKey = accessToken;
            if (email) record.email = email;
            return record.save();
          }
        });
      } catch {
        // Ignore individual sync failures (table may not exist)
      }
    }
  } catch {
    // Sequelize not initialized or shared package unavailable
  }
}

// ---------------------------------------------------------------------------
// Watcher setup
// ---------------------------------------------------------------------------
function setupWatcher(filePath, provider, fileType) {
  if (_watchers.has(filePath)) return;

  const entry = { watcher: null, debounce: null, hash: '', provider, type: fileType };
  _watchers.set(filePath, entry);

  const onFileChange = () => {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      scanFile(filePath, provider, fileType).catch(() => {});
    }, DEBOUNCE_MS);
  };

  const fileExists = fs.existsSync(filePath);

  // For vscdb files, always watch parent directory (SQLite WAL writes
  // may not trigger fs.watch on the file itself).
  const watchTarget = !fileExists || fileType === 'vscdb'
    ? nearestExistingDir(filePath)
    : filePath;

  if (!watchTarget) {
    logEvent(provider, filePath, 'watch_skip', 'no accessible parent directory');
    return;
  }

  try {
    const watcher = fs.watch(watchTarget, { persistent: false }, (eventType, filename) => {
      // If watching parent dir, only react when our target file is affected
      if (watchTarget !== filePath) {
        const target = path.basename(filePath);
        if (filename && filename !== target) return;
      }
      onFileChange();
    });

    watcher.on('error', (err) => {
      logEvent(provider, filePath, 'watch_error', err.message);
      // Attempt to re-establish after a delay
      entry.watcher = null;
      setTimeout(() => {
        if (_started && !entry.watcher) {
          _watchers.delete(filePath);
          setupWatcher(filePath, provider, fileType);
        }
      }, 5000);
    });

    entry.watcher = watcher;
    logEvent(provider, filePath, 'watch_started', `target=${watchTarget === filePath ? 'file' : 'parent'}`);
  } catch (err) {
    logEvent(provider, filePath, 'watch_failed', err.message);
  }
}

// ---------------------------------------------------------------------------
// Poll fallback — covers NFS, containers, and fs.watch blind spots
// ---------------------------------------------------------------------------
async function pollAll() {
  if (!_started) return;
  for (const [filePath, entry] of _watchers) {
    try {
      await scanFile(filePath, entry.provider, entry.type);
    } catch {
      // Errors already logged inside scanFile
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function start() {
  if (_started) return;
  _started = true;

  let pool;
  try {
    pool = require('./accountPool');
    await pool.init();
  } catch (err) {
    logEvent('system', '', 'start_error', `accountPool init failed: ${err.message}`);
    _started = false;
    return;
  }

  const paths = pool.getWatchablePaths();
  for (const { provider, path: filePath, type } of paths) {
    setupWatcher(filePath, provider, type);
  }

  // Initial scan
  pollAll().catch(() => {});

  // Poll fallback
  _pollTimer = setInterval(() => pollAll().catch(() => {}), POLL_INTERVAL_MS);
  // 待机轮询不应钉住事件循环：主进程退出即随之结束（等价 daemon）。
  if (_pollTimer.unref) _pollTimer.unref();

  // 仅写结构化事件到内存环形缓冲（可观测层）；不再 console.log 抢占 stdout —
  // 启停属生命周期一次性事件，但 stdout 是交互式 CLI 的用户通道，写入即污染 TUI
  // （规范 §0 红线 / R5/R6）。需要排障时经 logEvent 缓冲或开发者日志通道查阅。
  logEvent('system', '', 'started', `watching ${paths.length} paths`);
}

function stop() {
  if (!_started) return;
  _started = false;

  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }

  for (const [filePath, entry] of _watchers) {
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.watcher) {
      try { entry.watcher.close(); } catch { /* ignore */ }
    }
  }
  _watchers.clear();

  logEvent('system', '', 'stopped', '');
}

async function triggerScanNow() {
  const results = {};
  for (const [filePath, entry] of _watchers) {
    // Reset hash to force re-scan even if content unchanged
    entry.hash = '';
    try {
      const changed = await scanFile(filePath, entry.provider, entry.type);
      results[filePath] = { provider: entry.provider, changed };
    } catch (err) {
      results[filePath] = { provider: entry.provider, changed: false, error: err.message };
    }
  }
  return results;
}

function getStatus() {
  const watchers = [];
  for (const [filePath, entry] of _watchers) {
    watchers.push({
      path: filePath,
      provider: entry.provider,
      type: entry.type,
      watching: !!entry.watcher,
      hasHash: !!entry.hash,
    });
  }

  return {
    running: _started,
    watcherCount: _watchers.size,
    watchers,
    stats: { ..._stats },
    recentEvents: _events.slice(-50),
  };
}

module.exports = { start, stop, triggerScanNow, getStatus };
