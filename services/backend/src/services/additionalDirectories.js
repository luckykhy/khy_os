'use strict';

/**
 * Additional working directories (Claude Code `/add-dir` alignment).
 *
 * By default file tools are confined to the project root (KHYQUANT_CWD || cwd)
 * by editBoundaryGuard / pathTraversalGuard. Claude Code lets a user grant the
 * session access to extra directories via `/add-dir` (and the
 * `additionalDirectories` setting); the guards then treat those roots as allowed.
 *
 * This is a single source of truth for that set:
 *   - in-memory for the session (survives across tool calls, not across restarts);
 *   - lazily seeded once from `KHY_ADDITIONAL_DIRS` (path-delimited) so headless
 *     and non-interactive runs can pre-grant directories without a prompt.
 *
 * Security note: granting a directory only relaxes the project-root *boundary*.
 * The sensitive-home-write denylist (SSH keys, shell rc, GPG, autostart, …) in
 * editBoundaryGuard runs BEFORE this allowance and is never bypassed here.
 */

const fs = require('fs');
const path = require('path');

/** @type {Set<string>} normalized absolute directory paths. */
const _dirs = new Set();
let _seeded = false;

function _normalize(abs) {
  // Strip a trailing separator (except for a root like "/") for stable matching.
  if (abs.length > 1 && abs.endsWith(path.sep)) return abs.slice(0, -1);
  return abs;
}

function _seedFromEnv() {
  if (_seeded) return;
  _seeded = true;
  const raw = process.env.KHY_ADDITIONAL_DIRS;
  if (!raw || !String(raw).trim()) return;
  for (const part of String(raw).split(path.delimiter)) {
    const dir = part.trim();
    if (!dir) continue;
    try {
      const abs = _normalize(path.resolve(dir));
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) _dirs.add(abs);
    } catch { /* ignore malformed entry */ }
  }
}

/**
 * Grant the session access to an additional working directory.
 * @param {string} dir - path (relative resolves against opts.cwd or process.cwd()).
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {{ success: boolean, dir?: string, alreadyPresent?: boolean, error?: string }}
 */
function addDirectory(dir, opts = {}) {
  _seedFromEnv();
  const input = String(dir || '').trim();
  if (!input) return { success: false, error: '需要提供目录路径' };
  let abs;
  try {
    abs = _normalize(path.resolve(opts.cwd || process.cwd(), input));
  } catch (err) {
    return { success: false, error: `无法解析路径: ${err.message}` };
  }
  try {
    if (!fs.existsSync(abs)) return { success: false, error: `目录不存在: ${abs}` };
    if (!fs.statSync(abs).isDirectory()) return { success: false, error: `不是目录: ${abs}` };
  } catch (err) {
    return { success: false, error: `无法访问: ${err.message}` };
  }
  const alreadyPresent = _dirs.has(abs);
  _dirs.add(abs);
  return { success: true, dir: abs, alreadyPresent };
}

/** @returns {string[]} the granted directories (absolute, normalized). */
function getDirectories() {
  _seedFromEnv();
  return Array.from(_dirs);
}

/**
 * Is `absPath` the same as, or nested under, any granted additional directory?
 * @param {string} absPath - an already-resolved absolute path.
 * @returns {boolean}
 */
function isUnderAdditionalDir(absPath) {
  _seedFromEnv();
  if (!absPath || _dirs.size === 0) return false;
  let abs;
  try {
    abs = _normalize(path.resolve(absPath));
  } catch {
    return false;
  }
  for (const dir of _dirs) {
    if (abs === dir) return true;
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (abs.startsWith(prefix)) return true;
  }
  return false;
}

/** Test seam: clear the in-memory set and re-arm env seeding. */
function _reset() {
  _dirs.clear();
  _seeded = false;
}

module.exports = {
  addDirectory,
  getDirectories,
  isUnderAdditionalDir,
  _reset,
};
