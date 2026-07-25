'use strict';

/**
 * _userDirs.js — resolve the user's *trusted* write roots.
 *
 * Why this exists:
 *   The write/edit boundary guards anchor on the project CWD. A general
 *   assistant request like "write a file on my Desktop" targets a path OUTSIDE
 *   the project, which the strict path-traversal validator hard-blocks.
 *
 *   On Windows the user's Desktop / Documents / Downloads are frequently
 *   *relocated to another drive* (OneDrive, or Huawei PC Manager moving the
 *   profile to D:\HuaweiMoveData\Users\<name>\Desktop). So we cannot assume
 *   %USERPROFILE%\Desktop — we must read the real known-folder paths from the
 *   registry (HKCU \ ... \ Explorer \ Shell Folders).
 *
 * What it returns:
 *   A small allowlist of absolute roots that are legitimately the user's own
 *   data folders. Writes under these are allowed even when outside the project;
 *   system locations (C:\Windows, Program Files, ...) stay blocked.
 *
 * Escape hatches:
 *   - KHY_WRITE_EXTRA_ROOTS: os-path-delimited list of additional allowed roots.
 *   - KHY_STRICT_WRITE_BOUNDARY=1: disable trusted-root allowance entirely
 *     (callers honour this; this module always reports the real roots).
 */

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let _cache = null;

/** Lowercase on Windows (case-insensitive FS); identity elsewhere. */
function _norm(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Read a Windows known-folder path from the registry "Shell Folders" key.
 * @param {string} valueName e.g. 'Desktop', 'Personal', or a folder GUID.
 * @returns {string|null} expanded absolute path, or null on any failure.
 */
function _winShellFolder(valueName) {
  try {
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v',
        valueName,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 }
    );
    // Line shape: "    Desktop    REG_SZ    D:\HuaweiMoveData\Users\25789\Desktop"
    const m = out.match(new RegExp(`${valueName.replace(/[{}]/g, '\\$&')}\\s+REG_[A-Z_]+\\s+(.+?)\\s*$`, 'm'));
    if (m && m[1]) {
      // Expand embedded %USERPROFILE% style variables.
      return m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
    }
  } catch {
    /* registry unavailable / value missing — fall back to defaults */
  }
  return null;
}

function _computeRoots() {
  const roots = new Set();
  const add = (p) => {
    if (p && String(p).trim()) {
      try { roots.add(path.resolve(String(p).trim())); } catch { /* ignore bad path */ }
    }
  };

  const home = os.homedir();
  add(home);

  if (process.platform === 'win32') {
    // Real (possibly relocated) known folders.
    add(_winShellFolder('Desktop'));
    add(_winShellFolder('Personal')); // Documents
    add(_winShellFolder('{374DE290-123F-4565-9164-39C4925E467B}')); // Downloads
    // Conventional fallbacks under the profile.
    const up = process.env.USERPROFILE;
    if (up) {
      add(up);
      add(path.join(up, 'Desktop'));
      add(path.join(up, 'Documents'));
      add(path.join(up, 'Downloads'));
    }
  } else if (home) {
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
    add(path.join(home, 'Downloads'));
    add(process.env.XDG_DESKTOP_DIR);
    add(process.env.XDG_DOCUMENTS_DIR);
    add(process.env.XDG_DOWNLOAD_DIR);
  }

  // User-configured extra roots (os path delimiter separated).
  const extra = process.env.KHY_WRITE_EXTRA_ROOTS;
  if (extra) {
    for (const r of extra.split(path.delimiter)) add(r);
  }

  return [...roots];
}

/** Trusted absolute write roots (cached). */
function getTrustedUserRoots() {
  if (!_cache) _cache = _computeRoots();
  return _cache;
}

/**
 * Is the given path under one of the user's trusted roots?
 * @param {string} absPath an already-absolute path (or one resolvable from CWD).
 * @returns {boolean}
 */
function isUnderTrustedRoot(absPath) {
  if (!absPath) return false;
  const target = _norm(absPath);
  for (const root of getTrustedUserRoots()) {
    const base = _norm(root);
    const baseSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (target === base || target.startsWith(baseSep)) return true;
  }
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Desktop-semantic normalization
 *
 * Why this exists:
 *   A natural-language request like "在桌面创建一个文件" / "save it to my desktop"
 *   makes the model emit a literal path such as `~/桌面/...` or `~/Desktop/...`.
 *   On a machine whose OS-canonical desktop is `~/Desktop` (what the GUI shows),
 *   a stray same-named folder like `~/桌面` is NOT the desktop — writing there
 *   makes the file "disappear" from the user's point of view.
 *
 *   The fix treats the leading "desktop" word as a *semantic intent*, not a
 *   literal folder, and redirects it to the OS-authoritative desktop:
 *     - Linux : `xdg-user-dir DESKTOP` (the GUI's own answer), then XDG env,
 *               then `~/Desktop`.
 *     - Windows: the Shell Folders "Desktop" known-folder (handles OneDrive /
 *               relocated profiles), then `%USERPROFILE%\Desktop`.
 *     - macOS  : `~/Desktop`.
 *
 * 防呆 (anti-footgun) — when this does NOTHING:
 *   - Only acts on an ABSOLUTE path whose FIRST segment under the home dir is a
 *     known desktop alias. `~/projects/桌面/x` (alias not first) and cwd-relative
 *     paths are left untouched.
 *   - "OS authority wins": if the OS-canonical desktop folder name already EQUALS
 *     the alias the user used (e.g. a zh locale where xdg-user-dir returns 桌面),
 *     it is a no-op — we never rewrite a genuinely-canonical target.
 *   - Disabled entirely by `KHY_NO_DESKTOP_NORMALIZE=1`.
 *   - Best-effort: any failure returns the input path unchanged (callers wrap in
 *     try/catch too), so it can never break a write.
 * ────────────────────────────────────────────────────────────────────────── */

// Localized single-folder names for "Desktop" across common XDG/OS locales.
// Matched case-insensitively against the first path segment under home.
const _DESKTOP_ALIASES = new Set([
  'desktop',          // en
  '桌面',             // zh
  'デスクトップ',      // ja
  '바탕화면',          // ko
  'bureau',           // fr
  'escritorio',       // es
  'schreibtisch',     // de
  'scrivania',        // it
  'bureaublad',       // nl
  'skrivebord',       // da/nb
  'skrivbord',        // sv
  'työpöytä',         // fi
  'pulpit',           // pl
  'plocha',           // cs
  'masaüstü',         // tr
  'área de trabalho', // pt
  'рабочий стол',     // ru
]);

let _desktopCache; // resolved canonical desktop (string) or null; undefined = unresolved

/** Lowercase folder name for case-insensitive alias matching. */
// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _aliasKey = require('../utils/trimLowerCase');

/**
 * Resolve the OS-authoritative path for a known user directory.
 * @param {string} kind currently only 'desktop' is supported.
 * @param {{ _run?: Function, _home?: string }} [opts] test injection.
 * @returns {string|null} absolute path, or null if it cannot be determined.
 */
function resolveSpecialDir(kind, opts = {}) {
  if (_aliasKey(kind) !== 'desktop') return null;
  const home = opts._home || os.homedir();
  if (!home) return null;

  if (process.platform === 'win32') {
    const known = _winShellFolder('Desktop');
    if (known) return path.resolve(known);
    const up = process.env.USERPROFILE || home;
    return path.join(up, 'Desktop');
  }

  if (process.platform === 'darwin') {
    return path.join(home, 'Desktop');
  }

  // Linux / other POSIX: prefer the GUI's own answer.
  const run = opts._run || ((cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000 }));
  try {
    const out = run('xdg-user-dir', ['DESKTOP']);
    const line = String(out || '').trim();
    // xdg-user-dir returns $HOME when unset — that is not a desktop, fall through.
    if (line && path.resolve(line) !== path.resolve(home)) return path.resolve(line);
  } catch {
    /* xdg-user-dir absent (no desktop env) — fall back to env/convention */
  }
  if (process.env.XDG_DESKTOP_DIR) return path.resolve(process.env.XDG_DESKTOP_DIR);
  return path.join(home, 'Desktop');
}

/**
 * Normalize a desktop-alias path to the OS-canonical desktop. See the block
 * comment above for the full 防呆 contract. Pure and side-effect free.
 *
 * @param {string} absPath an absolute path (e.g. after `~` expansion).
 * @param {{ _resolveDesktop?: Function, _home?: string }} [opts] test injection.
 * @returns {string} the normalized path, or the input unchanged when no rule fires.
 */
function normalizeDesktopPath(absPath, opts = {}) {
  if (!absPath || typeof absPath !== 'string') return absPath;
  if (process.env.KHY_NO_DESKTOP_NORMALIZE) return absPath;
  if (!path.isAbsolute(absPath)) return absPath; // cwd-relative ≠ desktop intent

  const home = opts._home || os.homedir();
  if (!home) return absPath;

  const rel = path.relative(home, absPath);
  // Outside home (starts with .. or is itself absolute) → leave untouched.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absPath;

  const segments = rel.split(path.sep).filter(Boolean);
  if (segments.length === 0) return absPath;
  if (!_DESKTOP_ALIASES.has(_aliasKey(segments[0]))) return absPath;

  const resolveDesktop = opts._resolveDesktop || (() => resolveSpecialDir('desktop'));
  let canonical;
  try { canonical = resolveDesktop(); } catch { canonical = null; }
  if (!canonical) return absPath;

  // OS authority wins: if the alias the user used already IS the canonical
  // desktop folder name, this is a genuine target — never rewrite it.
  const aliasBase = _aliasKey(segments[0]);
  const canonicalBase = _aliasKey(path.basename(canonical));
  if (aliasBase === canonicalBase) return absPath;

  return path.join(canonical, ...segments.slice(1));
}

/**
 * Expand a user-supplied tool path to its final ABSOLUTE form, mirroring exactly
 * what the file tools (writeFile / editFile / readFile / createDocument /
 * renderDocument) do internally: env-var expansion → `~` → desktop-semantic
 * normalization → resolve against cwd.
 *
 * Why this is a shared single source:
 *   The write-diff capture must read the BEFORE/AFTER snapshots from the SAME
 *   path the tool actually writes. Resolving the raw param naively
 *   (`path.resolve(cwd, "~/桌面/x")`) yields `<cwd>/~/桌面/x` — a path that never
 *   exists — so before===after==='' and the red/green diff silently collapses to
 *   a no-op. Routing both the tool intent and the diff capture through one
 *   expander keeps them from drifting.
 *
 * Pure & best-effort: any failure falls back to a plain cwd-relative resolve.
 *
 * @param {string} rawPath the raw tool parameter (may contain env vars / ~).
 * @param {string} [cwd] base dir (defaults to KHYQUANT_CWD or process.cwd()).
 * @returns {string} absolute path.
 */
function expandUserPath(rawPath, cwd) {
  const base = cwd || process.env.KHYQUANT_CWD || process.cwd();
  let p = String(rawPath || '');
  try {
    if (process.platform === 'win32') {
      p = p.replace(/%([^%]+)%/g, (_, k) => process.env[k] || `%${k}%`);
    } else {
      p = p.replace(/\$\{?(\w+)\}?/g, (_, k) => process.env[k] || '');
    }
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    const abs = path.isAbsolute(p) ? p : path.resolve(base, p);
    p = normalizeDesktopPath(abs);
  } catch {
    /* fall through to a plain resolve below */
  }
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

/** Clear the cache (mainly for tests / after a known-folder relocation). */
function _clearCache() {
  _cache = null;
  _desktopCache = undefined;
}

module.exports = {
  getTrustedUserRoots,
  isUnderTrustedRoot,
  resolveSpecialDir,
  normalizeDesktopPath,
  expandUserPath,
  _clearCache,
};
