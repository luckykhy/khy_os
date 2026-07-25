/**
 * Version check + auto-update notification service.
 *
 * On startup (non-blocking), checks if a newer version of khy-os
 * is available on PyPI. If so, displays a one-line upgrade notice.
 *
 * Also handles IDE adapter auto-recovery when tokens/logins change.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CACHE_FILE = path.join(os.homedir(), '.khyquant', 'version_cache.json');
const CHECK_INTERVAL_MS = 4 * 3600 * 1000; // check at most every 4 hours
// Single source of truth: published PyPI package names, in priority order.
// Consumed here and by the `update` command in cli/router.js — keep it one place.
const PACKAGE_CANDIDATES = ['khy-os', 'khy-quant'];

/**
 * Get currently installed version.
 */
function getCurrentVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Read cached version check result.
 */
function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Write version check result to cache.
 */
function writeCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2));
  } catch { /* best effort */ }
}

/**
 * Check PyPI for latest version (synchronous, with timeout).
 * Returns { latest, current, updateAvailable } or null.
 */
function checkForUpdate() {
  const current = getCurrentVersion();
  const cache = readCache();

  // Use cache if recent enough
  if (cache && cache.checkedAt && (Date.now() - cache.checkedAt) < CHECK_INTERVAL_MS) {
    return { ...cache, current, updateAvailable: compareVersions(cache.latest, current) > 0 };
  }

  try {
    const pip = process.platform === 'win32' ? 'pip' : 'pip3';
    // Same dead-proxy root cause as the `update` command: a stale HTTP(S)_PROXY in the
    // environment makes `pip index versions` fail silently, so the startup update notice
    // never appears. When the gated policy leaf is available, strip the proxy for this
    // passive check too. Gate off / leaf missing → no `env` override → byte-identical.
    let probeEnv;
    try {
      const pipPolicy = require('./pipFailurePolicy');
      if (pipPolicy.isEnabled()) probeEnv = pipPolicy.stripProxyEnv(process.env);
    } catch { /* leaf missing — fall back to inherited env */ }
    let latest = current;
    let sourcePkg = PACKAGE_CANDIDATES[0];
    for (const pkgName of PACKAGE_CANDIDATES) {
      let output = '';
      try {
        const execOpts = {
          encoding: 'utf-8',
          timeout: 8000,
          stdio: ['pipe', 'pipe', 'pipe'],
        };
        if (probeEnv) execOpts.env = probeEnv;
        output = execSync(`${pip} index versions ${pkgName}`, execOpts);
      } catch {
        continue;
      }
      const pkgPattern = pkgName.replace('-', '[-_]');
      const match = output.match(new RegExp(`${pkgPattern}\\s*\\(([\\d.]+)\\)`, 'i'))
        || output.match(/LATEST:\s*([\d.]+)/i);
      if (match && match[1]) {
        latest = match[1];
        sourcePkg = pkgName;
        break;
      }
    }

    const result = { latest, current, updateAvailable: compareVersions(latest, current) > 0 };
    writeCache({ latest, sourcePkg });
    return result;
  } catch {
    // Network or pip failure — return cached or null
    if (cache) return { ...cache, current, updateAvailable: compareVersions(cache.latest || current, current) > 0 };
    return null;
  }
}

/**
 * Compare semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Format update notification string (or empty if up-to-date).
 */
function getUpdateNotice() {
  const result = checkForUpdate();
  if (!result || !result.updateAvailable) return '';
  return `更新可用: v${result.current} → v${result.latest}  运行 update 升级`;
}

// ── IDE Adapter Auto-Recovery ───────────────────────────────────────────

/**
 * Attempt to recover IDE adapters when token/login changes detected.
 * Returns { recovered: string[], failed: string[] }
 */
async function recoverIdeAdapters() {
  const recovered = [];
  const failed = [];

  try {
    const gateway = require('./gateway/aiGateway');
    if (!gateway._initialized) return { recovered, failed };

    for (const entry of gateway._adapters) {
      if (!entry.enabled || entry.key === 'api' || entry.key === 'relay') continue;

      // Re-detect adapter availability
      try {
        const newAvail = entry.adapter.detectAsync
          ? await entry.adapter.detectAsync()
          : entry.adapter.detect();

        if (newAvail && !entry.available) {
          // Adapter became available — recovered!
          entry.available = true;
          recovered.push(entry.key);
        } else if (!newAvail && entry.available) {
          // Adapter lost — try refreshing
          entry.available = false;

          // Attempt one re-detection after short delay
          await new Promise(r => setTimeout(r, 500));
          const retry = entry.adapter.detectAsync
            ? await entry.adapter.detectAsync()
            : entry.adapter.detect();

          if (retry) {
            entry.available = true;
            recovered.push(entry.key);
          } else {
            failed.push(entry.key);
          }
        }
      } catch {
        if (entry.available) {
          entry.available = false;
          failed.push(entry.key);
        }
      }
    }
  } catch { /* gateway not loaded */ }

  return { recovered, failed };
}

/**
 * Format recovery message for display.
 */
function formatRecoveryMessage(result) {
  const parts = [];
  if (result.recovered.length > 0) {
    parts.push(`✓ 已恢复: ${result.recovered.join(', ')}`);
  }
  if (result.failed.length > 0) {
    parts.push(`✗ 不可用: ${result.failed.join(', ')} — 请检查登录状态或联系开发者更新适配器`);
  }
  return parts.join('  ');
}

module.exports = {
  PACKAGE_CANDIDATES,
  getCurrentVersion,
  checkForUpdate,
  compareVersions,
  getUpdateNotice,
  recoverIdeAdapters,
  formatRecoveryMessage,
};
