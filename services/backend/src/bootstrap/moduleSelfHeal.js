'use strict';

/**
 * moduleSelfHeal.js — Self-healing require hook for MODULE_NOT_FOUND errors.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * When a require path is wrong (e.g. `../../../services/foo` but the file is
 * actually at `../../../utils/foo`), Node throws MODULE_NOT_FOUND with no
 * recovery path. The CLI crashes and the user must manually trace the error
 * to the correct location.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Install a Module._resolveFilename hook that:
 *   1. Lets Node try normal resolution first (zero overhead on happy path).
 *   2. On MODULE_NOT_FOUND, extracts the basename from the failed path.
 *   3. Searches the backend src/ tree for a file with that basename.
 *   4. If exactly one match is found, resolves to it (self-heal).
 *   5. If multiple matches, tries to find one whose relative path from the
 *      caller is closest to the original intent (partial directory match).
 *
 * Design constraints (same as other bootstrap modules):
 *   - Fail-soft: any internal error silently falls through to the original
 *     MODULE_NOT_FOUND (no加重致命路径).
 *   - Zero overhead on happy path: the hook only runs the search on failure.
 *   - Idempotent: calling install() twice is safe (only hooks once).
 *   - Controlled by KHY_MODULE_SELF_HEAL env (default-on, off: 0/false/off/no).
 *   - Transparent: logs self-heal actions to stderr for debuggability.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

// ── Gate ───────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env = process.env) {
  const v = env.KHY_MODULE_SELF_HEAL;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── Module index (lazy-built on first miss) ────────────────────────────────
let _index = null;    // Map<basename, absolutePath[]>
let _indexDir = null; // directory that was scanned

/**
 * Recursively scan a directory for .js files, returning [basename, absolutePath]
 * pairs. Skips node_modules, dist, build, .git, __tests__ directories.
 * Caps at maxFiles to prevent runaway scans on huge trees.
 */
function _scanDir(dir, results, depth, maxDepth, maxFiles) {
  if (depth > maxDepth || results.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission error or gone — skip silently
  }
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (!entry.isDirectory() && !entry.name.endsWith('.js')) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip non-source directories
      if (entry.name === 'node_modules' || entry.name === 'dist' ||
          entry.name === 'build' || entry.name === '.git' ||
          entry.name === '__tests__' || entry.name === 'test' ||
          entry.name === 'tests') {
        continue;
      }
      _scanDir(fullPath, results, depth + 1, maxDepth, maxFiles);
    } else {
      // Strip .js extension to get module name
      const modName = entry.name.slice(0, -3);
      results.push([modName, fullPath]);
    }
  }
}

/**
 * Build the module index from the backend src/ directory.
 * Returns a Map<basename, absolutePath[]>.
 */
function _buildIndex() {
  // src/bootstrap/moduleSelfHeal.js → src/ is two levels up
  const srcDir = path.resolve(__dirname, '..');
  const results = [];
  _scanDir(srcDir, results, 0, 8, 5000);

  const map = new Map();
  for (const [name, absPath] of results) {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(absPath);
  }
  _index = map;
  _indexDir = srcDir;
  return map;
}

function _ensureIndex() {
  if (!_index) _buildIndex();
  return _index;
}

// ── Self-heal resolution ───────────────────────────────────────────────────

/**
 * Given a failed require request, attempt to find the correct module.
 * Returns the resolved absolute path, or undefined if no heal is possible.
 */
function _tryHeal(requiredModule, parentFilename) {
  try {
    // Only heal relative paths (starts with . or ..)
    if (!requiredModule.startsWith('.')) return undefined;

    const index = _ensureIndex();

    // Extract basename (last segment, strip .js if present)
    const basename = path.basename(requiredModule, '.js');
    if (!basename) return undefined;

    const candidates = index.get(basename);
    if (!candidates || candidates.length === 0) return undefined;

    if (candidates.length === 1) {
      // Single match — high confidence, use it
      return candidates[0];
    }

    // Multiple matches — try to find the best match by partial path overlap
    const failedParts = requiredModule.split(path.sep).filter(Boolean);
    // Remove the basename itself; what's left are the directory parts
    const failedDirs = failedParts.slice(0, -1);

    let bestMatch = null;
    let bestScore = -1;

    for (const candidate of candidates) {
      // Score: how many trailing directory components overlap with the failed path
      const candidateRel = path.relative(_indexDir, candidate);
      const candidateParts = candidateRel.split(path.sep);
      // Remove basename
      const candidateDirs = candidateParts.slice(0, -1);

      // Check overlap from the end (trailing dirs matter more)
      let score = 0;
      const minLen = Math.min(failedDirs.length, candidateDirs.length);
      for (let i = 1; i <= minLen; i++) {
        if (failedDirs[failedDirs.length - i] === candidateDirs[candidateDirs.length - i]) {
          score++;
        } else {
          break;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    // Require at least 1 matching directory component for multi-match confidence
    if (bestMatch && bestScore >= 1) {
      return bestMatch;
    }

    return undefined;
  } catch {
    return undefined; // any error → no heal
  }
}

// ── Hook installation ──────────────────────────────────────────────────────
let _installed = false;
const _healLog = []; // recent heals for diagnostics

/**
 * Install the self-heal hook into Module._resolveFilename.
 * Must be called once, early in bootstrap, before heavy requires.
 */
function install(env = process.env) {
  if (_installed) return false;
  if (!isEnabled(env)) return false;

  const original = Module._resolveFilename;
  _installed = true;

  Module._resolveFilename = function _selfHealingResolve(request, parent, isMain, options) {
    try {
      return original.call(this, request, parent, isMain, options);
    } catch (err) {
      // Only handle MODULE_NOT_FOUND with relative paths
      if (err && err.code === 'MODULE_NOT_FOUND' && request.startsWith('.')) {
        const parentFile = parent && parent.filename;
        const healed = _tryHeal(request, parentFile);
        if (healed) {
          // Log the heal (limited to last 20 entries for diagnostics)
          const entry = {
            ts: new Date().toISOString(),
            from: parentFile ? path.relative(process.cwd(), parentFile) : '?',
            requested: request,
            healedTo: path.relative(process.cwd(), healed),
          };
          _healLog.push(entry);
          if (_healLog.length > 20) _healLog.shift();

          // Transparency: log to stderr (visible in debug, hidden in normal use)
          if (env.KHY_MODULE_SELF_HEAL_DEBUG === '1' || env.KHY_DEBUG === '1') {
            try {
              process.stderr.write(
                `[module-self-heal] ${entry.from}: require('${entry.requested}') → ${entry.healedTo}\n`
              );
            } catch { /* stderr unavailable */ }
          }

          // Resolve the healed path through Node's normal resolution
          return original.call(this, healed, parent, isMain, options);
        }
      }
      throw err; // not healable → re-throw original error
    }
  };

  return true;
}

/**
 * Get the self-heal log (for `khy doctor` or diagnostics).
 */
function getHealLog() {
  return [..._healLog];
}

/**
 * Check if the hook is installed.
 */
function isInstalled() {
  return _installed;
}

module.exports = {
  install,
  isEnabled,
  getHealLog,
  isInstalled,
  // Expose for testing
  __test__: {
    _tryHeal,
    _buildIndex,
    _ensureIndex,
    _scanDir,
  },
};
