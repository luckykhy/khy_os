'use strict';

/**
 * fileSalience.js — 纯叶子:把「一堆文件条目(名 + 大小)」重排为「关键文件顶上来 + 分组摘要」的
 * 抓重点视图。分析压缩包 / 文件夹 / 盘符时「文件太多抓不住重点」的单一真源修复层。
 *
 * 背景(goal 2026-07-03「khy 在分析压缩包，文件夹，C、D 盘符时，有时文件太多无法抓住重点」):
 * 三类列举路径(压缩包清单 archiveManifestPolicy、Glob、Bash ls/find)共享同一失败接缝——
 * 「按压缩包中央目录序 / mtime 盲截 N 条 → 中间无 salience 层」。模型拿到一堆按原始顺序排列的
 * 文件名,入口 / README / manifest / config 被淹没。本叶子在**截断之前**插入一层:
 *   ① scoreFile      —— query-free 内在重要性加权(无需任务查询,冷启动列目录也能抓重点);
 *   ② summarizeListing—— pinned(经 budgetController.applyBudget「充分即停」)+ 按目录/扩展名分组
 *                        计数 + 最大文件 top-K + 精确 hidden 计数;
 *   ③ renderSalienceBlock —— 确定性中文文本块(压缩包清单 / Glob summary / ListDir summary 共用)。
 *
 * 契约:零 I/O(只读 process.env 做门控,不碰 fs / 网络 / 子进程)、确定性(无时钟 / 随机)、
 * 绝不抛(fail-soft 返回安全值)。门控 KHY_FILE_SALIENCE(经 flagRegistry 声明式注册,默认开)。
 * 门控关 → summarizeListing 返回**逐字节复现旧行为**的退化形(pinned 空、原序 slice),
 * renderSalienceBlock 返回 ''(调用方据此逐字节回退到各自旧的原序清单逻辑)。
 *
 * 复用(单一真源,不重刻方言):
 *   - budgetController.applyBudget —— pinned 的「截断海量但不丢信号」核心(充分即停 / 边际收益递减)。
 *   - SKIP_DIRS —— 与 GlobTool / projectMetadataService 同口径的噪声目录集(降权用)。
 *   - _formatBytes —— 委派 archiveManifestPolicy 的 ccFormat SSOT(展示口径统一)。
 *
 * @module services/fileSalience
 */

const flagRegistry = require('./flagRegistry');
const { applyBudget } = require('./contextScope/budgetController');
// 注意:**不**在此 require archiveManifestPolicy —— 后者会 require 本模块,成环。
// 字节格式化直接走 ccFormat SSOT(与 archiveManifestPolicy._formatBytes 同口径,叶子→叶子相对 require 合规)。

// ── 门控(dogfood flagRegistry:声明式表已注册 KHY_FILE_SALIENCE)────────────────
function isEnabled(env = process.env) {
  try {
    // flagRegistry 关(自门控)→ 逐字节回退:此处保守放行(默认开语义),等价于注册表未介入。
    if (!flagRegistry.isRegistryEnabled(env)) {
      const raw = env && env.KHY_FILE_SALIENCE;
      if (raw === undefined || raw === null) return true;
      return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
    }
    return flagRegistry.isFlagEnabled('KHY_FILE_SALIENCE', env);
  } catch {
    return true;
  }
}

// ── 噪声目录集(与 GlobTool.SKIP_DIRS / projectMetadataService 同口径)──────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache',
  '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'coverage',
  '.next', '.nuxt', '.output', 'vendor', 'target', 'out',
]);

// ── 内在重要性权重(加法式,模仿 scopeRanker 的可解释 reasons[])──────────────────
// query-free:不依赖任务查询,只看路径 / 文件名的内在角色。高分 → pinned 顶部。
const WEIGHTS = Object.freeze({
  entryPoint: 10,   // index/main/server/app/cli + 各语言 main
  manifest: 9,      // package.json / Cargo.toml / pyproject.toml / go.mod / Dockerfile ...
  readme: 8,        // README / LICENSE / CHANGELOG
  config: 5,        // .env / *.config.* / *.toml / *.ya?ml / *.ini
  shallowBonus: 3,  // 顶层文件加分(按深度线性递减)
  // 降权(负权)
  skipDir: -8,      // 路径含 node_modules/dist/... 噪声目录
  lockfile: -4,     // *-lock.json / *.lock / yarn.lock
  minified: -4,     // *.min.js / *.min.css
  sourcemap: -3,    // *.map
});

// 入口文件名单(复用 projectMetadataService._inferEntryPoints 的 candidate 口径为单一真源)。
const _ENTRY_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx', 'index.html',
  'main.js', 'main.ts', 'main.py', 'main.go', 'main.rs',
  'server.js', 'server.ts', 'app.js', 'app.ts', 'app.py', 'app.vue',
  'cli.js', 'cli.ts', '__main__.py', 'lib.rs',
]);
const _MANIFEST_BASENAMES = new Set([
  'package.json', 'cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml',
  'dockerfile', 'makefile', 'cmakelists.txt', 'composer.json', 'gemfile',
  'build.gradle', 'build.gradle.kts', 'requirements.txt', 'setup.py',
]);

function _normalise(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}
function _basename(p) {
  const s = _normalise(p);
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}
function _topSegment(p) {
  const s = _normalise(p);
  const slash = s.indexOf('/');
  return slash >= 0 ? s.slice(0, slash) : '';   // '' = 根文件
}
function _ext(p) {
  const base = _basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}
function _depth(p) {
  const s = _normalise(p);
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === '/') n += 1;
  return n;
}

/**
 * query-free 内在重要性打分。返回 {path, score, reasons[], size}。绝不抛。
 * @param {{name?:string, path?:string, size?:number}} entry
 * @returns {{path:string, score:number, reasons:string[], size:number}}
 */
function scoreFile(entry) {
  const path = _normalise((entry && (entry.path || entry.name)) || '');
  const size = Number(entry && entry.size) || 0;
  const reasons = [];
  let score = 0;
  try {
    if (!path) return { path: '', score: 0, reasons: [], size };
    const base = _basename(path).toLowerCase();
    const lower = path.toLowerCase();

    // 加分:内在角色
    if (_ENTRY_BASENAMES.has(base)) { score += WEIGHTS.entryPoint; reasons.push('entry-point'); }
    if (_MANIFEST_BASENAMES.has(base)) { score += WEIGHTS.manifest; reasons.push('manifest'); }
    if (/^(readme|license|licence|changelog)(\.|$)/.test(base)) { score += WEIGHTS.readme; reasons.push('readme/license'); }
    if (
      /^\.env(\.|$)/.test(base)
      || /\.config\./.test(base)
      || /\.(toml|ya?ml|ini|cfg|conf|properties)$/.test(base)
    ) { score += WEIGHTS.config; reasons.push('config'); }

    // 浅层加分(顶层 depth=0 得满,越深越少,不低于 0)
    const shallow = Math.max(0, WEIGHTS.shallowBonus - _depth(path));
    if (shallow > 0) { score += shallow; reasons.push('shallow'); }

    // 降权:噪声
    const segs = lower.split('/');
    if (segs.some((s) => SKIP_DIRS.has(s))) { score += WEIGHTS.skipDir; reasons.push('skip-dir'); }
    if (/(^|\/)([^/]*-lock\.json|[^/]*\.lock|yarn\.lock|package-lock\.json)$/.test(lower)) { score += WEIGHTS.lockfile; reasons.push('lockfile'); }
    if (/\.min\.(js|css)$/.test(lower)) { score += WEIGHTS.minified; reasons.push('minified'); }
    if (/\.map$/.test(lower)) { score += WEIGHTS.sourcemap; reasons.push('sourcemap'); }

    return { path, score, reasons, size };
  } catch {
    return { path, score, reasons, size };
  }
}

// ── 目录体积 rollup(接缝3:深树 C/D 盘符单层 byDir 失效的补强)──────────────────
// byDir 只按顶层单段分组,对 Users/AppData/.../ 深树近乎无分辨率;largest 只看单文件,
// 看不见「大量小文件塞满某深层目录」的真实占用热点。dirHotspots 按**文件所在目录**(受
// maxDirDepth 段上限 rollup)聚合 count + totalSize,再按体积剪枝 top-K —— du 式目录热点。
// 门控 KHY_DIR_HOTSPOTS(默认开);关 → summarizeListing 返 dirHotspots:[](不渲染新段,字节回退)。
function _dirHotspotsEnabled(env) {
  try {
    if (!flagRegistry.isRegistryEnabled(env)) {
      const raw = env && env.KHY_DIR_HOTSPOTS;
      if (raw === undefined || raw === null) return true;
      return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
    }
    return flagRegistry.isFlagEnabled('KHY_DIR_HOTSPOTS', env);
  } catch {
    return true;
  }
}

function _parentDir(p, maxDirDepth) {
  const s = _normalise(p);
  const slash = s.lastIndexOf('/');
  if (slash < 0) return '(根)';          // 根文件 → 归入「(根)」桶
  const dir = s.slice(0, slash);
  // 受深度上限 rollup:超过 maxDirDepth 段的深路径,只取前 maxDirDepth 段(把深树卷上来)。
  const segs = dir.split('/');
  return segs.length > maxDirDepth ? segs.slice(0, maxDirDepth).join('/') : dir;
}

function _dirRollup(list, maxDirDepth, topK) {
  const agg = new Map();
  for (const e of list) {
    let dir;
    try { dir = _parentDir((e.path || e.name), maxDirDepth); } catch { dir = '(根)'; }
    const size = Number(e && e.size) || 0;
    const cur = agg.get(dir) || { dir, count: 0, totalSize: 0 };
    cur.count += 1;
    cur.totalSize += size;
    agg.set(dir, cur);
  }
  const arr = Array.from(agg.values());
  // 按体积降序 → 文件数降序 → 名升序(确定性)。
  arr.sort((a, b) => (b.totalSize - a.totalSize) || (b.count - a.count) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return arr.slice(0, Math.max(1, topK || 8));
}

// ── 分组计数(确定性:count desc → name asc)──────────────────────────────────────
function _groupCount(entries, keyFn, topK) {
  const counts = new Map();
  for (const e of entries) {
    let key;
    try { key = keyFn(e); } catch { key = ''; }
    if (key === undefined || key === null) key = '';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const arr = Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
  arr.sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return arr.slice(0, Math.max(1, topK || 12));
}

/**
 * 组织一份大文件列举的抓重点摘要。门控关 → 退化形(pinned 空、原序 slice),供调用方逐字节回退。
 * @param {Array<{name?:string,path?:string,size?:number,isDirectory?:boolean}>} entries
 * @param {object} [opts]  { env, total?, maxPinned?, maxGroups?, maxLargest?, fallbackShown? }
 * @returns {{enabled:boolean, pinned:Array, byDir:Array, byExt:Array, largest:Array,
 *           total:number, shown:number, hidden:number, stopReason:string, fallbackList:Array}}
 */
function summarizeListing(entries, opts = {}) {
  const env = opts.env || process.env;
  const list = Array.isArray(entries) ? entries.filter((e) => e && !e.isDirectory) : [];
  const total = Number.isFinite(opts.total) ? opts.total : list.length;

  // 退化形(门控关):不重排,原序取前 fallbackShown 条 —— 逐字节复现旧「原序 slice」行为。
  if (!isEnabled(env)) {
    const shownN = Number.isFinite(opts.fallbackShown) ? Math.max(0, opts.fallbackShown) : list.length;
    const fallbackList = list.slice(0, shownN);
    return {
      enabled: false,
      pinned: [], byDir: [], byExt: [], largest: [], dirHotspots: [],
      total, shown: fallbackList.length, hidden: Math.max(0, total - fallbackList.length),
      stopReason: 'disabled', fallbackList,
    };
  }

  try {
    const maxPinned = Number.isFinite(opts.maxPinned) ? Math.max(1, opts.maxPinned) : 12;
    const maxGroups = Number.isFinite(opts.maxGroups) ? Math.max(1, opts.maxGroups) : 12;
    const maxLargest = Number.isFinite(opts.maxLargest) ? Math.max(1, opts.maxLargest) : 8;
    const maxDirDepth = Number.isFinite(opts.maxDirDepth) ? Math.max(1, opts.maxDirDepth) : 3;

    // pinned:内在重要性打分 → applyBudget 充分即停(绝不选全部)。
    const ranked = list.map(scoreFile).filter((c) => c.path)
      .sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length) || (a.path < b.path ? -1 : 1));
    const budget = applyBudget(ranked, { maxFiles: maxPinned, minFiles: 1 });
    // 只保留正分文件当「关键文件」(负/零分是噪声或普通文件,不该置顶谎报重要)。
    const pinned = budget.selected.filter((c) => c.score > 0);

    const byDir = _groupCount(list, (e) => _topSegment((e.path || e.name)) || '(根)', maxGroups);
    const byExt = _groupCount(list, (e) => _ext((e.path || e.name)) || '(无扩展名)', maxGroups);

    const largest = list
      .map((e) => ({ path: _normalise(e.path || e.name), size: Number(e.size) || 0 }))
      .filter((e) => e.path && e.size > 0)
      .sort((a, b) => (b.size - a.size) || (a.path < b.path ? -1 : 1))
      .slice(0, maxLargest);

    // 目录体积热点(接缝3):深树 rollup + 按体积剪枝。门控关 → [](不渲染,字节回退)。
    const dirHotspots = _dirHotspotsEnabled(env)
      ? _dirRollup(list, maxDirDepth, maxLargest)
      : [];

    return {
      enabled: true,
      pinned, byDir, byExt, largest, dirHotspots,
      total, shown: list.length, hidden: Math.max(0, total - list.length),
      stopReason: budget.stopReason,
      fallbackList: [],
    };
  } catch {
    // fail-soft:退化到原序,绝不破坏调用方。
    const fallbackList = list.slice(0, Number.isFinite(opts.fallbackShown) ? Math.max(0, opts.fallbackShown) : list.length);
    return {
      enabled: false,
      pinned: [], byDir: [], byExt: [], largest: [], dirHotspots: [],
      total, shown: fallbackList.length, hidden: Math.max(0, total - fallbackList.length),
      stopReason: 'error', fallbackList,
    };
  }
}

function _fmtBytes(n, env) {
  // 字节→人类可读单一真源:门控 KHY_CC_FORMAT 开 → 走 CC formatFileSize(与 archiveManifestPolicy
  // 及所有展示面统一);关 / 不可用 → 逐字节回退本地旧口径。ccFormat 亦为纯叶子,相对 require 合规。
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(Number(n || 0) || 0);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  const bytes = Number(n || 0) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * 渲染确定性中文摘要文本块(压缩包清单 / Glob summary / ListDir summary 共用)。
 * 门控关(summary.enabled === false)→ 返回 ''(调用方逐字节回退旧原序清单)。
 * @param {object} summary  summarizeListing 的返回
 * @param {object} [opts]   { env, title? }
 * @returns {string}
 */
function renderSalienceBlock(summary, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!summary || summary.enabled === false) return '';
    const lines = [];

    if (Array.isArray(summary.pinned) && summary.pinned.length) {
      lines.push('📌 关键文件(按内在重要性):');
      for (const c of summary.pinned) {
        const sz = c.size > 0 ? ` (${_fmtBytes(c.size, env)})` : '';
        lines.push(`- ${c.path}${sz}`);
      }
    }

    if (Array.isArray(summary.byDir) && summary.byDir.length > 1) {
      const parts = summary.byDir.map((g) => `${g.key} ${g.count}`);
      lines.push('');
      lines.push(`📂 目录分布:${parts.join('、')}`);
    }
    if (Array.isArray(summary.byExt) && summary.byExt.length > 1) {
      const parts = summary.byExt.map((g) => `${g.key} ${g.count}`);
      lines.push(`🗂 类型分布:${parts.join('、')}`);
    }

    if (Array.isArray(summary.largest) && summary.largest.length) {
      lines.push('');
      lines.push('⬆ 最大文件:');
      for (const e of summary.largest) {
        lines.push(`- ${e.path} (${_fmtBytes(e.size, env)})`);
      }
    }

    // 📁 目录体积热点(接缝3):仅当有多于1个目录且至少一个目录有体积时渲染(深树抓重点)。
    // 单目录 / 全 0 体积(如纯 find 无 size)→ 不渲染(byDir 已足够,避免噪声段)。
    if (Array.isArray(summary.dirHotspots) && summary.dirHotspots.length > 1
        && summary.dirHotspots.some((d) => d.totalSize > 0)) {
      lines.push('');
      lines.push('📁 目录体积热点(按占用):');
      for (const d of summary.dirHotspots) {
        const sz = d.totalSize > 0 ? _fmtBytes(d.totalSize, env) : '—';
        lines.push(`- ${d.dir}/ — ${d.count} 个文件, ${sz}`);
      }
    }

    if (summary.hidden > 0) {
      lines.push('');
      lines.push(`共 ${summary.total} 个文件;上面按重要性 / 大小 / 分类突出了重点,其余 ${summary.hidden} 个未逐一列出。`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  SKIP_DIRS,
  WEIGHTS,
  scoreFile,
  summarizeListing,
  renderSalienceBlock,
};
