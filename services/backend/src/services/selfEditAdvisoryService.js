'use strict';

/**
 * selfEditAdvisoryService.js —— 「khy 自维护顾问」的**壳(shell)**,不是纯叶子。
 *
 * 这里做所有 IO:探仓库根(严格 khy monorepo 标记)、把绝对路径折成仓库相对、读源文件
 * 与 bundle 副本逐字节比对求漂移、in-process require 守卫纯核当场评估、维护工具/监视双
 * 路径去重的短 TTL 注册表。确定性文案与路径数学全部委托给纯叶子 selfEditAdvisory.js。
 *
 * 刻意**不**在注释里自述「纯叶子」——本文件合法持有 IO 与模块级可变状态,不受叶子契约
 * 约束(check-leaf-contract 只对自声明纯叶子的文件生效)。
 *
 * 关键诚实边界:
 *   - detectKhyRepoRoot 用严格标记集(pyproject name="khy-os" + 两 bundle 根)二次确认,
 *     绝不对任意用户工程误触发——非 khy monorepo 一律返回 null → 全链静默零反馈。
 *   - 守卫纯核(scripts/lib/)只在 dev checkout 存在,不在 bundled 载荷内。安装态
 *     guardsAvailable=false → 降级为「请手动运行」文案,绝不假装跑过。
 *   - agent-rules 无抽出纯核、spawn per-edit 过重 → 只列入手动清单,不 in-process 自动跑。
 *   - 全程 fail-soft:任何 IO / require 失败都吞掉,最坏情况 = 无反馈(等同门控关)。
 */

const fs = require('fs');
const path = require('path');

const leaf = require('./selfEditAdvisory');

// ── 仓库根探测(严格 khy monorepo 标记 + 缓存)────────────────────────────
const BACKEND_ROOT = path.resolve(__dirname, '..', '..'); // services/backend
// startDir(归一) → root|null,避免每次编辑都上溯文件系统。
const _rootCache = new Map();

/** pyproject.toml 是否声明 name="khy-os"。fail-soft:读失败/不含 → false。 */
function _pyprojectIsKhy(root) {
  try {
    const p = path.join(root, 'pyproject.toml');
    if (!fs.existsSync(p)) return false;
    const txt = fs.readFileSync(p, 'utf8');
    return /name\s*=\s*["']khy-os["']/.test(txt);
  } catch {
    return false;
  }
}

/** 严格标记集:pyproject name="khy-os" + 两 bundle 根同时存在。 */
function _isKhyMonorepoRoot(root) {
  try {
    if (!_pyprojectIsKhy(root)) return false;
    for (const rel of leaf.MIRROR_ROOTS) {
      if (!fs.existsSync(path.join(root, rel))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 startDir 上溯找 khy monorepo 根(严格标记确认)。非 khy → null。带缓存。永不抛。
 * @param {string} [startDir]
 * @returns {string|null}
 */
function detectKhyRepoRoot(startDir) {
  let dir;
  try {
    dir = path.resolve(startDir || process.cwd());
  } catch {
    dir = BACKEND_ROOT;
  }
  if (_rootCache.has(dir)) return _rootCache.get(dir);
  let found = null;
  try {
    let cur = dir;
    for (let i = 0; i < 12; i++) {
      if (_isKhyMonorepoRoot(cur)) { found = cur; break; }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // 刻意不做 BACKEND_ROOT 兜底:自维护顾问只在「会话 cwd 位于某 khy monorepo 内」时
    // 触发。cwd 在仓外 → 上溯找不到 → null → 静默(比投机回落到 khy 源码位置更诚实、
    // 更可预测,也杜绝「用户在别处开会话却触发对 khy 源码的比对」)。
  } catch {
    found = null;
  }
  _rootCache.set(dir, found);
  return found;
}

/** 绝对路径 → 仓库相对(正斜杠)。越出根 / 失败 → null。 */
function toRepoRel(absPath, root) {
  try {
    if (!absPath || !root) return null;
    const rel = path.relative(root, path.resolve(absPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

// ── 镜像漂移比对 ────────────────────────────────────────────────────────
/** 读文件为 Buffer;失败 → null。 */
function _readBuf(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * 比对源文件与其两 bundle 副本,返回 {missing, drift}(仓库相对路径)。fail-soft。
 * @param {string} repoRel  源文件仓库相对路径
 * @param {string} root     仓库根绝对路径
 * @returns {{missing:string[], drift:string[]}}
 */
function checkMirrorDrift(repoRel, root) {
  const missing = [];
  const drift = [];
  try {
    const targets = leaf.computeMirrorPaths(repoRel);
    if (targets.length === 0) return { missing, drift };
    const srcBuf = _readBuf(path.join(root, repoRel));
    for (const rel of targets) {
      const buf = _readBuf(path.join(root, rel));
      if (buf == null) { missing.push(rel); continue; }
      // 源读不到 → 无法判定漂移,不误报(留给守卫/提交期)。
      if (srcBuf != null && !srcBuf.equals(buf)) drift.push(rel);
    }
  } catch {
    /* fail-soft:比对失败当无漂移 */
  }
  return { missing, drift };
}

// ── 守卫当场运行(in-process 纯核;仅 dev checkout)─────────────────────────
/** scripts/lib/ 守卫核是否可 require(dev checkout 才有)。带缓存。 */
let _guardsAvailable = null;
function _scriptsLibDir(root) {
  return path.join(root, 'scripts', 'lib');
}
function guardsAvailable(root) {
  if (_guardsAvailable != null) return _guardsAvailable;
  try {
    _guardsAvailable = fs.existsSync(path.join(_scriptsLibDir(root), 'leafContractGuard.js'));
  } catch {
    _guardsAvailable = false;
  }
  return _guardsAvailable;
}

/** 把 assessFile 的 {findings} 折成 {name,ok,errorCount,warnCount,sample}。 */
function _foldFindings(name, findings) {
  const list = Array.isArray(findings) ? findings : [];
  let errorCount = 0;
  let warnCount = 0;
  let sample = '';
  for (const f of list) {
    if (f && f.severity === 'error') { errorCount += 1; if (!sample) sample = _findingSample(f); }
    else { warnCount += 1; if (!sample) sample = _findingSample(f); }
  }
  return { name, ok: errorCount === 0, errorCount, warnCount, sample };
}
function _findingSample(f) {
  try {
    const where = f.line ? `@${f.line}` : '';
    const msg = String(f.message || f.rule || '').slice(0, 120);
    return `${f.rule || ''}${where}: ${msg}`.trim();
  } catch {
    return '';
  }
}

/**
 * 当场运行可 in-process 的守卫核。仅 dev checkout(guardsAvailable)。永不抛。
 * @returns {Array<{name,ok,errorCount,warnCount,sample}>}
 */
function runGuards(repoRel, root, source) {
  const results = [];
  if (!guardsAvailable(root)) return results;
  const libDir = _scriptsLibDir(root);
  // leaf-contract:对所有源文件跑(自身对非叶子文件 pass)。
  try {
    const leafGuard = require(path.join(libDir, 'leafContractGuard.js'));
    const r = leafGuard.assessFile({ relPath: repoRel, source, env: process.env });
    results.push(_foldFindings('leaf-contract', r && r.findings));
  } catch {
    /* 守卫核异常 → 跳过该项,不阻断 */
  }
  // model-hardcoding:仅 .js/.cjs/.mjs。
  try {
    if (/\.[cm]?js$/.test(repoRel)) {
      const mhGuard = require(path.join(libDir, 'modelHardcodingGuard.js'));
      let watchedNames = [];
      try {
        const models = require(path.join(root, 'services/backend/src/constants/models.js'));
        watchedNames = mhGuard.deriveWatchedNames(models);
      } catch { /* 无 models → 空名单,守卫自身 fail-soft */ }
      const r = mhGuard.assessFile({ relPath: repoRel, source, watchedNames, env: process.env });
      results.push(_foldFindings('model-hardcoding', r && r.findings));
    }
  } catch {
    /* 跳过 */
  }
  return results;
}

// ── 工具/监视去重短 TTL 注册表(§4)──────────────────────────────────────
const RECENT_TOOL_EDIT_TTL_MS = 8000;
const _recentToolEdits = new Map(); // absPath(resolved) → expiresAt

function _now() {
  return Date.now();
}
function _resolveAbs(absPath) {
  try {
    return path.resolve(absPath);
  } catch {
    return String(absPath || '');
  }
}

/** khy 工具刚写过某文件 → 登记,监视器据此跳过(避免双重提示)。 */
function recordToolEdit(absPath) {
  try {
    const key = _resolveAbs(absPath);
    if (!key) return;
    _recentToolEdits.set(key, _now() + RECENT_TOOL_EDIT_TTL_MS);
  } catch {
    /* fail-soft */
  }
}

/** 该文件是否为 khy 工具近期写过(TTL 内)。命中即消费(一次性)。 */
function wasRecentlyToolEdited(absPath) {
  try {
    const key = _resolveAbs(absPath);
    const exp = _recentToolEdits.get(key);
    if (exp == null) return false;
    _recentToolEdits.delete(key);
    return exp > _now();
  } catch {
    return false;
  }
}

// ── 编排:为单个绝对路径产出反馈 ────────────────────────────────────────
/**
 * 探根 → 判镜像源 → 漂移 + 守卫 → buildSelfEditAdvisory。非 khy / 非镜像源 / 门控关
 * / 异常 → null。壳不打印,把 {humanLine,aiNote} 交调用点按面投递。永不抛。
 * @param {string} absPath
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @returns {{humanLine:string, aiNote:string}|null}
 */
function emitForPath(absPath, opts = {}) {
  try {
    if (!leaf.selfEditAdvisoryEnabled(process.env)) return null;
    const root = detectKhyRepoRoot(opts.cwd || process.cwd());
    if (!root) return null; // 非 khy monorepo → 绝不误触发
    const repoRel = toRepoRel(absPath, root);
    if (!repoRel) return null;
    if (!leaf.isMirroredSourcePath(repoRel).mirrored) return null;

    const source = (() => {
      const b = _readBuf(path.join(root, repoRel));
      return b == null ? '' : b.toString('utf8');
    })();

    const mirrorState = checkMirrorDrift(repoRel, root);
    const isLeaf = leaf.detectPureLeaf(source);
    const avail = guardsAvailable(root);
    const guardResults = avail ? runGuards(repoRel, root, source) : [];

    return leaf.buildSelfEditAdvisory({
      repoRel,
      isLeaf,
      mirrorState,
      guardResults,
      guardsAvailable: avail,
    }, process.env);
  } catch {
    return null;
  }
}

// 测试专用:清缓存(不导出到常规使用面亦无害)。
function _resetCachesForTest() {
  _rootCache.clear();
  _recentToolEdits.clear();
  _guardsAvailable = null;
}

module.exports = {
  detectKhyRepoRoot,
  toRepoRel,
  checkMirrorDrift,
  guardsAvailable,
  runGuards,
  recordToolEdit,
  wasRecentlyToolEdited,
  emitForPath,
  _resetCachesForTest,
};
