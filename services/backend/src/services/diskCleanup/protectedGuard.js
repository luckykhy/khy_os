'use strict';

/**
 * diskCleanup/protectedGuard.js — 受保护路径否决层（防御纵深第二道，fail-closed）。
 *
 * junkCatalog 是「只从白名单里选」的第一道闸；本模块是第二道：即便某路径来自白名单，
 * 删除前仍必须过这一关。任何「可能是用户数据」的迹象都让删除失败——**宁可漏删，绝不误删**。
 *
 * 失败封闭（fail-closed）：解析/判断过程一旦出错，一律当作「受保护」拒绝删除。
 * 这是和普通校验相反的默认值，因为这里删错的代价是不可逆的数据丢失。
 *
 * 三类否决：
 *   1. 路径形态可疑：盘根/根目录/路径段数过少（太靠近盘根）/包含 .. 等。
 *   2. 落在受保护根内：用户文档/桌面/下载/图片/云盘/本项目数据家（见 junkCatalog）。
 *   3. 目录内含用户数据信号：.git/源码工程标记/office 文档/媒体原片。
 */

const path = require('path');
const catalog = require('./junkCatalog');

/** 归一化为绝对、解析符号后的比较基准（不访问磁盘，纯字符串）。 */
function _norm(p) {
  if (!p || typeof p !== 'string') return '';
  // 统一分隔符 + 去尾斜杠（保留盘根/根的尾斜杠语义由调用方处理）。
  let s = path.resolve(p);
  return s;
}

/** a 是否等于 b，或在 b 之内（路径包含，跨平台大小写：Windows 不敏感）。 */
function _isWithin(child, parent, caseInsensitive) {
  if (!child || !parent) return false;
  let c = _norm(child);
  let pr = _norm(parent);
  if (caseInsensitive) { c = c.toLowerCase(); pr = pr.toLowerCase(); }
  if (c === pr) return true;
  const sep = path.sep;
  const prWithSep = pr.endsWith(sep) ? pr : pr + sep;
  return c.startsWith(prWithSep);
}

/** 是否盘根/根目录（如 C:\、D:\、/、/home 这种极浅路径）。 */
function _isDriveOrRoot(p, deps) {
  const n = _norm(p);
  const parsed = path.parse(n);
  // 盘根：root === dir（如 C:\ 解析后 root='C:\\', dir='C:\\'）。
  if (parsed.root === n || parsed.dir === parsed.root && parsed.base === '') return true;
  if (n === '/' || n === parsed.root) return true;
  // 路径段数过少 → 太靠近盘根，拒。
  const rel = n.slice(parsed.root.length);
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.length < catalog.thresholds.minPathSegments) return true;
  return false;
}

function _resolveAll(resolvers, deps) {
  const out = [];
  for (const resolver of resolvers || []) {
    let roots = [];
    try { roots = resolver(deps) || []; } catch { roots = []; }
    for (const r of roots) {
      if (r && typeof r === 'string') out.push(_norm(r));
    }
  }
  return [...new Set(out)];
}

/**
 * 包含式受保护根（路径等于或落在其内即否决）。纯用户数据目录。
 * @param {object} deps
 * @returns {string[]}
 */
function protectedRoots(deps) {
  return _resolveAll(catalog.PROTECTED_CONTAINMENT_RESOLVERS, deps);
}

/**
 * 精确受保护根（仅「恰好等于」时否决，其下白名单缓存子目录仍可清）。
 * 主目录、本项目数据家本身属此档——根不可删，但根下具体缓存子目录可清。
 * @param {object} deps
 * @returns {string[]}
 */
function protectedExactPaths(deps) {
  return _resolveAll(catalog.PROTECTED_EXACT_RESOLVERS, deps);
}

/**
 * 主判定：path 是否受保护（= 不可删）。
 * @param {string} targetPath
 * @param {object} deps - {platform,env,homedir,fsImpl}
 * @returns {{ protected: boolean, reason: string }}
 */
function inspect(targetPath, deps) {
  try {
    if (!targetPath || typeof targetPath !== 'string') {
      return { protected: true, reason: '空或非法路径' };
    }
    const n = _norm(targetPath);

    // 含可疑回溯
    if (/(^|[\\/])\.\.([\\/]|$)/.test(targetPath)) {
      return { protected: true, reason: '路径包含 .. 回溯' };
    }
    // 盘根/根/过浅
    if (_isDriveOrRoot(n, deps)) {
      return { protected: true, reason: '盘根/根目录/路径过浅，拒删' };
    }
    const caseInsensitive = deps.platform === 'windows';
    const eq = (a, b) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
    // 精确受保护根：恰好等于才否决（主目录/数据家本身不可删，其下缓存子目录放行）
    for (const exact of protectedExactPaths(deps)) {
      if (eq(n, _norm(exact))) {
        return { protected: true, reason: `受保护根本身(不可删，仅其下缓存可清): ${exact}` };
      }
    }
    // 包含式受保护根：等于或落在其内一律否决（纯用户数据，整株不碰）
    for (const root of protectedRoots(deps)) {
      if (_isWithin(n, root, caseInsensitive)) {
        return { protected: true, reason: `位于受保护根内: ${root}` };
      }
    }
    return { protected: false, reason: '' };
  } catch (err) {
    // fail-closed：判断出错一律当受保护。
    return { protected: true, reason: `判定异常(fail-closed): ${err && err.message}` };
  }
}

function isProtected(targetPath, deps) {
  return inspect(targetPath, deps).protected;
}

/**
 * 扫描候选目录顶层，检测是否混入用户数据信号（.git/源码标记/office 文档/媒体原片）。
 * 只看顶层一层（深扫太慢且无谓），命中即返回信号，调用方据此降级或否决。
 * @param {string} dir
 * @param {object} deps
 * @returns {{ hasSignal: boolean, signals: string[] }}
 */
function userDataSignals(dir, deps) {
  const signals = [];
  let entries = [];
  try {
    entries = deps.fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { hasSignal: false, signals: [] };
  }
  const { markers, docExtensions, mediaExtensions } = catalog.USER_DATA_SIGNALS;
  const markerSet = new Set(markers.map((m) => m.toLowerCase()));
  for (const ent of entries) {
    const name = ent.name;
    const lower = name.toLowerCase();
    if (markerSet.has(lower)) {
      signals.push(`工程/版本库标记: ${name}`);
      continue;
    }
    const ext = path.extname(lower);
    if (ext && (docExtensions.includes(ext) || mediaExtensions.includes(ext))) {
      signals.push(`用户文档/媒体: ${name}`);
    }
    if (signals.length >= 5) break; // 取证够了即止
  }
  return { hasSignal: signals.length > 0, signals };
}

/**
 * 断言：targetPath 当下可安全删除。受保护 → 抛错（执行器据此 fail-soft 跳过）。
 * 在「执行删除的最后一刻」再调一次，构成 TOCTOU 防御。
 * @param {string} targetPath
 * @param {object} deps
 * @param {object} [opts] - {checkUserData:boolean} 是否同时查用户数据信号
 */
function assertSafeToDelete(targetPath, deps, opts = {}) {
  const verdict = inspect(targetPath, deps);
  if (verdict.protected) {
    const e = new Error(`受保护路径，拒绝删除: ${verdict.reason}`);
    e.code = 'KHY_PROTECTED_PATH';
    e.path = targetPath;
    throw e;
  }
  if (opts.checkUserData) {
    const sig = userDataSignals(targetPath, deps);
    if (sig.hasSignal) {
      const e = new Error(`检测到用户数据信号，拒绝删除: ${sig.signals.join('; ')}`);
      e.code = 'KHY_USER_DATA_SIGNAL';
      e.path = targetPath;
      throw e;
    }
  }
  return true;
}

module.exports = {
  inspect,
  isProtected,
  protectedRoots,
  protectedExactPaths,
  userDataSignals,
  assertSafeToDelete,
  // 测试可见的内部
  _isWithin,
  _isDriveOrRoot,
};
