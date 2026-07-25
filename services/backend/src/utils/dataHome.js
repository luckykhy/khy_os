/**
 * Resolve khy OS data home directory.
 *
 * Resolution order (system-drive-safe — see storageRoots.js):
 *   1. KHY_DATA_HOME environment variable (explicit override)
 *   2. pinned pointer (~/.khy/.location.json) — only when its target still exists
 *   3. established-wins: an existing non-empty ~/.khy is pinned in place
 *   4. fresh install: the largest-free NON-system drive (>=1GB), then pinned
 *   5. ~/.khy  (default fallback — never fails, never crashes)
 *
 * Legacy compatibility:
 *   - legacy data home: ~/.khyquant
 *
 * All services should use getDataHome() instead of hardcoding os.homedir().
 *
 * ── 生态架构路径所有权标准（khyos 生态）──────────────────────────────
 *   底座（khyos）归属: ~/.khyos/{data,cache,models,logs}   ← getBaseHome()
 *   应用（khyquant）归属: ~/.khyquant 或 ~/.khy（现状数据家）  ← getDataHome()
 *   红线：底座与应用各自独立，禁止互相直接读写对方目录/DB 文件；
 *         跨域取数须走对方暴露的公共 API，不得跨库直连 SQL。
 *
 *   注：getBaseHome() 为新增的「底座归属」解析器，当前后端主要承载 khyquant
 *   应用，应用数据维持在现有数据家（不迁移，保证运行系统不被破坏）。真正把
 *   混用的硬编码 ~/.khyquant 与解析器 ~/.khy 统一、以及底座/应用表物理拆分，
 *   涉及活体数据迁移，须人工评估后单独执行，见下方 [Eco-Arch-Unresolved]。
 *
 *   系统盘保护：本解析器只「选择」并「创建空目录」，绝不复制/移动既有数据。
 *   既有非空数据家一律 established-wins 原地钉死；把活体数据搬到非系统盘是
 *   `khy storage migrate` 的显式、可回滚职责，绝不在解析器里自动发生。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GB minimum (mirrors storageRoots.js)
const STORAGE_POINTER_VERSION = 1;

let _cached = null;
let _cachedBaseHome = null;
let _cachedAppHome = null;

function getLegacyDataHome() {
  return path.join(os.homedir(), '.khyquant');
}

// TODO: [Eco-Arch-Unresolved] 现状存在两类「应用数据家」混用：
//   - 统一解析器 getDataHome() 默认 ~/.khy
//   - 多个服务（cleanupService/skillRegistry/adminService 等）硬编码 ~/.khyquant
// 将二者收敛到单一应用数据家、并将真正归属底座的表/文件迁出到 ~/.khyos，
// 属活体数据迁移，需人工设计迁移脚本（含回滚），不在无人值守流程内盲目执行。
//
// 收敛第一步（停止新增分叉，零数据丢失）：getAppHome() 是「应用数据家」的
// 唯一解析器。新增/改造的写入点必须经它而非再硬写 os.homedir()+'.khyquant'。
// 语义：legacy ~/.khyquant 若已有真实数据则 established-wins 原地继续读写
// （现有安装行为完全不变、绝不迁移）；否则收敛到统一解析器 getDataHome()
// 默认 ~/.khy。这样应用数据家只在「无遗留数据」的全新安装上收敛，老用户零感知。

/* ── pinned pointer (breadcrumb) ──────────────────────────────────────────────
 * The pointer ALWAYS lives on the system drive (under ~/.khy) so that, even when
 * the data home itself is relocated to e.g. D:\.khy, the breadcrumb is never lost
 * (no circular dependency). It records the resolved location so reboots / drive
 * enumeration changes never flip-flop the home, and a relocated home is never
 * "forgotten". */
function _pointerFile() {
  if (process.env.KHY_LOCATION_FILE) return path.resolve(process.env.KHY_LOCATION_FILE);
  return path.join(os.homedir(), '.khy', '.location.json');
}

function _readPointer() {
  try {
    const raw = fs.readFileSync(_pointerFile(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch { /* missing/corrupt → treated as no pointer */ }
  return null;
}

/** Merge `patch` into the pointer and write atomically (temp + rename). */
function _writePointer(patch) {
  try {
    const file = _pointerFile();
    _ensureDir(path.dirname(file));
    const prev = _readPointer() || {};
    const next = {
      version: STORAGE_POINTER_VERSION,
      ...prev,
      ...patch,
      pinnedAt: new Date().toISOString(),
    };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return next;
  } catch { return null; }
}

function _exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** A data home is "established" if it exists and holds real content. */
function _isEstablished(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const ignore = new Set(['.location.json', '.location-note-shown']);
    return fs.readdirSync(dir).some((n) => !ignore.has(n));
  } catch { return false; }
}

/**
 * Print a yellow warning line. Low-level util: render the color HERE via chalk
 * rather than reaching up into the cli layer (`cli/formatters`). That upward
 * import is a layering inversion that would drag this leaf util — and every
 * module that imports it — into a giant require cycle. chalk is a leaf npm dep.
 */
function _warnLine(msg) {
  try {
    const chalk = require('chalk');
    console.warn(chalk.yellow('  ⚠ ') + msg);
  } catch { try { console.warn('  ⚠ ' + msg); } catch { /* ignore */ } }
}

/** Loud, truthful warning when a pinned target is currently unreachable. */
function _warnPointerTargetMissing(missingPath, fallback) {
  _warnLine(`khy 数据家位置 ${missingPath} 当前不可访问（可能是可移动盘未挂载）。`);
  _warnLine(`本次临时使用 ${fallback}；重新挂载该盘即恢复（不会迁移或新建数据，运行 \`khy storage status\` 查看）。`);
}

/**
 * Get the khy OS data home directory path.
 * @returns {string} Absolute path to data directory (created if necessary)
 */
function getDataHome() {
  if (_cached) return _cached;

  // 1. Explicit override
  if (process.env.KHY_DATA_HOME) {
    _cached = process.env.KHY_DATA_HOME;
    _ensureDir(_cached);
    return _cached;
  }

  const systemDefault = path.join(os.homedir(), '.khy');

  // 2. Pinned pointer — honor only if the target still exists on disk.
  const pointer = _readPointer();
  if (pointer && pointer.dataHome) {
    if (_exists(pointer.dataHome)) {
      _cached = pointer.dataHome;
      _ensureDir(_cached);
      process.env.KHY_DATA_HOME = _cached;
      return _cached;
    }
    // Target missing (removable drive unplugged): warn LOUDLY, fall back to the
    // system default for THIS run only. DO NOT rewrite the pointer and DO NOT
    // auto-pick a new drive — re-attaching restores; never fork a divergent home.
    _warnPointerTargetMissing(pointer.dataHome, systemDefault);
    _cached = systemDefault;
    _ensureDir(_cached);
    process.env.KHY_DATA_HOME = _cached;
    return _cached;
  }

  // 3. Established-wins: an existing non-empty ~/.khy is pinned in place.
  if (_isEstablished(systemDefault)) {
    return _pinDataHome(systemDefault, 'established-wins', 'system');
  }

  // 4. Fresh install: auto-pick the largest-free non-system drive, if any.
  try {
    const sr = require('./storageRoots');
    const best = sr.pickBestNonSystemDrive();
    if (best) {
      const dir = path.join(best.root, '.khy');
      const result = _pinDataHome(dir, 'fresh-auto-pick', 'non-system-drive');
      try { sr.noteIfOutsideSystemDrive({ dir, source: 'non-system-drive' }); } catch { /* best-effort */ }
      return result;
    }
  } catch { /* storageRoots unavailable → system default */ }

  // 5. System-drive default.
  return _pinDataHome(systemDefault, 'system-default', 'system');
}

function _pinDataHome(dir, reason, source) {
  _ensureDir(dir);
  _cached = dir;
  process.env.KHY_DATA_HOME = dir;
  _writePointer({ dataHome: dir, source, pinnedReason: reason });
  return dir;
}

/**
 * Get a subdirectory under data home.
 * @param {...string} segments Path segments relative to data home
 * @returns {string} Absolute path (directory created)
 */
function getDataDir(...segments) {
  const dir = path.join(getDataHome(), ...segments);
  _ensureDir(dir);
  return dir;
}

let _cachedAppRoot = null;
let _cachedProjectDataHome = null;

/**
 * Resolve the KHY-OS project/install root.
 *
 * This file lives at <root>/services/backend/src/utils/dataHome.js, so the
 * root is four levels up (utils -> src -> backend -> services -> root).
 * Overridable via KHY_OS_ROOT.
 *
 * @returns {string} Absolute path to the KHY-OS project root
 */
function getAppRoot() {
  if (_cachedAppRoot) return _cachedAppRoot;
  if (process.env.KHY_OS_ROOT) {
    _cachedAppRoot = path.resolve(process.env.KHY_OS_ROOT);
    return _cachedAppRoot;
  }
  _cachedAppRoot = path.resolve(__dirname, '..', '..', '..', '..');
  return _cachedAppRoot;
}

/**
 * Get the project-scoped data home (sessions/trajectories/memory).
 *
 * Same system-drive-safe policy as getDataHome(), but MORE CONSERVATIVE because
 * it hosts live sessions/DB/memory: an existing non-empty <appRoot>/.khy is
 * always pinned in place (the common case for existing installs — never moved).
 * Only a truly fresh project home relocates to a non-system drive.
 * Overridable via KHY_PROJECT_DATA_HOME (takes precedence over KHY_OS_ROOT).
 *
 * @returns {string} Absolute path (created if necessary)
 */
function getProjectDataHome() {
  if (_cachedProjectDataHome) return _cachedProjectDataHome;

  // 1. Explicit override
  if (process.env.KHY_PROJECT_DATA_HOME) {
    _cachedProjectDataHome = path.resolve(process.env.KHY_PROJECT_DATA_HOME);
    _ensureDir(_cachedProjectDataHome);
    _ensureVisibleAlias(_cachedProjectDataHome);
    return _cachedProjectDataHome;
  }

  const appDefault = path.join(getAppRoot(), '.khy');

  // 2. Pinned pointer — honor only if the target still exists.
  const pointer = _readPointer();
  if (pointer && pointer.projectDataHome) {
    if (_exists(pointer.projectDataHome)) {
      _cachedProjectDataHome = pointer.projectDataHome;
      _ensureDir(_cachedProjectDataHome);
      _ensureVisibleAlias(_cachedProjectDataHome, getAppRoot());
      return _cachedProjectDataHome;
    }
    _warnPointerTargetMissing(pointer.projectDataHome, appDefault);
    _cachedProjectDataHome = appDefault;
    _ensureDir(_cachedProjectDataHome);
    _ensureVisibleAlias(_cachedProjectDataHome);
    return _cachedProjectDataHome;
  }

  // 3. Established-wins: existing non-empty <appRoot>/.khy pinned in place.
  if (_isEstablished(appDefault)) {
    return _pinProjectDataHome(appDefault, 'established-wins', 'system');
  }

  // 4. Fresh: auto-pick the largest-free non-system drive, if any.
  try {
    const sr = require('./storageRoots');
    const best = sr.pickBestNonSystemDrive();
    if (best) {
      const dir = path.join(best.root, '.khy-project');
      const result = _pinProjectDataHome(dir, 'fresh-auto-pick', 'non-system-drive');
      try { sr.noteIfOutsideSystemDrive({ dir, source: 'non-system-drive' }); } catch { /* best-effort */ }
      return result;
    }
  } catch { /* storageRoots unavailable → default */ }

  // 5. Default <appRoot>/.khy
  return _pinProjectDataHome(appDefault, 'system-default', 'system');
}

function _pinProjectDataHome(dir, reason, source) {
  _ensureDir(dir);
  _cachedProjectDataHome = dir;
  _writePointer({ projectDataHome: dir, projectSource: source, projectPinnedReason: reason });
  _ensureVisibleAlias(dir, getAppRoot());
  return dir;
}

/**
 * Maintain a non-hidden alias (`khy-Trajectory`) so the trajectory directory is
 * visible in file managers and `ls` without renaming `.khy` (referenced in ~256
 * code sites). The alias lives beside `aliasDir` (defaults to the target's
 * parent) and points at the ABSOLUTE target — so it stays valid even when the
 * real data home is relocated to another volume.
 *
 * Regenerated on every startup: both `.khy` and `khy-Trajectory` are gitignored
 * and never shipped, so this is what makes the visible alias reappear after a
 * fresh install on any machine. Fail-soft and idempotent — never clobbers a
 * real directory and never blocks startup.
 */
function _ensureVisibleAlias(targetDir, aliasDir) {
  try {
    const base = aliasDir || path.dirname(targetDir);
    const aliasPath = path.join(base, 'khy-Trajectory');
    if (path.resolve(aliasPath) === path.resolve(targetDir)) return; // never alias onto itself
    const stat = fs.lstatSync(aliasPath, { throwIfNoEntry: false });
    if (stat) {
      // Already a symlink/junction → assume correct, leave it.
      // A real file/dir under this name → do not clobber user data.
      return;
    }
    if (process.platform === 'win32') {
      fs.symlinkSync(targetDir, aliasPath, 'junction');
    } else {
      // Absolute target: works across volumes (a relative basename link would
      // dangle once the real home is on a different drive).
      fs.symlinkSync(targetDir, aliasPath);
    }
  } catch { /* alias is best-effort; never block startup */ }
}

/**
 * Get a subdirectory under the project-scoped data home.
 * @param {...string} segments Path segments relative to the project data home
 * @returns {string} Absolute path (directory created)
 */
function getProjectDataDir(...segments) {
  const dir = path.join(getProjectDataHome(), ...segments);
  _ensureDir(dir);
  return dir;
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Gate: KHY_APP_HOME_LIVE_RESOLVE (default ON). When on, getAppHome() does NOT
 * cache the non-established fallback, so a reader re-checks legacy establishment
 * on every call and converges onto ~/.khyquant once a producer writes it (timely
 * admin↔user sync). Off ({0,false,off,no}) → historical freeze-on-first-call.
 */
function _appHomeLiveResolveEnabled() {
  const raw = process.env.KHY_APP_HOME_LIVE_RESOLVE;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Get the APPLICATION data home — the single source of truth for service data
 * that historically hardcoded `os.homedir()/.khyquant`.
 *
 * Resolution (legacy-safe, zero migration):
 *   1. KHY_APP_HOME explicit override.
 *   2. established-wins: if legacy ~/.khyquant already holds real data, keep
 *      reading it in place (existing installs behave EXACTLY as before — no
 *      data is moved, copied, or hidden).
 *   3. otherwise converge on the unified resolver getDataHome() (~/.khy).
 *
 * This stops new write sites from forking onto a fourth divergent root: every
 * service that used to do `path.join(os.homedir(), '.khyquant', …)` should call
 * getAppHome()/getAppDataDir() instead. See [Eco-Arch-Unresolved] above.
 *
 * @returns {string} Absolute path to the application data home (created)
 */
function getAppHome() {
  if (_cachedAppHome) return _cachedAppHome;
  if (process.env.KHY_APP_HOME) {
    _cachedAppHome = path.resolve(process.env.KHY_APP_HOME);
    _ensureDir(_cachedAppHome);
    return _cachedAppHome;
  }
  const legacy = getLegacyDataHome();
  if (_isEstablished(legacy)) {
    // Legacy establishment is monotonic within a process (content is not
    // removed) → this decision is stable, so cache it.
    _cachedAppHome = legacy;
    _ensureDir(_cachedAppHome);
    return _cachedAppHome;
  }
  // Legacy ~/.khyquant not yet established → fall back to the unified resolver.
  //
  // 及时同步(admin↔user data):this fallback is NOT stable — a data producer
  // (growthService/tokenUsageService/userProfile/… which write ~/.khyquant) may
  // establish the legacy home LATER in the same process. If we cache the
  // fallback here, an early reader (e.g. adminService, resolved at require time)
  // is pinned to the empty ~/.khy for the whole process and never converges onto
  // the user data — the admin dashboard shows empty/parallel stores until a
  // restart. Leaving it uncached lets the NEXT call upgrade to the now-established
  // legacy home, so admin and user data converge in a timely manner.
  //
  // Gate off (KHY_APP_HOME_LIVE_RESOLVE={0,false,off,no}) → byte-revert to the
  // historical freeze-on-first-call behavior.
  if (_appHomeLiveResolveEnabled()) {
    return getDataHome();
  }
  _cachedAppHome = getDataHome();
  return _cachedAppHome;
}

/**
 * Get a subdirectory under the application data home.
 * @param {...string} segments Path segments relative to the application home
 * @returns {string} Absolute path (directory created)
 */
function getAppDataDir(...segments) {
  const dir = path.join(getAppHome(), ...segments);
  _ensureDir(dir);
  return dir;
}

/**
 * Get the ECOSYSTEM BASE (khyos) data home: ~/.khyos
 *
 * This is the base platform's own data territory, kept physically separate from
 * any application's home (e.g. khyquant's ~/.khyquant). Override via KHYOS_HOME.
 *
 * Additive by design: nothing is migrated here automatically — it establishes
 * the standard location for genuinely base-owned data going forward.
 *
 * @returns {string} Absolute path to ~/.khyos (created if necessary)
 */
function getBaseHome() {
  if (_cachedBaseHome) return _cachedBaseHome;
  if (process.env.KHYOS_HOME) {
    _cachedBaseHome = path.resolve(process.env.KHYOS_HOME);
  } else {
    _cachedBaseHome = path.join(os.homedir(), '.khyos');
  }
  _ensureDir(_cachedBaseHome);
  return _cachedBaseHome;
}

/**
 * Get a subdirectory under the base (khyos) data home.
 * @param {...string} segments Path segments relative to the base home
 * @returns {string} Absolute path (directory created)
 */
function getBaseDataDir(...segments) {
  const dir = path.join(getBaseHome(), ...segments);
  _ensureDir(dir);
  return dir;
}

/**
 * Build a read-only report of where every home currently resolves, plus disk
 * facts. Backs `khy storage status`. Resolving the homes pins the pointer (the
 * status command intentionally reports the real, stable location).
 */
function getStorageReport() {
  let sr = null;
  try { sr = require('./storageRoots'); } catch { /* optional */ }
  const systemRoot = sr ? sr.getSystemDriveRoot()
    : (process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/');
  return {
    homes: {
      dataHome: getDataHome(),
      projectDataHome: getProjectDataHome(),
      baseHome: getBaseHome(),
    },
    pointer: _readPointer(),
    pointerFile: _pointerFile(),
    systemRoot,
    systemFree: sr ? sr.freeBytesFor(systemRoot) : 0,
    systemTotal: sr ? sr.totalBytesFor(systemRoot) : 0,
    nonSystemDrives: sr ? sr.listNonSystemDrives() : [],
  };
}

/** Test helper: clear all resolution caches so policy re-runs from scratch. */
function _resetStorageCaches() {
  _cached = null;
  _cachedBaseHome = null;
  _cachedAppHome = null;
  _cachedAppRoot = null;
  _cachedProjectDataHome = null;
}

module.exports = {
  getDataHome,
  getDataDir,
  getLegacyDataHome,
  getAppHome,
  getAppDataDir,
  _appHomeLiveResolveEnabled,
  getAppRoot,
  getProjectDataHome,
  getProjectDataDir,
  getBaseHome,
  getBaseDataDir,
  getStorageReport,
  // pointer/internal helpers (used by cli/handlers/storage.js and tests)
  _readPointer,
  _writePointer,
  _pointerFile,
  _isEstablished,
  _resetStorageCaches,
};
