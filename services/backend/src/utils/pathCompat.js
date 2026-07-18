'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const _DESKTOP_CACHE_TTL_MS = 5 * 60 * 1000;
let _desktopCache = { value: '', at: 0 };

function _expandWindowsEnvVars(input = '') {
  return String(input || '').replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
}

function expandPathVariables(input = '') {
  let out = String(input || '');
  if (!out) return out;

  if (process.platform === 'win32') {
    out = _expandWindowsEnvVars(out);
  } else {
    out = out.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
  }

  if (out.startsWith('~')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return out;
}

function _normalizeForCompare(input = '') {
  return path.normalize(String(input || '')).replace(/[\\/]+$/, '').toLowerCase();
}

function _readDesktopFromRegistry() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
      { encoding: 'utf8', windowsHide: true, timeout: 2500 }
    );
    const line = String(out || '')
      .split(/\r?\n/)
      .find((l) => /\bDesktop\b/i.test(l) && /\bREG_\w+\b/i.test(l));
    if (!line) return '';
    const value = line.replace(/^.*\bREG_\w+\b\s+/i, '').trim();
    if (!value) return '';
    return path.normalize(_expandWindowsEnvVars(value));
  } catch {
    return '';
  }
}

function _readDesktopFromPowerShell() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }
    );
    return path.normalize(String(out || '').trim());
  } catch {
    return '';
  }
}

function getDesktopPath() {
  const now = Date.now();
  if (_desktopCache.value && (now - _desktopCache.at) < _DESKTOP_CACHE_TTL_MS) {
    return _desktopCache.value;
  }

  const fallback = path.join(os.homedir(), 'Desktop');
  const add = (arr, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    arr.push(path.normalize(text));
  };

  let chosen = '';
  if (process.platform === 'win32') {
    const candidates = [];
    add(candidates, process.env.KHY_DESKTOP_DIR);
    add(candidates, _readDesktopFromRegistry());
    add(candidates, _readDesktopFromPowerShell());
    if (process.env.ONEDRIVE || process.env.ONE_DRIVE || process.env.OneDrive) {
      add(candidates, path.join(process.env.ONEDRIVE || process.env.ONE_DRIVE || process.env.OneDrive, 'Desktop'));
    }
    if (process.env.USERPROFILE) add(candidates, path.join(process.env.USERPROFILE, 'Desktop'));
    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      add(candidates, path.join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, 'Desktop'));
    }
    add(candidates, fallback);

    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
          chosen = p;
          break;
        }
      } catch { /* ignore invalid candidate */ }
    }
    if (!chosen) chosen = candidates.find(Boolean) || fallback;
  } else {
    const homeDesktop = path.join(os.homedir(), 'Desktop');
    try {
      chosen = fs.existsSync(homeDesktop) ? homeDesktop : homeDesktop;
    } catch {
      chosen = homeDesktop;
    }
  }

  _desktopCache = { value: chosen, at: now };
  return chosen;
}

function _looksLikeUrl(input = '') {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(input || '').trim());
}

function _convertPosixWindowsMountPath(input = '') {
  const raw = String(input || '');
  if (!raw) return raw;
  // WSL style: /mnt/c/Users/foo -> C:\Users\foo
  const mnt = raw.match(/^\/mnt\/([A-Za-z])(\/|$)/);
  if (mnt) {
    const rest = raw.slice(`/mnt/${mnt[1]}`.length);
    return `${mnt[1].toUpperCase()}:${(rest || '\\').replace(/\//g, '\\')}`;
  }
  // Git Bash / Cygwin style conversions are handled here too:
  // /c/Users/foo, /cygdrive/c/Users/foo
  return posixPathToWindows(raw);
}

function rewriteWindowsDesktopPath(input = '') {
  const raw = String(input || '');
  if (!raw || process.platform !== 'win32' || _looksLikeUrl(raw)) return raw;

  let expanded = expandPathVariables(raw);
  expanded = _convertPosixWindowsMountPath(expanded);
  if (!expanded) return raw;

  const home = os.homedir();
  const homeDesktop = path.join(home, 'Desktop');
  const userDesktop = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Desktop')
    : '';
  const realDesktop = getDesktopPath();
  if (!realDesktop) return raw;

  const realNorm = _normalizeForCompare(realDesktop);
  const homeNorm = _normalizeForCompare(homeDesktop);
  const userNorm = _normalizeForCompare(userDesktop);
  const expandedNorm = _normalizeForCompare(expanded);

  if (realNorm === homeNorm || (userNorm && realNorm === userNorm)) return raw;

  const homePrefix = `${homeNorm}\\`;
  const userPrefix = userNorm ? `${userNorm}\\` : '';
  let suffix = '';
  if (expandedNorm === homeNorm || expandedNorm === userNorm) {
    suffix = '';
  } else if (expandedNorm.startsWith(homePrefix)) {
    suffix = expanded.slice(homeDesktop.length).replace(/^[\\/]+/, '');
  } else if (userPrefix && expandedNorm.startsWith(userPrefix)) {
    suffix = expanded.slice(userDesktop.length).replace(/^[\\/]+/, '');
  } else {
    return raw;
  }

  return suffix ? path.join(realDesktop, suffix) : realDesktop;
}

function normalizePathParam(input = '', cwd = process.cwd()) {
  const raw = String(input || '');
  if (!raw) return raw;
  let normalized = expandPathVariables(raw);
  if (process.platform === 'win32') {
    normalized = _convertPosixWindowsMountPath(normalized);
  }
  normalized = rewriteWindowsDesktopPath(normalized);
  return path.resolve(cwd || process.cwd(), normalized);
}

// ── Windows ↔ POSIX path conversion ────────────────────────────────

/**
 * Convert a Windows path to a POSIX path (for git-bash / WSL).
 * - C:\Users\foo → /c/Users/foo
 * - \\server\share → //server/share
 * - Already POSIX / relative → flip backslashes
 *
 * @param {string} winPath
 * @returns {string}
 */
function windowsPathToPosix(winPath) {
  if (!winPath) return winPath;
  // UNC path: \\server\share → //server/share
  if (winPath.startsWith('\\\\')) return winPath.replace(/\\/g, '/');
  // Drive letter: C:\... → /c/...
  const m = winPath.match(/^([A-Za-z]):[/\\]/);
  if (m) return '/' + m[1].toLowerCase() + winPath.slice(2).replace(/\\/g, '/');
  return winPath.replace(/\\/g, '/');
}

/**
 * Convert a POSIX path to a Windows path.
 * - /mnt/c/Users/foo -> C:\Users\foo
 * - /c/Users/foo → C:\Users\foo
 * - //server/share → \\server\share
 * - /cygdrive/c/... → C:\...
 *
 * @param {string} posixPath
 * @returns {string}
 */
function posixPathToWindows(posixPath) {
  if (!posixPath) return posixPath;
  // UNC: //server/share → \\server\share
  if (posixPath.startsWith('//')) return posixPath.replace(/\//g, '\\');
  // WSL style: /mnt/c/... -> C:\...
  const wsl = posixPath.match(/^\/mnt\/([A-Za-z])(\/|$)/);
  if (wsl) {
    const rest = posixPath.slice(`/mnt/${wsl[1]}`.length);
    return wsl[1].toUpperCase() + ':' + (rest || '\\').replace(/\//g, '\\');
  }
  // cygdrive: /cygdrive/c/... → C:\...
  const cyg = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if (cyg) {
    const rest = posixPath.slice(('/cygdrive/' + cyg[1]).length);
    return cyg[1].toUpperCase() + ':' + (rest || '\\').replace(/\//g, '\\');
  }
  // Git Bash / MSYS2: /c/... → C:\...
  const drv = posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if (drv) {
    const rest = posixPath.slice(2);
    return drv[1].toUpperCase() + ':' + (rest || '\\').replace(/\//g, '\\');
  }
  return posixPath.replace(/\//g, '\\');
}

// ── Unicode NFC normalization ──────────────────────────────────────

/**
 * Normalize a path to NFC form.
 * macOS HFS+ stores filenames in NFD; normalizing to NFC prevents
 * mismatches when comparing paths across platforms.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeUnicodePath(p) {
  if (!p) return p;
  return path.normalize(p).normalize('NFC');
}

// ── Subpath check ──────────────────────────────────────────────────

/**
 * Check if childPath is under parentPath, respecting platform case rules.
 * On Windows, comparison is case-insensitive.
 *
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {boolean}
 */
function isSubpath(parentPath, childPath) {
  const pMod = process.platform === 'win32' ? path.win32 : path;
  const relative = pMod.relative(parentPath, childPath);
  return !relative.startsWith('..' + pMod.sep) && relative !== '..' && !pMod.isAbsolute(relative);
}

module.exports = {
  expandPathVariables,
  getDesktopPath,
  rewriteWindowsDesktopPath,
  normalizePathParam,
  windowsPathToPosix,
  posixPathToWindows,
  normalizeUnicodePath,
  isSubpath,
};
