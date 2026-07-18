'use strict';

/**
 * gitignoreAdvisor.js — 纯叶子:.gitignore「按栈生成 + 解析现有 + 求差集」的单一真源。
 *
 * 背景(真缺口):khy 此前**没有统一的 .gitignore 生成/维护能力**——全仓仅
 * `cli/handlers/plugin-dev.js` 写死过 3 行(`node_modules/ dist/ .DS_Store`),
 * 且**没有任何代码读取/解析**已有 .gitignore。于是既无法「按项目技术栈补全常识忽略项」,
 * 也无法「求差集只补缺失、不重复已有」。本叶子把这套纯字符串运算收成单一真源:
 *   - STACK_TEMPLATES        —— 技术栈 → 常识 ignore pattern(node/python/rust/go/java/docker/…);
 *   - parseGitignore(text)   —— 把现有 .gitignore 文本归一为 pattern 集合(去注释/空行、保留 `!` 否定);
 *   - buildGitignoreAdditions({stacks, existingText, extraPaths}) —— 只返回**缺失**的 pattern;
 *   - renderGitignoreBlock(additions, {header}) —— 渲染成待追加文本块(分组注释 + 行)。
 *
 * 契约(CONTRACT):零 IO(只读 process.env 做门控,绝不碰 fs/网络/子进程/git/流;
 *   文件读写留给薄壳 gitignoreService.js)、确定性、绝不抛(fail-soft,任何坏输入返回安全空值)、
 *   env 门控 `KHY_GITIGNORE_ADVISOR` 默认开。门控关 → buildGitignoreAdditions 返回空数组、
 *   renderGitignoreBlock 返回 ''(让薄壳字节回退到「不写任何东西」)。
 *
 * 全局门控惯例:khy 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_GITIGNORE_ADVISOR 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_GITIGNORE_ADVISOR;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

// ── 技术栈忽略模板(常识清单,单一真源)──────────────────────────────────────────
// 每个 stack 标签 → 该栈约定俗成应忽略的产物/缓存/本地文件。刻意保守:只放几乎所有
// 项目都会想忽略的项,避免误伤(例如不放 `dist/` 到 common,因为有的项目会提交 dist)。
const STACK_TEMPLATES = Object.freeze({
  common: Object.freeze([
    '.DS_Store',
    'Thumbs.db',
    '*.log',
    '.env',
    '.env.local',
    '.env.*.local',
    '*.tmp',
    '.idea/',
    '.vscode/',
  ]),
  node: Object.freeze([
    'node_modules/',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    'pnpm-debug.log*',
    '.pnpm-store/',
    'dist/',
    'build/',
    'coverage/',
    '.next/',
    '.nuxt/',
    '.cache/',
  ]),
  python: Object.freeze([
    '__pycache__/',
    '*.py[cod]',
    '*.egg-info/',
    '.eggs/',
    'build/',
    'dist/',
    '.venv/',
    'venv/',
    'env/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    '.tox/',
    'htmlcov/',
    '.coverage',
  ]),
  rust: Object.freeze([
    'target/',
    'Cargo.lock',
    '**/*.rs.bk',
  ]),
  go: Object.freeze([
    'bin/',
    '*.exe',
    '*.test',
    '*.out',
    'vendor/',
  ]),
  java: Object.freeze([
    'target/',
    'build/',
    '*.class',
    '*.jar',
    '*.war',
    '.gradle/',
    '.mvn/',
  ]),
  docker: Object.freeze([
    '*.pid',
  ]),
  static: Object.freeze([
    'dist/',
    'build/',
  ]),
});

// stack 标签归一别名:projectDetector 的 type 与常见叫法都映射到 STACK_TEMPLATES 键。
const _STACK_ALIASES = Object.freeze({
  node: 'node', nodejs: 'node', javascript: 'node', typescript: 'node', js: 'node', ts: 'node',
  python: 'python', py: 'python',
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  java: 'java', kotlin: 'java', gradle: 'java', maven: 'java',
  docker: 'docker', dockerfile: 'docker',
  static: 'static', html: 'static',
});

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStrSafe;

/** 归一单个 pattern:去前后空白。空/纯注释/纯空白 → null(调用方过滤)。 */
function _normPattern(line) {
  const t = _str(line).trim();
  if (!t) return null;
  if (t.startsWith('#')) return null; // 注释不算 pattern
  return t;
}

/**
 * 解析 .gitignore 文本 → 归一 pattern 集合(Set)。
 * - 去注释行(以 # 开头)、空行、前后空白。
 * - **保留** `!foo` 否定语义(作为独立 token,不与 `foo` 合并)。
 * - fail-soft:非字符串 / 异常 → 空 Set。
 * @param {string} text
 * @returns {Set<string>}
 */
function parseGitignore(text) {
  const set = new Set();
  try {
    if (typeof text !== 'string' || !text) return set;
    for (const raw of text.split(/\r?\n/)) {
      const p = _normPattern(raw);
      if (p) set.add(p);
    }
  } catch { /* fail-soft → 返回已收集部分 */ }
  return set;
}

/**
 * 一个 pattern 是否已被现有集合覆盖。精确匹配即算覆盖;此外把
 * `foo/` 与 `foo` 视为等价(git 里目录 pattern 常混用带/不带尾斜杠)。
 */
function _isCovered(pattern, existingSet) {
  if (existingSet.has(pattern)) return true;
  const noSlash = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const withSlash = pattern.endsWith('/') ? pattern : pattern + '/';
  return existingSet.has(noSlash) || existingSet.has(withSlash);
}

/**
 * 求「应补充进 .gitignore 的 pattern」:按栈模板 + extraPaths,减去现有已覆盖的。
 *
 * @param {object} opts
 * @param {string[]} [opts.stacks]       技术栈标签(node/python/…,自动归一别名)。
 * @param {string}   [opts.existingText] 现有 .gitignore 文本(无则视空)。
 * @param {string[]} [opts.extraPaths]   自检检出的具体文件/路径(如 `.env`、`build/big.bin`)。
 * @param {boolean}  [opts.includeCommon=true] 是否附带 common 模板。
 * @param {object}   [opts.env]
 * @returns {string[]} 去重、保序、只含**缺失**的 pattern(门控关/坏输入 → [])。
 */
function buildGitignoreAdditions(opts = {}) {
  try {
    if (!opts || typeof opts !== 'object') return [];
    const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return [];

    const existing = parseGitignore(opts && opts.existingText);
    const includeCommon = opts && opts.includeCommon === false ? false : true;

    // 1) 收集候选 pattern(保序去重)。
    const seen = new Set();
    const candidates = [];
    const pushCand = (p) => {
      const n = _normPattern(p);
      if (n && !seen.has(n)) { seen.add(n); candidates.push(n); }
    };

    if (includeCommon) {
      for (const p of STACK_TEMPLATES.common) pushCand(p);
    }

    const stacks = Array.isArray(opts && opts.stacks) ? opts.stacks : [];
    for (const raw of stacks) {
      const key = _STACK_ALIASES[_str(raw).trim().toLowerCase()];
      const tmpl = key && STACK_TEMPLATES[key];
      if (tmpl) for (const p of tmpl) pushCand(p);
    }

    // extraPaths:自检检出的具体路径,原样归一去重(保留其目录/文件形态)。
    const extra = Array.isArray(opts && opts.extraPaths) ? opts.extraPaths : [];
    for (const p of extra) pushCand(p);

    // 2) 减去现有已覆盖的。
    return candidates.filter((p) => !_isCovered(p, existing));
  } catch {
    return [];
  }
}

/**
 * 渲染待追加文本块。空 additions / 门控关 → ''(薄壳据此判断「无需写」)。
 * @param {string[]} additions
 * @param {object} [opts]
 * @param {string} [opts.header] 分组注释(默认「khy 建议的忽略项」)。
 * @param {object} [opts.env]
 * @returns {string} 形如 "\n# <header>\nfoo/\nbar\n" 的文本块(为空则 '')。
 */
function renderGitignoreBlock(additions, opts = {}) {
  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) return '';
    const lines = Array.isArray(additions)
      ? additions.map(_normPattern).filter(Boolean)
      : [];
    if (lines.length === 0) return '';
    const header = _str(opts && opts.header).trim() || 'khy 建议的忽略项';
    return `\n# ${header}\n${lines.join('\n')}\n`;
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  STACK_TEMPLATES,
  parseGitignore,
  buildGitignoreAdditions,
  renderGitignoreBlock,
};
