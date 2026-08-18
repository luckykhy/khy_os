/**
 * Version check + auto-update notification service.
 *
 * On startup (non-blocking), checks whether a newer version of khy-os has been published.
 * "Published" means any of the three release registries — GitHub Releases, PyPI, npm —
 * see `checkForUpdateAll()`; the highest version across them is what gets displayed.
 *
 * Also handles IDE adapter auto-recovery when tokens/logins change.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Portable-aware app home resolved at load (legacy const semantics preserved).
function _appHome() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}
const CACHE_FILE = path.join(_appHome(), 'version_cache.json');
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
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Write version check result to cache.
 */
function writeCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...data, checkedAt: Date.now() }, null, 2));
  } catch {
    /* best effort */
  }
}

/**
 * Check PyPI for latest version (synchronous, with timeout).
 *
 * LEGACY / single-channel: this only asks pip, so its `latest` reflects PyPI alone.
 * Anything that *displays* "最新版本" must use `checkForUpdateAll()` instead — the real
 * release surface is three registries (GitHub Releases + PyPI + npm) and a PyPI-only
 * answer misreports "已是最新" / "领先于已发布版本" whenever another channel is ahead.
 * Kept for the synchronous callers that cannot await.
 *
 * Returns { latest, current, updateAvailable } or null.
 */
function checkForUpdate() {
  const current = getCurrentVersion();
  const cache = readCache();

  // Use cache if recent enough
  if (cache && cache.checkedAt && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
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
      if (pipPolicy.isEnabled()) {
        probeEnv = pipPolicy.stripProxyEnv(process.env);
      }
    } catch {
      /* leaf missing — fall back to inherited env */
    }
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
        if (probeEnv) {
          execOpts.env = probeEnv;
        }
        output = execSync(`${pip} index versions ${pkgName}`, execOpts);
      } catch {
        continue;
      }
      const pkgPattern = pkgName.replace('-', '[-_]');
      const match =
        output.match(new RegExp(`${pkgPattern}\\s*\\(([\\d.]+)\\)`, 'i')) ||
        output.match(/LATEST:\s*([\d.]+)/i);
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
    if (cache) {
      return {
        ...cache,
        current,
        updateAvailable: compareVersions(cache.latest || current, current) > 0,
      };
    }
    return null;
  }
}

/**
 * Multi-registry version check: GitHub Releases + PyPI + npm, highest version wins.
 *
 * This is the source of truth for every "最新版本" display. `checkForUpdate()` above only
 * asks pip, which silently made PyPI the single arbiter of "latest"; when a release lands
 * on GitHub or npm first (or a PyPI upload fails), that display lies. Here every enabled
 * channel is queried and reported, including the per-channel breakdown for the UI.
 *
 * Never throws. If no channel answers, returns `latest: null, indeterminate: true` —
 * callers must degrade honestly instead of claiming the install is up to date.
 *
 * @param {object} [opts] { env?, fetch?, force?, probes?, cache? } — force skips the cache read,
 *   cache:false skips both read and write (tests / one-off queries).
 * @returns {Promise<{latest,current,updateAvailable,source,sourceLabel,sources,sourcesText,
 *   indeterminate,cached}>}
 */
async function checkForUpdateAll(opts = {}) {
  const current = getCurrentVersion();
  const useCache = opts.cache !== false;
  const cache = useCache ? readCache() : null;
  if (
    !opts.force &&
    cache &&
    cache.checkedAt &&
    Array.isArray(cache.sources) &&
    Date.now() - cache.checkedAt < CHECK_INTERVAL_MS
  ) {
    return {
      latest: cache.latest || null,
      current,
      updateAvailable: !!cache.latest && compareVersions(cache.latest, current) > 0,
      source: cache.source || null,
      sourceLabel: cache.sourceLabel || null,
      sources: cache.sources,
      sourcesText: cache.sourcesText || '',
      indeterminate: !cache.latest,
      cached: true,
    };
  }

  const resolver = require('./latestVersionResolver');
  const resolved = await resolver.resolveLatestVersion(opts);
  const result = {
    latest: resolved.latest,
    current,
    updateAvailable: !!resolved.latest && compareVersions(resolved.latest, current) > 0,
    source: resolved.source,
    sourceLabel: resolved.sourceLabel,
    sources: resolved.sources,
    sourcesText: resolved.text,
    indeterminate: resolved.indeterminate,
    cached: false,
  };
  // Only a determinate answer is cached — caching "查不到" would turn a transient network
  // failure into 4 hours of silence about a real update.
  if (resolved.latest) {
    writeCache({
      latest: resolved.latest,
      source: resolved.source,
      sourceLabel: resolved.sourceLabel,
      sources: resolved.sources,
      sourcesText: resolved.text,
    });
  }
  return result;
}

/**
 * Compare semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a, b) {
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Format update notification string (or empty if up-to-date).
 */
function getUpdateNotice() {
  try {
    const coordinator = require('./updateCoordinator');
    const state = coordinator.readState();
    if (!state || state.state !== 'available' && state.state !== 'staged') {
      return '';
    }
    const current = state.current && (state.current.version || state.current.commit);
    const target = state.target && (state.target.version || state.target.commit);
    if (!target) return '';
    return `更新可用: ${current || '当前版本'} → ${target}  运行 khy update 接受`;
  } catch {
    return '';
  }
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
    if (!gateway.isInitialized()) {
      return { recovered, failed };
    }

    for (const entry of gateway.getAdapters()) {
      if (!entry.enabled || entry.key === 'api' || entry.key === 'relay') {
        continue;
      }

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
          await new Promise((r) => setTimeout(r, 500));
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
  } catch {
    /* gateway not loaded */
  }

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
  checkForUpdateAll,
  compareVersions,
  getUpdateNotice,
  recoverIdeAdapters,
  formatRecoveryMessage,
};
