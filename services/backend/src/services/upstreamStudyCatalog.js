'use strict';

/**
 * upstreamStudyCatalog.js — 纯叶子:UpstreamStudy 工具的「取其精华弃其糟粕」**决策层**。
 *
 * 为什么单独抽出:把一个开源项目更新包学进来时,判定每个文件条目属**精华**(值得读/借鉴)
 * 还是**糟粕**(该忽略)——某扩展名算不算源码、某目录段是不是 vendored、什么算构建产物、
 * 哪条更值得优先读——是纯逻辑,可与真正列压缩包目录的 archiveInspectService(薄 I/O 层)、
 * 编排的 upstreamStudy facade(服务)彻底分离。规则集中在此,便于确定性测试、门控回退。
 *
 * 契约:零 I/O(不碰 fs / 网络 / 子进程 / crypto,只对已列到的 {path,size} 元数据做判定)、
 * 确定性(无时钟/随机)、绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_UPSTREAM_STUDY_CATALOG  默认 on —— 精华/糟粕分类总开关。
 *     关 ⇒ classifyEntry 恒返 {verdict:'neutral'}(逐字节回退:不产精华/糟粕划分,facade 退化为纯清点)。
 *   数值阈值(numeric,经 flagRegistry.resolveNumeric,不可用则本地 clamp):
 *     KHY_UPSTREAM_STUDY_TOP           默认 25   —— 精华阅读清单 Top-N。
 *     KHY_UPSTREAM_STUDY_MAX_FILE_KB   默认 256  —— 单精华文件「可读」大小上限(KB);超此标 tooLarge。
 *     KHY_UPSTREAM_STUDY_BLOB_MB       默认 5    —— 单文件超此直接归 oversized 糟粕桶。
 *
 * @module services/upstreamStudyCatalog
 */

const KB = 1024;
const MB = 1024 * 1024;

// ── 精华:源码扩展名(小写,含点)。跨语言并集。────────────────────────────────────────
const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rs', '.go', '.rb', '.php', '.lua', '.pl',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.clj',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.cxx', '.m', '.mm',
  '.cs', '.fs', '.swift', '.dart', '.zig', '.nim', '.ml', '.ex', '.exs',
  '.sh', '.bash', '.zsh', '.ps1', '.psm1',
  '.sql', '.graphql', '.proto',
]);

// 理据文档(README / 设计 / 迁移说明)的扩展名。散文可揭示「为什么这么改」。
const DOC_EXTS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt', '.org']);

// 揭示项目约定的配置文件名(basename,小写)。低优先级精华。
const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'cargo.toml', 'pyproject.toml',
  'go.mod', 'gemfile', 'build.gradle', 'pom.xml', 'composer.json', 'setup.py',
  'setup.cfg', 'requirements.txt', '.eslintrc', '.eslintrc.js', '.eslintrc.json',
  '.prettierrc', 'dockerfile', 'makefile', 'cmakelists.txt',
]);

// CHANGELOG 家族:一眼看清「更新了什么」——最高学习价值。basename(去扩展名)命中。
const CHANGELOG_RE = /^(changelog|change[-_]?log|changes|news|history|releases?|migration|upgrading|whatsnew|what[-_]?s[-_]?new)$/i;

// ── 糟粕:vendored / 生成物目录段(路径任一段命中即整条判糟粕)。────────────────────────
const DROSS_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', 'third-party',
  '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target', 'bin', 'obj', 'release',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.venv', 'venv', 'env',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  'coverage', '.nyc_output', 'htmlcov',
  '.idea', '.gradle', '.dart_tool', 'pkg',
]);

// 糟粕:锁文件(体量大、逐行无学习价值)。basename 小写。
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'composer.lock', 'cargo.lock', 'poetry.lock', 'gemfile.lock', 'go.sum',
  'pipfile.lock', 'flake.lock',
]);

// 糟粕:二进制 / 媒体 / 归档 / 数据 blob 扩展名。逐字节读无益。
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tif', '.tiff', '.icns',
  '.mp3', '.wav', '.flac', '.ogg', '.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4a',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.whl', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib', '.wasm', '.node', '.class', '.pyc',
  '.pdf', '.db', '.sqlite', '.sqlite3', '.dat', '.bin', '.pack', '.idx',
]);

// 糟粕:密钥 / 机密文件(基名或扩展名)。绝不当精华收进阅读清单。
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.crt', '.cer', '.der']);
const SECRET_NAME_RE = /^\.env($|\.)|(^|[._-])(id_rsa|id_dsa|id_ecdsa|id_ed25519)($|\.)/i;

// 糟粕:压缩/生成产物(basename 命中)。
const MINIFIED_RE = /\.(min|bundle)\.(js|css|mjs)$|\.min\.map$|\.map$/i;

// 糟粕:OS / 编辑器垃圾。
const OS_JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.directory']);

// ── 已知参考项目台账(Khy 开发实际借鉴过;有档可查,便于「与旧基线对比」引导)。──────────
// 只做识别提示——命中即在报告里点名「这像 X, Khy 在 <doc> 里学过, 可对比旧基线」。不读盘、不下判断。
const KNOWN_REFERENCES = Object.freeze([
  Object.freeze({ id: 'deepseek-tui', name: 'DeepSeek-TUI', markers: ['deepseek-tui', 'deepseek_tui', 'ratatui'], doc: 'docs/07_OPS_运维/[OPS-MAN-016] khy-ux-交付-深度学习指南.md' }),
  Object.freeze({ id: 'hermes', name: 'Hermes Agent', markers: ['hermes-agent', 'hermes_agent', 'hermesagent'], doc: 'docs/08_MGMT_项目管理/[MGMT-RPT-009] hermes-成长架构-学习清单-2026-05-17.md' }),
  Object.freeze({ id: 'opencode', name: 'OpenCode', markers: ['opencode', 'open-code'], doc: 'docs/07_OPS_运维/[OPS-MAN-016] khy-ux-交付-深度学习指南.md' }),
  Object.freeze({ id: 'claude-code', name: 'Claude Code', markers: ['claude-code', 'claude_code', '@anthropic-ai/claude-code'], doc: 'CC_ALIGNMENT_AUDIT.md' }),
]);

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 精华/糟粕分类总开关。默认 on。 */
function isCatalogEnabled(env) {
  return _isEnabled('KHY_UPSTREAM_STUDY_CATALOG', env);
}

const _resolveNumeric = require('../utils/resolveNumericFlag');

/** 精华阅读清单条目数(Top-N)。 */
function resolveTop(env) {
  return _resolveNumeric('KHY_UPSTREAM_STUDY_TOP', env, 25, 1, 500);
}

/** 单精华文件「可读」大小上限(字节);超此标 tooLarge(仍算精华,不进首要阅读位)。 */
function resolveMaxReadableBytes(env) {
  return _resolveNumeric('KHY_UPSTREAM_STUDY_MAX_FILE_KB', env, 256, 1, 1048576) * KB;
}

/** 「超大 blob」判糟粕的大小阈值(字节)。 */
function resolveBlobBytes(env) {
  return _resolveNumeric('KHY_UPSTREAM_STUDY_BLOB_MB', env, 5, 1, 1048576) * MB;
}

/** 取小写扩展名(含点);无扩展名返 ''。隐藏文件(以点开头)不算扩展名。 */
function extOf(path) {
  const p = String(path || '');
  const base = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i).toLowerCase();
}

/** 取 basename(小写),去尾部分隔符。 */
function baseOf(path) {
  const p = String(path || '');
  return (p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').toLowerCase();
}

/** 路径拆段(小写),用于目录段命中判定。 */
function _segments(path) {
  return String(path || '').split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/** basename 去扩展名(小写)。 */
function _stem(base) {
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

function _isTest(path) {
  const segs = _segments(path);
  for (const s of segs) {
    if (s === 'test' || s === 'tests' || s === 'spec' || s === '__tests__' || s === 'testdata' || s === '__mocks__') return true;
  }
  const base = baseOf(path);
  return /(^|[._-])(test|spec)([._-]|$)/i.test(base) || /\.(test|spec)\./i.test(base);
}

/**
 * 分类单个条目:精华(essence)/ 糟粕(dross)/ 中性(neutral)。绝不抛。
 * 门控关 ⇒ 恒 {verdict:'neutral', bucket:'', reason:''}(逐字节回退)。
 *
 * 判定顺序:先判糟粕(排除),再判精华(收纳),都不命中为中性。
 *
 * @param {{path:string, size:number}} entry
 * @param {object} [env]
 * @returns {{verdict:'essence'|'dross'|'neutral', bucket:string, reason:string, tooLarge?:boolean}}
 */
function classifyEntry(entry, env) {
  const NEUTRAL = { verdict: 'neutral', bucket: '', reason: '' };
  try {
    if (!isCatalogEnabled(env)) return { ...NEUTRAL };
    if (!entry) return { ...NEUTRAL };
    const path = String(entry.path || '');
    if (!path) return { ...NEUTRAL };
    const size = Number(entry.size);
    const ext = extOf(path);
    const base = baseOf(path);
    const stem = _stem(base);
    const segs = _segments(path);

    // ── 糟粕(排除)──────────────────────────────────────────────
    if (OS_JUNK.has(base)) return { verdict: 'dross', bucket: 'os-junk', reason: 'OS/编辑器垃圾文件' };
    if (SECRET_EXTS.has(ext) || SECRET_NAME_RE.test(base)) {
      return { verdict: 'dross', bucket: 'secret', reason: '密钥/机密文件, 绝不纳入' };
    }
    for (const s of segs.slice(0, -1)) {           // 只看目录段(不含 basename)
      if (DROSS_DIRS.has(s)) return { verdict: 'dross', bucket: 'vendored', reason: `位于 ${s}/(依赖/生成物目录)` };
    }
    if (LOCKFILES.has(base)) return { verdict: 'dross', bucket: 'lockfile', reason: '依赖锁文件, 逐行无学习价值' };
    if (MINIFIED_RE.test(base)) return { verdict: 'dross', bucket: 'minified', reason: '压缩/生成产物(min/bundle/map)' };
    if (BINARY_EXTS.has(ext)) return { verdict: 'dross', bucket: 'binary', reason: '二进制/媒体/归档, 无法逐行读' };
    if (Number.isFinite(size) && size > resolveBlobBytes(env)) {
      return { verdict: 'dross', bucket: 'oversized', reason: '超大 blob(超阈值), 略过' };
    }

    // ── 精华(收纳)──────────────────────────────────────────────
    const tooLarge = Number.isFinite(size) && size > resolveMaxReadableBytes(env);
    if (CHANGELOG_RE.test(stem)) return { verdict: 'essence', bucket: 'changelog', reason: '更新说明:一眼看清改了什么', tooLarge };
    if (_isTest(path)) return { verdict: 'essence', bucket: 'test', reason: '测试:揭示预期行为与边界', tooLarge };
    if (SOURCE_EXTS.has(ext)) return { verdict: 'essence', bucket: 'source', reason: `源码(${ext})`, tooLarge };
    if (DOC_EXTS.has(ext)) return { verdict: 'essence', bucket: 'doc', reason: '文档/理据:为什么这么做', tooLarge };
    if (CONFIG_NAMES.has(base)) return { verdict: 'essence', bucket: 'config', reason: '配置:揭示项目约定', tooLarge };

    return { ...NEUTRAL };
  } catch {
    return { verdict: 'neutral', bucket: '', reason: '' };
  }
}

// 精华各桶的基础学习价值(越高越该先读)。
const BUCKET_BASE = Object.freeze({
  changelog: 100,
  source: 60,
  test: 50,
  doc: 40,
  config: 30,
});

/**
 * 给一个精华条目打学习价值分(用于 Top-N 排序)。绝不抛,门控关 ⇒ 0。
 * 新增文件 +25、相对旧基线改动 +40(改动的源码最值得看)、过大 −30(略读位)。
 *
 * @param {{path:string, size:number, bucket:string, tooLarge?:boolean}} entry 已带 classifyEntry 的 bucket
 * @param {{isNew?:boolean, isChanged?:boolean}} [diff]
 * @param {object} [env]
 * @returns {number}
 */
function scoreEssence(entry, diff, env) {
  try {
    if (!isCatalogEnabled(env)) return 0;
    if (!entry) return 0;
    let score = BUCKET_BASE[entry.bucket] || 10;
    const d = diff || {};
    if (d.isChanged) score += 40;
    else if (d.isNew) score += 25;
    if (entry.tooLarge) score -= 30;
    // 越浅的路径通常越核心(顶层 src/ 比深埋 examples/ 更值得先读)。
    const depth = _segments(entry.path).length;
    if (depth <= 3) score += 5;
    else if (depth >= 7) score -= 5;
    return score;
  } catch {
    return 0;
  }
}

/**
 * 从条目列表识别这像 Khy 学过的哪个开源项目(命中 marker 即点名 + 指向已有档)。绝不抛。
 * 门控关 ⇒ null(不影响清点)。只看 archiveName 与路径字符串,不读盘。
 *
 * @param {Array<{path:string}>} entries
 * @param {string} [archiveName]
 * @param {object} [env]
 * @returns {{id:string, name:string, doc:string}|null}
 */
function recognizeProject(entries, archiveName, env) {
  try {
    if (!isCatalogEnabled(env)) return null;
    const hay = [String(archiveName || '').toLowerCase()];
    const list = Array.isArray(entries) ? entries : [];
    // 只取前若干条路径参与匹配(有界,避免超大清单逐条 includes)。
    for (let i = 0; i < list.length && i < 400; i += 1) {
      const p = list[i] && list[i].path;
      if (p) hay.push(String(p).toLowerCase());
    }
    const blob = hay.join('\n');
    for (const ref of KNOWN_REFERENCES) {
      for (const m of ref.markers) {
        if (blob.includes(m)) return { id: ref.id, name: ref.name, doc: ref.doc };
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  isCatalogEnabled,
  classifyEntry,
  scoreEssence,
  recognizeProject,
  resolveTop,
  resolveMaxReadableBytes,
  resolveBlobBytes,
  extOf,
  baseOf,
  BUCKET_BASE,
  KNOWN_REFERENCES,
  SOURCE_EXTS,
  DROSS_DIRS,
};
