'use strict';

/**
 * diskAnalyzeCatalog.js — 纯叶子:DiskAnalyze 工具的「分类 / 阈值 / 去重分组」**决策层**。
 *
 * 为什么单独抽出:磁盘分析(找大文件 / 旧安装包 / 重复文件)的**判定规则**——某扩展名算不算
 * 安装包、多大才算大文件、多旧才算「旧安装包」、按大小分组后哪些候选进 hash——是纯逻辑,可与
 * 真正读盘的 walker.js(服务,做 fs/crypto)彻底分离。规则集中在此,便于确定性测试、门控回退。
 *
 * 契约:零 I/O(不碰 fs / 网络 / 子进程 / crypto,只对已读到的 {path,size,mtimeMs} 元数据做判定)、
 * 确定性(无时钟/随机;年龄判定所需的 now 由调用方注入)、绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_DISKANALYZE_CATALOG  默认 on —— 分类/分组决策总开关。
 *     关 ⇒ isInstaller 恒 false、groupBySize 恒返 []。安装包与重复文件两类降级为空(逐字节回退),
 *     大文件一类仍可由 walker/facade 依 minSize 阈值独立算出(阈值解析不受本门控约束)。
 *   数值阈值(numeric,经 flagRegistry.resolveNumeric,不可用则本地 clamp):
 *     KHY_DISKANALYZE_MIN_SIZE_MB          默认 100  —— 大文件下限(MB)。
 *     KHY_DISKANALYZE_OLD_INSTALLER_DAYS   默认 180  —— 安装包「旧」的天数阈值。
 *     KHY_DISKANALYZE_HASH_MAX_FILES       默认 2000 —— 参与重复 hash 的候选文件总数上限。
 *     KHY_DISKANALYZE_HASH_MAX_FILE_MB     默认 512  —— 单个候选文件参与 hash 的大小上限(MB)。
 *
 * @module services/diskAnalyzeCatalog
 */

const MB = 1024 * 1024;

// 安装包 / 可执行分发常见扩展名(小写,含点)。跨平台并集。
const INSTALLER_EXTS = new Set([
  '.exe', '.msi', '.msix', '.appx',          // Windows
  '.dmg', '.pkg',                            // macOS
  '.deb', '.rpm', '.appimage', '.snap', '.flatpak', // Linux
  '.apk',                                    // Android
  '.iso', '.img',                            // 光盘/镜像(常为安装介质)
  '.bin', '.run',                            // 通用自解压安装器
]);

// 文件名(不含扩展名)命中即视为安装器:setup / install / installer / *_setup 等。
const INSTALLER_NAME_RE = /(^|[^a-z])(setup|installer?|update|patch|redist|vc_redist|xinstall)([^a-z]|$)/i;

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 分类/分组决策总开关。默认 on。 */
function isCatalogEnabled(env) {
  return _isEnabled('KHY_DISKANALYZE_CATALOG', env);
}

const _resolveNumeric = require('../utils/resolveNumericFlag');

/** 大文件下限(字节)。 */
function resolveMinSizeBytes(env) {
  return _resolveNumeric('KHY_DISKANALYZE_MIN_SIZE_MB', env, 100, 1, 1048576) * MB;
}

/** 安装包「旧」的天数阈值(天)。 */
function resolveOldInstallerDays(env) {
  return _resolveNumeric('KHY_DISKANALYZE_OLD_INSTALLER_DAYS', env, 180, 1, 36500);
}

/** 参与重复 hash 的候选上限:{ maxFiles, maxFileBytes }。 */
function resolveHashCaps(env) {
  return {
    maxFiles: _resolveNumeric('KHY_DISKANALYZE_HASH_MAX_FILES', env, 2000, 1, 1000000),
    maxFileBytes: _resolveNumeric('KHY_DISKANALYZE_HASH_MAX_FILE_MB', env, 512, 1, 1048576) * MB,
  };
}

/** 取小写扩展名(含点);无扩展名返 ''。 */
function extOf(path) {
  const p = String(path || '');
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';                       // 无点或以点开头(隐藏文件,非扩展名)
  return base.slice(i).toLowerCase();
}

/**
 * 是否安装包 / 可执行分发。门控关 ⇒ 恒 false(逐字节回退)。绝不抛。
 * @param {string} path 文件路径或名
 * @param {object} [env]
 */
function isInstaller(path, env) {
  try {
    if (!isCatalogEnabled(env)) return false;
    const p = String(path || '');
    if (!p) return false;
    if (INSTALLER_EXTS.has(extOf(p))) return true;
    const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    return INSTALLER_NAME_RE.test(base);
  } catch {
    return false;
  }
}

/**
 * 是否「旧安装包」:命中安装包 且 mtime 早于 now - olderThanDays。绝不抛。
 * @param {{path:string, mtimeMs:number}} file
 * @param {number} nowMs 当前时间(注入,保持确定性)
 * @param {object} [env]
 */
function isOldInstaller(file, nowMs, env) {
  try {
    if (!file || !isInstaller(file.path, env)) return false;
    const mtime = Number(file.mtimeMs);
    const now = Number(nowMs);
    if (!Number.isFinite(mtime) || !Number.isFinite(now)) return false;
    const ageDays = (now - mtime) / (24 * 3600 * 1000);
    return ageDays >= resolveOldInstallerDays(env);
  } catch {
    return false;
  }
}

/**
 * 按 size 分组,只保留 size≥2 个成员且 size>0 的组(重复文件的必要非充分候选)。
 * 门控关 ⇒ 返 []。返回按 size 降序的数组:[{ sizeBytes, files:[...] }]。绝不抛。
 * @param {Array<{path:string,size:number}>} files
 * @param {object} [env]
 */
function groupBySize(files, env) {
  try {
    if (!isCatalogEnabled(env)) return [];
    if (!Array.isArray(files)) return [];
    const bySize = new Map();
    for (const f of files) {
      if (!f) continue;
      const size = Number(f.size);
      if (!Number.isFinite(size) || size <= 0) continue;
      let arr = bySize.get(size);
      if (!arr) { arr = []; bySize.set(size, arr); }
      arr.push(f);
    }
    const groups = [];
    for (const [sizeBytes, arr] of bySize.entries()) {
      if (arr.length >= 2) groups.push({ sizeBytes, files: arr });
    }
    groups.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return groups;
  } catch {
    return [];
  }
}

/**
 * 从 size 分组里挑选实际参与 hash 的候选,受 file-count 与 per-file-size 上限约束。
 * 只做**决策**(哪些文件该被 hash),不读文件内容。门控关 ⇒ 空结果。绝不抛。
 *
 * @param {Array<{sizeBytes:number, files:Array}>} sizeGroups groupBySize 的输出
 * @param {object} [env]
 * @returns {{ toHash: Array, skippedTooBig: number, skippedOverCount: number }}
 *   toHash          —— 应被 hash 的文件(保留其所属 sizeBytes,便于 walker 分组比对)
 *   skippedTooBig   —— 因单文件超 per-file 上限而跳过的文件数(诚实上报,非静默丢弃)
 *   skippedOverCount—— 因总候选超 maxFiles 上限而未纳入的文件数
 */
function selectHashCandidates(sizeGroups, env) {
  const out = { toHash: [], skippedTooBig: 0, skippedOverCount: 0 };
  try {
    if (!isCatalogEnabled(env)) return out;
    if (!Array.isArray(sizeGroups)) return out;
    const { maxFiles, maxFileBytes } = resolveHashCaps(env);
    for (const g of sizeGroups) {
      if (!g || !Array.isArray(g.files)) continue;
      // 单文件超上限:整组按大小相同,但内容 hash 成本过高 → 该组内超限文件全跳过并计数。
      const eligible = [];
      for (const f of g.files) {
        if (!f) continue;
        if (Number(f.size) > maxFileBytes) { out.skippedTooBig += 1; continue; }
        eligible.push(f);
      }
      if (eligible.length < 2) continue;         // 剔除超限后不足两个,已无重复可能
      for (const f of eligible) {
        if (out.toHash.length >= maxFiles) { out.skippedOverCount += 1; continue; }
        out.toHash.push({ path: f.path, size: Number(f.size), sizeBytes: g.sizeBytes });
      }
    }
    return out;
  } catch {
    return out;
  }
}

module.exports = {
  isCatalogEnabled,
  isInstaller,
  isOldInstaller,
  groupBySize,
  selectHashCandidates,
  resolveMinSizeBytes,
  resolveOldInstallerDays,
  resolveHashCaps,
  extOf,
  INSTALLER_EXTS,
};
