/**
 * storageRoots — cross-platform storage placement policy (single source of truth).
 *
 * Goal: keep khy-generated files OFF the system drive when possible, so a full
 * system drive can never crash the host. Resolution policy for generated files:
 *
 *   1. KHY_OUTPUT_HOME env override
 *   2. current working directory (if writable and its drive has >= minFree)
 *   3. the NON-system drive with the most free space (>= minFree, writable)
 *   4. system-drive default (last resort — never fails, never crashes)
 *
 * Everything here is fail-soft (never throws into startup) and dependency-
 * injectable: every function accepts an optional deps bag ({ platform, env,
 * fsImpl, cwd, homedir }) so tests can simulate any disk layout without real
 * volumes. Free space uses fs.statfsSync (works on Win 11 24H2+, which dropped
 * wmic) and reports `bavail` (space available to an unprivileged user — more
 * honest for "will this fill up" than the `bfree` used by the legacy resolver).
 *
 * This module NEVER copies or moves data — it only selects and creates empty
 * directories. Live-data relocation is exclusively the job of `khy storage
 * migrate` (see cli/handlers/storage.js), honoring the [Eco-Arch-Unresolved]
 * red line in dataHome.js.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GB, mirrors dataHome.js

/* ── deps resolution ──────────────────────────────────────────────────────── */
function _d(deps = {}) {
  return {
    platform: deps.platform || process.platform,
    env: deps.env || process.env,
    fsImpl: deps.fsImpl || fs,
    cwd: deps.cwd || process.cwd(),
    homedir: deps.homedir || os.homedir(),
  };
}

function _ensureDir(dir, fsImpl) {
  try { (fsImpl || fs).mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Absolute root of the system drive.
 * @returns {string} win32 -> "C:\\" (from %SystemDrive%); posix -> "/"
 */
function getSystemDriveRoot(deps = {}) {
  const { platform, env } = _d(deps);
  if (platform === 'win32') {
    const sys = (env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
    return sys + '\\';
  }
  return '/';
}

/**
 * Free bytes available to an unprivileged user on the filesystem holding `root`.
 * @returns {number} 0 on any failure (treated as "no space")
 */
function freeBytesFor(root, deps = {}) {
  const { fsImpl } = _d(deps);
  try {
    const st = fsImpl.statfsSync(root);
    const avail = typeof st.bavail === 'number' ? st.bavail : st.bfree;
    return st.bsize * avail;
  } catch { return 0; }
}

/** Total bytes of the filesystem holding `root` (0 on failure). */
function totalBytesFor(root, deps = {}) {
  const { fsImpl } = _d(deps);
  try {
    const st = fsImpl.statfsSync(root);
    return st.bsize * st.blocks;
  } catch { return 0; }
}

/** True if `dir` is writable (probe only; writes nothing). */
function isWritable(dir, deps = {}) {
  const { fsImpl } = _d(deps);
  try {
    fsImpl.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

/** Device id of `p`, or null if it can't be stat'd. */
function _devOf(p, fsImpl) {
  try { return fsImpl.statSync(p).dev; } catch { return null; }
}

function _isDir(p, fsImpl) {
  try { return fsImpl.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Enumerate writable NON-system drives/volumes with at least `minFreeBytes`
 * free, sorted by free space descending.
 *
 * @returns {Array<{root:string, freeBytes:number, totalBytes:number, writable:boolean}>}
 */
function listNonSystemDrives(deps = {}) {
  const d = _d(deps);
  const minFree = typeof deps.minFreeBytes === 'number' ? deps.minFreeBytes : MIN_FREE_BYTES;
  const { platform, fsImpl } = d;
  const roots = [];

  try {
    if (platform === 'win32') {
      const sysLetter = getSystemDriveRoot(d)[0].toUpperCase();
      for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        if (letter === sysLetter) continue;
        const root = letter + ':\\';
        try {
          if (fsImpl.existsSync(root) && _isDir(root, fsImpl)) roots.push(root);
        } catch { /* drive not ready */ }
      }
    } else if (platform === 'darwin') {
      const rootDev = _devOf('/', fsImpl);
      let names = [];
      try { names = fsImpl.readdirSync('/Volumes'); } catch { names = []; }
      for (const name of names) {
        const vol = path.join('/Volumes', name);
        if (!_isDir(vol, fsImpl)) continue;
        const dev = _devOf(vol, fsImpl);
        if (dev === null || dev === rootDev) continue; // skip system volume
        roots.push(vol);
      }
    } else {
      // linux (and WSL: /mnt/d ...): scan common external mount parents.
      const rootDev = _devOf('/', fsImpl);
      const candidates = [];
      for (const parent of ['/mnt', '/media']) {
        let names = [];
        try { names = fsImpl.readdirSync(parent); } catch { names = []; }
        for (const name of names) candidates.push(path.join(parent, name));
      }
      // /run/media/<user>/<label>
      let users = [];
      try { users = fsImpl.readdirSync('/run/media'); } catch { users = []; }
      for (const u of users) {
        let labels = [];
        try { labels = fsImpl.readdirSync(path.join('/run/media', u)); } catch { labels = []; }
        for (const label of labels) candidates.push(path.join('/run/media', u, label));
      }
      for (const cand of candidates) {
        if (!_isDir(cand, fsImpl)) continue;
        const dev = _devOf(cand, fsImpl);
        if (dev === null || dev === rootDev) continue; // not a separate mount
        roots.push(cand);
      }
    }
  } catch { /* enumeration is best-effort */ }

  const out = [];
  for (const root of roots) {
    const writable = isWritable(root, d);
    const freeBytes = freeBytesFor(root, d);
    if (!writable || freeBytes < minFree) continue;
    out.push({ root, freeBytes, totalBytes: totalBytesFor(root, d), writable });
  }
  out.sort((a, b) => b.freeBytes - a.freeBytes);
  return out;
}

/** Best (largest-free) non-system drive, or null. */
function pickBestNonSystemDrive(deps = {}) {
  const list = listNonSystemDrives(deps);
  return list.length ? list[0] : null;
}

/* ── once-per-process / once-per-machine transparency note ────────────────── */
let _notedThisProcess = false;

/**
 * Print a one-time, truthful note when khy resolves a write location OUTSIDE
 * the system-drive default. State transparency: never suppress the truth — the
 * marker only de-duplicates the friendly hint, and `khy storage status` always
 * reports the real current location regardless.
 */
function noteIfOutsideSystemDrive(info = {}, deps = {}) {
  const { dir, source } = info;
  if (source !== 'non-system-drive') return; // env=explicit, cwd/system=expected
  const { homedir } = _d(deps);
  // Low-level util: render the info color HERE via chalk rather than reaching up
  // into the cli layer (`cli/formatters`). That upward import is a layering
  // inversion that would drag this leaf util into a giant require cycle.
  const say = (msg) => {
    try {
      const chalk = require('chalk');
      console.log(chalk.blue('  ℹ ') + msg);
    } catch { console.log(msg); }
  };
  if (!_notedThisProcess) {
    _notedThisProcess = true;
    const markerDir = path.join(homedir, '.khy');
    const marker = path.join(markerDir, '.location-note-shown');
    let alreadyShown = false;
    try { alreadyShown = fs.existsSync(marker); } catch { /* ignore */ }
    if (!alreadyShown) {
      try { _ensureDir(markerDir, fs); fs.writeFileSync(marker, new Date().toISOString()); } catch { /* best-effort */ }
    }
    say(`khy 已将大体量文件写入非系统盘以保护系统盘：${dir}`);
    say('  （可用 KHY_OUTPUT_HOME 指定位置；运行 `khy storage status` 查看全部存储位置）');
  }
}

/**
 * Resolve where a generated-file subtree should live.
 *
 * @param {object} opts
 * @param {string} opts.subdir       Subdirectory under the chosen root.
 * @param {boolean} [opts.preferCwd] Prefer the cwd when it has room (default true).
 *                                   Bulk sinks (models, task logs) pass false.
 * @param {number} [opts.minFreeBytes]
 * @param {object} [opts.deps]       DI bag.
 * @returns {{dir:string, source:'env'|'cwd'|'non-system-drive'|'system'}}
 */
function resolveGeneratedFileDir(opts = {}) {
  const { subdir = '', preferCwd = true } = opts;
  const minFree = typeof opts.minFreeBytes === 'number' ? opts.minFreeBytes : MIN_FREE_BYTES;
  const d = _d(opts.deps);
  const { env, fsImpl, cwd } = d;

  // 1. Explicit override
  if (env.KHY_OUTPUT_HOME) {
    const dir = path.join(env.KHY_OUTPUT_HOME, subdir);
    _ensureDir(dir, fsImpl);
    return { dir, source: 'env' };
  }

  // 2. Current working directory (when it has room)
  if (preferCwd) {
    try {
      if (isWritable(cwd, d) && freeBytesFor(cwd, d) >= minFree) {
        const dir = path.join(cwd, subdir);
        _ensureDir(dir, fsImpl);
        return { dir, source: 'cwd' };
      }
    } catch { /* fall through */ }
  }

  // 3. Largest-free non-system drive
  const best = pickBestNonSystemDrive({ ...opts.deps, minFreeBytes: minFree });
  if (best) {
    const dir = path.join(best.root, '.khy', subdir);
    _ensureDir(dir, fsImpl);
    const result = { dir, source: 'non-system-drive' };
    try { noteIfOutsideSystemDrive(result, opts.deps); } catch { /* best-effort */ }
    return result;
  }

  // 4. System-drive default (never crashes). Honor the resolved data home via
  // KHY_DATA_HOME — checked first on the injected env (test override), then on
  // the live process env, which dataHome writes back once it resolves a pinned
  // location — else ~/.khy. Deliberately does NOT import dataHome's resolver
  // here: importing the higher-level dataHome from this leaf util forms a
  // require cycle (dataHome already depends on storageRoots), and that cycle
  // dragged the whole low-level storage layer into a giant dependency knot.
  const dataHomeBase = env.KHY_DATA_HOME || process.env.KHY_DATA_HOME;
  const base = dataHomeBase || path.join(d.homedir, '.khy');
  const dir = path.join(base, subdir);
  try { _ensureDir(dir, fsImpl); } catch { /* never crash on the final fallback */ }
  return { dir, source: 'system' };
}

module.exports = {
  MIN_FREE_BYTES,
  getSystemDriveRoot,
  freeBytesFor,
  totalBytesFor,
  isWritable,
  listNonSystemDrives,
  pickBestNonSystemDrive,
  resolveGeneratedFileDir,
  noteIfOutsideSystemDrive,
  _resetNoteFlag: () => { _notedThisProcess = false; },
};
