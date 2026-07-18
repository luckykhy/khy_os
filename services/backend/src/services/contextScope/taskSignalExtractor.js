'use strict';

/**
 * taskSignalExtractor.js — deterministic task → retrieval signals.
 *
 * Given a raw task / user message, extract the concrete signals that tell us
 * WHAT to read and WHAT to search, without invoking any model. These signals
 * are the precision lever: instead of "read everything", we read what the task
 * literally points at (identifiers, file/dir/extension hints, quoted strings)
 * plus the meaningful keywords.
 *
 * Output shape (all arrays deduped, original-case identifiers preserved):
 *   {
 *     identifiers: string[],  // camelCase / snake_case / PascalCase / dotted symbols
 *     fileHints:   string[],  // path-like tokens ending in an extension
 *     dirHints:    string[],  // directory-segment tokens
 *     extHints:    string[],  // bare extensions (".js", ".c")
 *     quoted:      string[],  // contents of "..." '...' `...`
 *     keywords:    string[],  // meaningful lexical tokens (en + CJK), stopwords removed
 *     intent:      string     // read | find | fix | implement | refactor | explain | general
 *   }
 *
 * Pure and side-effect free. Never throws on malformed input.
 */

// Common English + Chinese particles that carry no retrieval value.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'how', 'what',
  'where', 'why', 'when', 'which', 'this', 'that', 'these', 'those', 'it', 'its',
  'me', 'my', 'you', 'your', 'can', 'could', 'should', 'would', 'please', 'need',
  'about', 'into', 'from', 'some', 'any', 'all', 'not', 'let', 'make', 'using',
  '怎么', '如何', '什么', '哪些', '哪个', '这个', '那个', '一些', '需要', '可以',
  '应该', '请', '帮', '我', '你', '的', '了', '是', '在', '和', '与', '做到',
  '不用', '一下', '看看', '关于', '以及', '或者', '这样', '那样', '它',
]);

const RE_DOTTED = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g;     // foo.bar.baz, obj.method
const RE_CAMEL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;             // camelCase
const RE_PASCAL = /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g;            // PascalCase
const RE_SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;               // snake_case
const RE_FILE = /(?:^|[\s"'`(<])([\w./\\-]+\.[A-Za-z]{1,6})(?=$|[\s"'`)>:,;])/gm;
const RE_EXT = /(?:^|[\s*])(\.[A-Za-z]{1,6})\b/g;                    // ".js", "*.vue"
const RE_QUOTED = /"([^"]{1,80})"|'([^']{1,80})'|`([^`]{1,80})`/g;
const RE_CJK_RUN = /[一-鿿]{2,8}/g;
const RE_WORD = /\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g;

// Known directory anchors used to recognise dir hints even without a slash.
const DIR_ANCHORS = [
  'kernel', 'services', 'backend', 'frontend', 'tools', 'src', 'lib', 'apps',
  'platform', 'packaging', 'scripts', 'docs', 'bridge', 'routes', 'controllers',
  'models', 'components', 'views', 'pages', 'utils', 'config', 'tests', 'test',
];

// Word-boundary matchers for each anchor, precompiled once at module load
// (Ch2「不要每轮重建可复用结构」). extractSignals() previously compiled a fresh
// RegExp per anchor on every call; all anchors are plain word literals, so the
// `\b<anchor>\b` patterns are constant and safe to build once. Read-only.
const _DIR_ANCHOR_MATCHERS = DIR_ANCHORS.map((d) => ({ dir: d, re: new RegExp(`\\b${d}\\b`) }));

const INTENT_RULES = [
  { intent: 'fix', re: /\b(fix|bug|error|broken|crash|fail|repair|debug)\b|修复|报错|崩溃|失败|调试/iu },
  { intent: 'implement', re: /\b(implement|add|create|build|new feature|write)\b|实现|新增|添加|创建|构建/iu },
  { intent: 'refactor', re: /\b(refactor|cleanup|rename|restructure|simplify)\b|重构|清理|重命名|简化/iu },
  { intent: 'find', re: /\b(find|locate|where|search|look for)\b|在哪|哪个文件|查找|定位|搜索/iu },
  { intent: 'explain', re: /\b(explain|understand|how does|what is|describe)\b|解释|理解|说明|原理|讲解/iu },
  { intent: 'read', re: /\b(read|review|inspect|check)\b|读取|查看|审阅|检查/iu },
];

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function matchAll(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    // Prefer the first defined capture group, else the whole match.
    const val = m.slice(1).find((g) => g != null) ?? m[0];
    if (val) out.push(val);
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard zero-width
  }
  return out;
}

function classifyIntent(text) {
  for (const rule of INTENT_RULES) {
    if (rule.re.test(text)) return rule.intent;
  }
  return 'general';
}

/**
 * @param {string} task
 * @returns {{identifiers:string[],fileHints:string[],dirHints:string[],extHints:string[],quoted:string[],keywords:string[],intent:string}}
 */
function extractSignals(task) {
  const text = String(task == null ? '' : task);
  if (!text.trim()) {
    return { identifiers: [], fileHints: [], dirHints: [], extHints: [], quoted: [], keywords: [], intent: 'general' };
  }

  const identifiers = dedupe([
    ...matchAll(text, RE_DOTTED),
    ...matchAll(text, RE_CAMEL),
    ...matchAll(text, RE_PASCAL),
    ...matchAll(text, RE_SNAKE),
  ]);

  const fileHints = dedupe(matchAll(text, RE_FILE));

  const extHints = dedupe(
    matchAll(text, RE_EXT).map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)),
  );

  const quoted = dedupe(matchAll(text, RE_QUOTED));

  // Directory hints: explicit slash segments + recognised anchors.
  const slashDirs = [];
  for (const seg of text.split(/[\s"'`()<>]+/)) {
    if (seg.includes('/') || seg.includes('\\')) {
      for (const part of seg.split(/[/\\]+/)) {
        if (part && /^[\w.-]+$/.test(part) && !part.includes('.')) slashDirs.push(part.toLowerCase());
      }
    }
  }
  const lower = text.toLowerCase();
  const anchorDirs = _DIR_ANCHOR_MATCHERS.filter((m) => m.re.test(lower)).map((m) => m.dir);
  const dirHints = dedupe([...slashDirs, ...anchorDirs]);

  // Keywords: english words + CJK runs, minus stopwords and pure identifiers
  // already captured (those are higher-signal and kept separately).
  const idLower = new Set(identifiers.map((s) => s.toLowerCase()));
  const rawWords = [
    ...matchAll(text, RE_WORD).map((w) => w.toLowerCase()),
    ...matchAll(text, RE_CJK_RUN),
  ];
  const keywords = dedupe(
    rawWords.filter((w) => !STOPWORDS.has(w) && !idLower.has(w)),
  );

  return {
    identifiers,
    fileHints,
    dirHints,
    extHints,
    quoted,
    keywords,
    intent: classifyIntent(text),
  };
}

module.exports = { extractSignals, STOPWORDS };
