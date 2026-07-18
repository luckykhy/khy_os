'use strict';

/**
 * diskCleanup/junkCatalog.js — 「可清理垃圾」的单一真源（允许清单，非黑名单）。
 *
 * 教 khyos 清理 C 盘/D 盘的第一原则（对照 cleanupService「Keep this explicit to avoid
 * touching unrelated files」与 [[project_system_drive_safe_storage]]）：
 *
 *   绝不用「黑名单用户数据」的思路去删——用户数据无法穷举，漏一个就是灾难。
 *   只从这份**白名单**里选删除候选：每一条都是公认的机器生成垃圾/缓存/临时文件。
 *   名单之外的一切，默认是用户数据，一律不碰。
 *
 * 每条目录条目结构：
 *   - id        稳定标识
 *   - label     人类可读名
 *   - category  归类（system-temp/recycle/update-cache/browser-cache/pkg-cache/
 *               thumbnail/crash-dump/app-log/project-cache/dev-artifact）
 *   - platforms 适用平台（windows/macos/linux），空=全平台
 *   - resolve   (deps)=>string[]：解析出 0..n 个绝对目录（环境缺失就返回空，绝不抛）
 *   - contentsOnly true=只清目录内容，保留目录本身（默认 true）
 *   - safety    'safe'（纯垃圾，默认可清） | 'review'（涉及可恢复数据，需显式 opt-in）
 *   - reversible 删除是否可逆（缓存→可重建=true；回收站→清空不可逆=false）
 *   - ageHours  仅清理早于该时长的项（默认见 thresholds.defaultAgeHours）
 *   - note      给用户/模型的一句话说明
 *
 * 受保护根（PROTECTED_ROOT_RESOLVERS）与用户数据信号（USER_DATA_SIGNALS）也在这里
 * 集中声明，供 protectedGuard 做「防御纵深」的第二道否决。
 */

const path = require('path');
const os = require('os');

let _platformUtils = null;
function platformUtils() {
  if (!_platformUtils) _platformUtils = require('../../tools/platformUtils');
  return _platformUtils;
}
let _dataHome = null;
function dataHome() {
  if (!_dataHome) _dataHome = require('../../utils/dataHome');
  return _dataHome;
}

function _envInt(name, fallback) {
  const v = parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(v) ? v : fallback;
}

/** 阈值集中声明，环境变量可调（按机器/洁癖程度调档）。 */
const thresholds = {
  // 默认只清早于该时长的项，避免误删「刚生成还在用」的临时文件。
  defaultAgeHours: _envInt('KHY_CLEAN_DEFAULT_AGE_HOURS', 24),
  // 全局 liveness 护栏：任何目录树内若有比这更新的文件，整组跳过（在用判定）。
  keepRecentHours: _envInt('KHY_CLEAN_KEEP_RECENT_HOURS', 2),
  // 单次扫描的目录递归深度上限（防呆，避免深树拖慢/越界）。
  maxScanDepth: _envInt('KHY_CLEAN_MAX_SCAN_DEPTH', 6),
  // 路径段数下限：少于该段数的路径视为「太靠近盘根」一律拒删。
  minPathSegments: _envInt('KHY_CLEAN_MIN_PATH_SEGMENTS', 2),
};

const CATEGORY = {
  SYSTEM_TEMP: 'system-temp',
  RECYCLE: 'recycle',
  UPDATE_CACHE: 'update-cache',
  BROWSER_CACHE: 'browser-cache',
  PKG_CACHE: 'pkg-cache',
  THUMBNAIL: 'thumbnail',
  CRASH_DUMP: 'crash-dump',
  APP_LOG: 'app-log',
  PROJECT_CACHE: 'project-cache',
  DEV_ARTIFACT: 'dev-artifact',
};

const SAFE = 'safe';
const REVIEW = 'review';

// ── 辅助：环境变量目录解析（缺失即空，绝不抛） ──────────────────────────
function _envDir(env, name, ...sub) {
  const base = env[name];
  if (!base || typeof base !== 'string') return [];
  return [path.join(base, ...sub)];
}
function _home(deps, ...sub) {
  return [path.join(deps.homedir, ...sub)];
}
function _exists(deps, p) {
  try { return deps.fsImpl.existsSync(p); } catch { return false; }
}

/**
 * 垃圾目录目录表。resolve 拿 deps={platform,env,homedir,fsImpl} 返回候选绝对路径。
 * 注意：这里只「声明位置」，是否真清由 scanner+protectedGuard+liveness 共同把关。
 */
const ENTRIES = [
  // ── 跨平台：本项目自己的缓存/临时（最安全，纯机器生成，可重建） ──
  {
    id: 'khyos-base-cache',
    label: 'khyos 生态缓存 (~/.khyos/cache)',
    category: CATEGORY.PROJECT_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    resolve: () => {
      try { return [dataHome().getBaseDataDir('cache')]; } catch { return []; }
    },
    note: 'khyos 自身缓存，删后自动重建',
  },
  {
    id: 'khy-data-cache',
    label: 'khy 数据缓存 (data home/cache)',
    category: CATEGORY.PROJECT_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    resolve: () => {
      try { return [dataHome().getDataDir('cache')]; } catch { return []; }
    },
    note: 'khy 运行缓存，可安全重建',
  },

  // ── Windows ───────────────────────────────────────────────────────
  {
    id: 'win-user-temp',
    label: '用户临时目录 (%TEMP%)',
    category: CATEGORY.SYSTEM_TEMP,
    platforms: ['windows'],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => {
      const cands = [];
      cands.push(..._envDir(deps.env, 'TEMP'));
      cands.push(..._envDir(deps.env, 'TMP'));
      cands.push(..._home(deps, 'AppData', 'Local', 'Temp'));
      return _dedupe(cands);
    },
    note: '应用临时文件；早于 24h 的才清，在用文件自动跳过',
  },
  {
    id: 'win-windows-temp',
    label: '系统临时目录 (C:\\Windows\\Temp)',
    category: CATEGORY.SYSTEM_TEMP,
    platforms: ['windows'],
    safety: REVIEW, // 可能需要管理员权限；失败 fail-soft
    reversible: true,
    resolve: (deps) => _envDir(deps.env, 'SystemRoot', 'Temp'),
    note: '系统级临时文件，可能需管理员权限',
  },
  {
    id: 'win-thumbnail-cache',
    label: '缩略图缓存 (thumbcache)',
    category: CATEGORY.THUMBNAIL,
    platforms: ['windows'],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => _home(deps, 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer'),
    note: '资源管理器缩略图缓存，删后按需重建',
    fileGlobOnly: /^(thumbcache|iconcache).*\.db$/i, // 仅清这些 db，保留其他
  },
  {
    id: 'win-crash-dumps',
    label: '崩溃转储 (CrashDumps)',
    category: CATEGORY.CRASH_DUMP,
    platforms: ['windows'],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => _home(deps, 'AppData', 'Local', 'CrashDumps'),
    note: '程序崩溃转储文件，仅排障用',
  },
  {
    id: 'win-chrome-cache',
    label: 'Chrome 网络缓存',
    category: CATEGORY.BROWSER_CACHE,
    platforms: ['windows'],
    safety: SAFE,
    reversible: true,
    // 仅 Cache/Code Cache，绝不碰 profile（书签/Cookie/密码）。
    resolve: (deps) => [
      ..._home(deps, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
      ..._home(deps, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'),
    ],
    note: '仅 HTTP 缓存；不动书签/Cookie/密码/历史',
  },
  {
    id: 'win-edge-cache',
    label: 'Edge 网络缓存',
    category: CATEGORY.BROWSER_CACHE,
    platforms: ['windows'],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => [
      ..._home(deps, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
      ..._home(deps, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'),
    ],
    note: '仅 HTTP 缓存；不动用户配置',
  },
  {
    id: 'win-recycle-bin',
    label: '回收站 ($Recycle.Bin)',
    category: CATEGORY.RECYCLE,
    platforms: ['windows'],
    safety: REVIEW, // 回收站是用户最后的后悔药 → 必须显式 opt-in
    reversible: false,
    perDrive: true, // 每个盘符一个
    resolve: (deps, driveRoot) => {
      const root = driveRoot || deps.env.SystemDrive ? (driveRoot || (deps.env.SystemDrive + '\\')) : null;
      if (!root) return [];
      return [path.join(root, '$Recycle.Bin')];
    },
    note: '清空回收站不可逆——用户删错的文件将无法找回，默认不清',
  },
  {
    id: 'win-update-cache',
    label: 'Windows 更新缓存 (SoftwareDistribution)',
    category: CATEGORY.UPDATE_CACHE,
    platforms: ['windows'],
    safety: REVIEW,
    reversible: true,
    resolve: (deps) => _envDir(deps.env, 'SystemRoot', 'SoftwareDistribution', 'Download'),
    note: '已下载的更新包；需停服务/管理员，谨慎',
  },

  // ── 跨平台开发者缓存（npm/pip/yarn/cargo/gradle 等，可重建） ──
  {
    id: 'npm-cache',
    label: 'npm 缓存',
    category: CATEGORY.PKG_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => {
      const cands = [];
      if (deps.platform === 'windows') cands.push(..._home(deps, 'AppData', 'Roaming', 'npm-cache'));
      cands.push(..._home(deps, '.npm', '_cacache'));
      return _dedupe(cands);
    },
    note: 'npm 下载缓存，删后下次安装自动重建',
  },
  {
    id: 'pip-cache',
    label: 'pip 缓存',
    category: CATEGORY.PKG_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => {
      if (deps.platform === 'windows') return _home(deps, 'AppData', 'Local', 'pip', 'Cache');
      if (deps.platform === 'macos') return _home(deps, 'Library', 'Caches', 'pip');
      return _home(deps, '.cache', 'pip');
    },
    note: 'pip 下载/wheel 缓存，可重建',
  },
  {
    id: 'yarn-cache',
    label: 'yarn 缓存',
    category: CATEGORY.PKG_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    resolve: (deps) => {
      if (deps.platform === 'windows') return _home(deps, 'AppData', 'Local', 'Yarn', 'Cache');
      return _home(deps, '.cache', 'yarn');
    },
    note: 'yarn 包缓存，可重建',
  },
  {
    id: 'cargo-cache',
    label: 'Rust cargo registry 缓存',
    category: CATEGORY.PKG_CACHE,
    platforms: [],
    safety: SAFE,
    reversible: true,
    // 仅 registry/cache 与 git/db，绝不删 registry/src（离线编译可能需要）。
    resolve: (deps) => [
      ..._home(deps, '.cargo', 'registry', 'cache'),
    ],
    note: 'cargo 下载缓存；不动已检出源码',
  },

  // ── macOS ─────────────────────────────────────────────────────────
  {
    id: 'mac-user-caches',
    label: '用户缓存 (~/Library/Caches)',
    category: CATEGORY.APP_LOG,
    platforms: ['macos'],
    safety: REVIEW, // 范围大，部分 App 状态在此 → opt-in
    reversible: true,
    resolve: (deps) => _home(deps, 'Library', 'Caches'),
    note: '应用缓存合集，范围较大，需显式确认',
  },
  {
    id: 'mac-trash',
    label: '废纸篓 (~/.Trash)',
    category: CATEGORY.RECYCLE,
    platforms: ['macos'],
    safety: REVIEW,
    reversible: false,
    resolve: (deps) => _home(deps, '.Trash'),
    note: '清空废纸篓不可逆，默认不清',
  },

  // ── Linux ─────────────────────────────────────────────────────────
  {
    id: 'linux-user-cache',
    label: '用户缓存 (~/.cache)',
    category: CATEGORY.APP_LOG,
    platforms: ['linux'],
    safety: REVIEW,
    reversible: true,
    resolve: (deps) => _home(deps, '.cache'),
    note: 'XDG 缓存目录，范围较大，需显式确认',
  },
  {
    id: 'linux-trash',
    label: '回收站 (~/.local/share/Trash)',
    category: CATEGORY.RECYCLE,
    platforms: ['linux'],
    safety: REVIEW,
    reversible: false,
    resolve: (deps) => _home(deps, '.local', 'share', 'Trash'),
    note: '清空回收站不可逆，默认不清',
  },
];

function _dedupe(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ── 受保护根（绝不删，第二道防线的依据） ───────────────────────────────
//
// 分两档，否则会「自我封死」——主目录与本项目数据家本身就是受保护根，可它们「之内」恰恰
// 装着我们要清的缓存(~/.npm、~/.cache、~/.khyos/cache)。所以：
//
//   · 精确档(EXACT)：只在「路径恰好等于该根」时否决。主目录/数据家本身不可删，
//     但其下白名单里的具体缓存子目录可清。安全由第一道闸(白名单只解析到具体缓存子目录)兜底。
//   · 包含档(CONTAINMENT)：路径「等于或落在其内」即否决。纯用户数据根(文档/桌面/下载/
//     图片/视频/音乐/云盘/程序目录)——里面任何东西都是用户数据，整株不碰。

/**
 * 精确受保护根：仅「恰好等于」时否决（其下白名单缓存子目录仍可清）。
 * @returns {string[]}
 */
const PROTECTED_EXACT_RESOLVERS = [
  // 用户主目录本身（绝不允许把候选解析到 ~ 根，但 ~/ 下的缓存可清）
  (deps) => [deps.homedir],
  // 本项目数据家本身（established-wins，根不可删；但 data home/cache 等子目录可清）
  (deps) => {
    const out = [];
    try { out.push(dataHome().getDataHome()); } catch { /* ignore */ }
    try { out.push(dataHome().getProjectDataHome()); } catch { /* ignore */ }
    try { out.push(dataHome().getBaseHome()); } catch { /* ignore */ }
    try { out.push(dataHome().getLegacyDataHome()); } catch { /* ignore */ }
    return out;
  },
];

/**
 * 包含式受保护根：路径「等于或落在其内」一律否决。纯用户数据根，整株不碰。
 * @returns {string[]}
 */
const PROTECTED_CONTAINMENT_RESOLVERS = [
  // Windows 标准库目录
  (deps) => deps.platform === 'windows' ? [
    ..._home(deps, 'Documents'), ..._home(deps, 'Desktop'), ..._home(deps, 'Downloads'),
    ..._home(deps, 'Pictures'), ..._home(deps, 'Videos'), ..._home(deps, 'Music'),
    ..._envDir(deps.env, 'USERPROFILE', 'Documents'),
    ..._envDir(deps.env, 'OneDrive'),
    ..._envDir(deps.env, 'OneDriveConsumer'),
    ..._envDir(deps.env, 'OneDriveCommercial'),
    // 程序本体目录绝不碰
    ..._envDir(deps.env, 'ProgramFiles'),
    ..._envDir(deps.env, 'ProgramFiles(x86)'),
    ..._envDir(deps.env, 'ProgramData'),
  ] : [],
  // POSIX 标准库目录
  (deps) => deps.platform !== 'windows' ? [
    ..._home(deps, 'Documents'), ..._home(deps, 'Desktop'), ..._home(deps, 'Downloads'),
    ..._home(deps, 'Pictures'), ..._home(deps, 'Movies'), ..._home(deps, 'Music'),
  ] : [],
];

// 向后兼容别名：旧调用把「受保护根」理解为包含式。
const PROTECTED_ROOT_RESOLVERS = PROTECTED_CONTAINMENT_RESOLVERS;

/**
 * 用户数据信号：某候选目录里若出现这些，说明它其实混入了用户数据，
 * 即便位置在白名单，也降级/否决（防御纵深）。
 */
const USER_DATA_SIGNALS = {
  // 版本库 / 源码工程标记
  markers: ['.git', '.svn', '.hg', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml', '.project'],
  // 用户文档类扩展名
  docExtensions: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.psd',
    '.ai', '.sketch', '.key', '.numbers', '.pages', '.odt', '.ods'],
  // 媒体/个人创作（出现即高度可疑）
  mediaExtensions: ['.raw', '.cr2', '.nef', '.arw', '.dng', '.mov', '.mp4', '.heic'],
};

module.exports = {
  thresholds,
  CATEGORY,
  SAFE,
  REVIEW,
  ENTRIES,
  PROTECTED_ROOT_RESOLVERS,
  PROTECTED_EXACT_RESOLVERS,
  PROTECTED_CONTAINMENT_RESOLVERS,
  USER_DATA_SIGNALS,
  // 供测试/外部按平台筛选
  entriesForPlatform(platform) {
    return ENTRIES.filter((e) => !e.platforms || e.platforms.length === 0 || e.platforms.includes(platform));
  },
  // 默认 deps（生产用真实 os/fs），DI 可覆盖
  defaultDeps() {
    return {
      platform: platformUtils().getPlatform(),
      env: process.env,
      homedir: os.homedir(),
      fsImpl: require('fs'),
    };
  },
};
