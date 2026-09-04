/**
 * Markdown Renderer — lightweight terminal markdown rendering.
 *
 * Extracted from aiRenderer.js. Handles:
 *   - Syntax-highlighted code blocks (JS/TS, Python, Bash, JSON, Go, Rust, SQL, CSS, HTML/XML)
 *   - Markdown tables with box-drawing alignment + side-by-side pairs
 *   - LaTeX formula → Unicode conversion
 *   - Headers, lists, blockquotes, bold, italic, inline code, links
 *   - Mermaid mindmap rendering (delegated to ./mermaid.js)
 *   - Render cache with terminal-width invalidation
 */
const { blockquoteBodyStyle } = require('./blockquoteStyle');
const {
  displayWidth,
  padToWidth,
  truncateToWidth,
  stripAnsi,
  getTerminalColumns,
} = require('./formatters');
const { planLinkDisplay } = require('./markdownLink');
const { wrapCellLines, tableCellWrapEnabled } = require('./markdownTableWrap');
const {
  renderMermaidBlock: _renderMermaidBlock,
  renderNestedListTrees: _renderNestedListTrees,
} = require('./mermaid');
const { alignOrderedListMarkers, orderedListAlignEnabled } = require('./orderedListAlign');
const { plainProcessTableEnabled, renderPlainTable } = require('./plainProcessTable');
const { c, THEME, themeRegistry } = require('./renderTheme');
const { maxOf } = require('./safeArrayMinMax');
const { italicStarRegex } = require('./starEmphasisFlanking');
const { underscoreEmphasisEnabled, applyUnderscoreEmphasis } = require('./underscoreEmphasis');
// 行内斜体星号侧接守卫(修正文里带空格的成对星号被误当斜体/被剥星):单一真源。
// 行内链接展示形态(mailto 剥 scheme 显裸邮箱、text===url 去重)收敛到单一真源
// cli/markdownLink.js(对齐 CC markdown.ts link case;门控 KHY_MARKDOWN_LINK_DISPLAY
// 默认开,关 → 一律 text-url 逐字节回退)。
// Non-spreading Math.max/min so a pathological ~130k-line code fence or
// ~130k-row table can't crash the render pass with a spread RangeError.
// Inline tool-call NOISE stripper (pure leaf). Strips bare `{"name":…,"params":…}`
// JSON lines and `<function=…>…</function>` tags the text-protocol model leaks
// into its answer, so the transcript shows only the structured tool-call rows.
// fail-soft: a missing bundled copy must never break rendering.
let _toolCallNoise;
try {
  _toolCallNoise = require('./toolCallNoise');
} catch {
  _toolCallNoise = null;
}

// 输出排版强调层(单一真源):什么该加粗 / 标题层级 / 是否字面放大。两道门控关闭时逐字节回退。
// KHY_TYPESET_EMPHASIS(默认开):所有标题加粗 + 清晰层级。KHY_TYPESET_BIG_HEADINGS(默认关·实验性):
// 用 DEC 双宽序列把 H1/H2 字形真的放大两倍宽(终端相关、ink 内 best-effort)。
const _emphasis = require('../services/typeset').textEmphasisPolicy;

// ── Markdown accent colors ──────────────────────────────────────────────
// Theme-driven via THEME (themes/*.json colors) with centralized fallbacks so
// older custom themes missing the md* keys never break rendering. Palette is
// intentionally muted/low-saturation — readable hierarchy, not a rainbow.
const _MD_COLOR_DEFAULTS = {
  mdBold: '#E5C07B', // soft warm gold for **bold** runs
  mdBullet: '#61AFEF', // muted blue for the "•" glyph only
  mdListNumber: '#61AFEF', // ordered-list ordinals, same family as bullets
  mdH3: '#61AFEF', // H3-H6 headings (was plain cyan)
  mdQuote: '#7F9CB3', // blockquote bar "│" (was dim)
};
function _mdColor(key) {
  const v = THEME[key];
  return typeof v === 'string' && v ? v : _MD_COLOR_DEFAULTS[key];
}

// ── Inline Code Highlighting ────────────────────────────────────────────

// ── Lightweight syntax highlighting for code blocks ────────────────────────
// No external deps — regex-based keyword/string/comment/number coloring.
// Covers: JS/TS, Python, Bash, JSON, Go, Rust, SQL, CSS, HTML/XML.

const _HL_KEYWORDS_JS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'class',
  'extends',
  'import',
  'export',
  'from',
  'default',
  'try',
  'catch',
  'finally',
  'throw',
  'async',
  'await',
  'yield',
  'typeof',
  'instanceof',
  'in',
  'of',
  'this',
  'super',
  'null',
  'undefined',
  'true',
  'false',
  'void',
  'delete',
]);
const _HL_KEYWORDS_PY = new Set([
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'try',
  'except',
  'finally',
  'raise',
  'import',
  'from',
  'as',
  'with',
  'pass',
  'break',
  'continue',
  'yield',
  'lambda',
  'and',
  'or',
  'not',
  'in',
  'is',
  'None',
  'True',
  'False',
  'self',
  'async',
  'await',
  'global',
  'nonlocal',
]);
const _HL_KEYWORDS_BASH = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'return',
  'exit',
  'echo',
  'export',
  'source',
  'local',
  'readonly',
  'declare',
  'set',
  'unset',
  'true',
  'false',
  'cd',
  'ls',
  'rm',
  'cp',
  'mv',
  'cat',
  'grep',
  'sed',
  'awk',
  'find',
  'sudo',
]);
const _HL_KEYWORDS_GO = new Set([
  'func',
  'return',
  'if',
  'else',
  'for',
  'range',
  'switch',
  'case',
  'break',
  'continue',
  'type',
  'struct',
  'interface',
  'map',
  'chan',
  'go',
  'defer',
  'select',
  'import',
  'package',
  'var',
  'const',
  'nil',
  'true',
  'false',
  'make',
  'append',
  'len',
  'cap',
  'error',
  'string',
  'int',
  'bool',
  'byte',
]);
const _HL_KEYWORDS_RUST = new Set([
  'fn',
  'let',
  'mut',
  'return',
  'if',
  'else',
  'for',
  'while',
  'loop',
  'match',
  'use',
  'mod',
  'pub',
  'struct',
  'enum',
  'impl',
  'trait',
  'type',
  'const',
  'static',
  'self',
  'Self',
  'where',
  'async',
  'await',
  'move',
  'unsafe',
  'extern',
  'crate',
  'super',
  'true',
  'false',
  'None',
  'Some',
  'Ok',
  'Err',
]);
const _HL_KEYWORDS_SQL = new Set([
  'select',
  'from',
  'where',
  'insert',
  'update',
  'delete',
  'create',
  'drop',
  'alter',
  'table',
  'into',
  'values',
  'set',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'on',
  'and',
  'or',
  'not',
  'null',
  'order',
  'by',
  'group',
  'having',
  'limit',
  'offset',
  'as',
  'distinct',
  'count',
  'sum',
  'avg',
  'max',
  'min',
  'like',
  'in',
  'between',
  'exists',
  'union',
  'index',
  'primary',
  'key',
]);
// Shared control/declaration keywords for C-family / JVM / scripting languages
// that have no dedicated set. Deliberately excludes JS-only words (function, var,
// let, typeof, …) so they are never colored in unrelated languages.
const _HL_KEYWORDS_COMMON = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'goto',
  'class',
  'struct',
  'enum',
  'interface',
  'trait',
  'namespace',
  'module',
  'package',
  'import',
  'using',
  'use',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'final',
  'abstract',
  'const',
  'void',
  'int',
  'long',
  'short',
  'float',
  'double',
  'char',
  'byte',
  'bool',
  'boolean',
  'string',
  'new',
  'delete',
  'this',
  'self',
  'super',
  'base',
  'try',
  'catch',
  'finally',
  'throw',
  'throws',
  'def',
  'fn',
  'func',
  'func',
  'val',
  'var',
  'let',
  'async',
  'await',
  'true',
  'false',
  'null',
  'nil',
  'none',
]);
// Languages that share the COMMON set (no JS-specific highlighting).
const _COMMON_LANGS = new Set([
  'c',
  'cpp',
  'c++',
  'cc',
  'h',
  'hpp',
  'hh',
  'objc',
  'java',
  'kotlin',
  'kt',
  'swift',
  'scala',
  'csharp',
  'cs',
  'c#',
  'php',
  'ruby',
  'rb',
  'dart',
  'groovy',
  'perl',
  'lua',
  'r',
  'julia',
  'jl',
  'php',
  'objective-c',
  'm',
  'mm',
]);

function _getKeywordSet(lang) {
  const l = String(lang || '').toLowerCase();
  if (
    l === 'js' ||
    l === 'javascript' ||
    l === 'ts' ||
    l === 'typescript' ||
    l === 'jsx' ||
    l === 'tsx'
  ) {
    return _HL_KEYWORDS_JS;
  }
  if (l === 'py' || l === 'python') {
    return _HL_KEYWORDS_PY;
  }
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh') {
    return _HL_KEYWORDS_BASH;
  }
  if (l === 'go' || l === 'golang') {
    return _HL_KEYWORDS_GO;
  }
  if (l === 'rust' || l === 'rs') {
    return _HL_KEYWORDS_RUST;
  }
  if (l === 'sql') {
    return _HL_KEYWORDS_SQL;
  }
  if (_COMMON_LANGS.has(l)) {
    return _HL_KEYWORDS_COMMON;
  }
  // Unknown / unspecified language: do NOT guess keywords (avoids false-positive
  // coloring on YAML/TOML/plaintext/etc.). Strings, numbers and comments are still
  // highlighted generically by _highlightCodeLine.
  return _HL_EMPTY_SET;
}
const _HL_EMPTY_SET = new Set();

/**
 * Highlight a single code line with lightweight syntax coloring.
 * @param {string} line - raw code line
 * @param {string} lang - language hint from code fence
 * @returns {string} ANSI-colored line
 */
function _highlightCodeLine(line, lang) {
  if (!line) {
    return line;
  }
  const l = String(lang || '').toLowerCase();

  // JSON: special handling (keys, strings, numbers, booleans)
  if (l === 'json' || l === 'jsonc') {
    return line
      .replace(/"([^"\\]|\\.)*"\s*:/g, (m) => c().cyan(m)) // keys
      .replace(/:\s*"([^"\\]|\\.)*"/g, (m) => c().green(m)) // string values
      .replace(/:\s*(-?\d+\.?\d*)/g, (_, n) => ': ' + c().yellow(n)) // numbers
      .replace(/:\s*(true|false|null)/g, (_, v) => ': ' + c().magenta(v)); // booleans
  }

  // HTML/XML: tag coloring
  if (l === 'html' || l === 'xml' || l === 'svg' || l === 'vue') {
    return line
      .replace(/(<\/?[\w-]+)/g, (m) => c().hex('#FF6B6B')(m)) // tags
      .replace(/([\w-]+)=/g, (_, attr) => c().cyan(attr) + '=') // attributes
      .replace(/"([^"]*)"/g, (m) => c().green(m)) // strings
      .replace(/<!--[\s\S]*?-->/g, (m) => c().dim(m)); // comments
  }

  // CSS: property/value coloring
  if (l === 'css' || l === 'scss' || l === 'less') {
    return line
      .replace(/([\w-]+)\s*:/g, (_, prop) => c().cyan(prop) + ':') // properties
      .replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => c().yellow(m)) // hex colors
      .replace(/\d+\.?\d*(px|em|rem|%|vh|vw|s|ms)/g, (m) => c().yellow(m)) // units
      .replace(/\/\*[\s\S]*?\*\//g, (m) => c().dim(m)); // comments
  }

  // General: keyword/string/comment/number highlighting
  const keywords = _getKeywordSet(lang);
  const isBash = l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh';
  const isPython = l === 'py' || l === 'python';

  // Tokenize with simple regex: strings → comments → numbers → keywords → rest
  let result = '';
  let i = 0;
  const src = line;

  while (i < src.length) {
    // Line comments: // or # (bash/python)
    if ((src[i] === '/' && src[i + 1] === '/') || ((isBash || isPython) && src[i] === '#')) {
      result += c().dim(src.slice(i));
      break;
    }
    // String: single or double quotes
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') {
          j++;
        } // skip escaped char
        j++;
      }
      j = Math.min(j + 1, src.length);
      result += c().green(src.slice(i, j));
      i = j;
      continue;
    }
    // Template literal
    if (src[i] === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') {
          j++;
        }
        j++;
      }
      j = Math.min(j + 1, src.length);
      result += c().green(src.slice(i, j));
      i = j;
      continue;
    }
    // Number
    if (/\d/.test(src[i]) && (i === 0 || /[\s,([{=:+\-*/<>!&|^~%]/.test(src[i - 1]))) {
      let j = i;
      while (j < src.length && /[\d.xXoObBeEa-fA-F_]/.test(src[j])) {
        j++;
      }
      result += c().yellow(src.slice(i, j));
      i = j;
      continue;
    }
    // Word (potential keyword)
    if (/[a-zA-Z_$]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_$]/.test(src[j])) {
        j++;
      }
      const word = src.slice(i, j);
      if (keywords.has(word)) {
        result += c().magenta(word);
      } else {
        result += word;
      }
      i = j;
      continue;
    }
    // Operator chars
    if (/[=<>!&|+\-*/%^~?:]/.test(src[i])) {
      result += c().hex('#888888')(src[i]);
      i++;
      continue;
    }
    result += src[i];
    i++;
  }

  return result;
}

/**
 * Display width of a single character (codepoint), in terminal columns.
 * Combining marks are zero-width; CJK / full-width ranges are 2; rest are 1.
 * @param {string} ch - a single Unicode character (one codepoint)
 * @returns {number} 0, 1, or 2
 */
function _charDisplayWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x0300 && cp <= 0x036f) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Hard-split a single unbreakable token across multiple lines at the character
 * level, each piece ≤ limit display columns. Used only as a fallback for tokens
 * (long paths, hashes, CJK runs) that have no internal whitespace to break on.
 * Physical floor: a single character wider than the limit itself (a CJK char
 * at limit=1) is emitted as its own over-wide piece -- the only permitted
 * overflow; characters are never dropped and the loop never stalls.
 * @param {string} token - a run with no break opportunities
 * @param {number} limit - per-line budget in display columns
 * @param {(s: string) => number} [measureFn] - optional width measure; defaults to _charDisplayWidth
 * @returns {string[]}
 */
// Kinsoku line-START prohibition: closing punctuation (CJK + ASCII) that
// must never begin a wrapped line produced by a character-level split.
const _NO_BREAK_BEFORE = new Set(
  Array.from(
    '\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u3011\u300B\u3009\u300D\u300F\u201D\u2019\u2026\u2014,.;:!?)]}'
  )
);
// Kinsoku line-END prohibition: opening brackets/quotes never dangle at EOL.
const _NO_BREAK_AFTER = new Set(Array.from('\uFF08\u3010\u300A\u3008\u300C\u300E\u201C\u2018'));

/** True if the string contains at least one wide (CJK/full-width) char. */
function _hasWideChar(s) {
  for (const ch of s) {
    if (_charDisplayWidth(ch) === 2) {
      return true;
    }
  }
  return false;
}

function _hardSplitToken(token, limit, measureFn) {
  const charW = typeof measureFn === 'function' ? measureFn : _charDisplayWidth;
  const chars = Array.from(token);
  const out = [];
  let start = 0; // first char index of the line being built
  let curW = 0; // display width of chars[start..i)
  let lastBreak = -1; // latest i where breaking BEFORE chars[i] is legal
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const w = charW(ch);
    if (i > start) {
      const prev = chars[i - 1];
      // Free break: at a CJK boundary, or at a word start after a space;
      // Latin words are never split. Honors both kinsoku sets above.
      if (
        ch !== ' ' &&
        (prev === ' ' || _charDisplayWidth(prev) === 2 || _charDisplayWidth(ch) === 2) &&
        !_NO_BREAK_BEFORE.has(ch) &&
        !_NO_BREAK_AFTER.has(prev)
      ) {
        lastBreak = i;
      }
    }
    // At most two passes: after cutting at a kinsoku-legal break point
    // the carried remainder may still overflow; the retry hard-cuts at i.
    while (curW + w > limit && i > start) {
      const cut = lastBreak > start && lastBreak < i ? lastBreak : i;
      out.push(chars.slice(start, cut).join('').replace(/\s+$/, ''));
      start = cut;
      curW = 0;
      for (let k = cut; k < i; k++) {
        curW += charW(chars[k]);
      }
      lastBreak = -1;
    }
    curW += w;
  }
  if (start < chars.length) {
    out.push(chars.slice(start).join(''));
  }
  return out.length ? out : [''];
}

/**
 * Wrap a RAW (ANSI-free) line to a maximum display width, accounting for CJK
 * full-width characters. Tabs are expanded to spaces first so the column count
 * stays honest. Returns an array of segments, each ≤ maxWidth display columns;
 * an empty input yields a single empty segment so blank code lines still render
 * one box row. Used for code-block content so long paths/commands stay INSIDE
 * the box instead of overflowing past the right border and wrapping at the
 * terminal edge.
 *
 * Wrapping is WORD-BOUNDARY aware: breaks happen at whitespace runs so tokens
 * (command flags, identifiers like "FullName", path segments) are never split
 * mid-word. A token longer than a whole line is the only case that falls back
 * to a character-level hard split. Leading indentation is preserved; whitespace
 * landing at a wrap boundary is dropped so continuation lines don't start with
 * stray spaces.
 * @param {string} raw - line with no ANSI escapes
 * @param {number} maxWidth - inner content budget in display columns
 * @param {(s: string) => number} [measureFn] - optional string width measure used
 *   for BOTH wrapping and hard-splitting; pass the same function the caller uses
 *   for padding so both stay consistent. Defaults to the legacy per-char sum.
 * @returns {string[]}
 */
function _wrapRawToWidth(raw, maxWidth, measureFn) {
  const text = String(raw).replace(/\t/g, '    ');
  const limit = Math.max(1, maxWidth);
  // Tokenize into alternating whitespace / non-whitespace runs so we can break
  // at word boundaries while keeping intentional indentation intact.
  const tokens = text.match(/\s+|\S+/g);
  if (!tokens) {
    return [''];
  }

  const widthOf =
    typeof measureFn === 'function'
      ? measureFn
      : (s) => {
          let w = 0;
          for (const ch of s) {
            w += _charDisplayWidth(ch);
          }
          return w;
        };

  const segments = [];
  let cur = '';
  let curW = 0;
  for (const tok of tokens) {
    const tokW = widthOf(tok);
    // Fits on the current line — append and move on.
    if (curW + tokW <= limit) {
      cur += tok;
      curW += tokW;
      continue;
    }
    // A CJK-bearing token that cannot fit the remaining space has legal
    // break points inside it: merge it with the current line and fill
    // this line to the brim instead of wrapping the whole clause to the
    // next line (mixed prose: a Latin word followed by an unspaced CJK
    // sentence). Latin-only tokens keep whole-word wrapping below.
    if (cur !== '' && !/^\s+$/.test(tok) && _hasWideChar(tok)) {
      const pieces = _hardSplitToken(cur + tok, limit, measureFn);
      for (let i = 0; i < pieces.length - 1; i++) {
        segments.push(pieces[i]);
      }
      cur = pieces[pieces.length - 1];
      curW = widthOf(cur);
      continue;
    }
    // A token wider than a whole line cannot fit anywhere: combine with the
    // current line content and hard-split at the character level. The last
    // piece carries over as the new current line so we don't waste columns.
    if (tokW > limit) {
      const pieces = _hardSplitToken(cur + tok, limit, measureFn);
      for (let i = 0; i < pieces.length - 1; i++) {
        segments.push(pieces[i]);
      }
      cur = pieces[pieces.length - 1];
      curW = widthOf(cur);
      continue;
    }
    // Token fits on its own line but not after the current content: wrap here.
    if (cur !== '') {
      segments.push(cur);
    }
    if (/^\s+$/.test(tok)) {
      // Whitespace at a wrap boundary is dropped (no leading-space continuation).
      cur = '';
      curW = 0;
    } else {
      cur = tok;
      curW = tokW;
    }
  }
  if (cur !== '') {
    segments.push(cur);
  }
  return segments.length ? segments : [''];
}

/**
 * Light markdown rendering for AI responses.
 * Handles: headers, inline code, code blocks, bold.
 */
// ── Markdown render cache (LRU, 500 entries) ──
// Cache hit avoids all regex work. Invalidates on terminal resize and theme switch.
const { LRUCache } = require('./utils/lruCache');
const _mdCache = new LRUCache(500);
let _mdCacheLastTheme = '';

// Effective columns for the CURRENT render pass (任务#16): a valid colsOverride
// (e.g. the streaming left-column width while the board shares the flex row)
// beats the live terminal width, so soft-wrap decisions (code boxes, tables)
// match the actual column the text is rendered into — full-width wrapping
// produced rows wider than the left column that ink then re-wrapped (ugly
// double wrap). 0 = no override → getTerminalColumns(), byte-identical for
// every caller that does not pass a width. Rendering is synchronous, so a
// module-level slot set/reset around the inner render is race-free.
let _renderColsOverride = 0;
function _effectiveCols() {
  return _renderColsOverride > 0 ? _renderColsOverride : getTerminalColumns();
}

function renderMarkdownLite(text, colsOverride) {
  const ov = Number.isFinite(colsOverride) && colsOverride > 0 ? Math.floor(colsOverride) : 0;
  const cols = ov > 0 ? ov : getTerminalColumns();
  // Theme switch must also drop cached output, or stale ANSI colors from the
  // previously active theme would be served on cache hits.
  const themeName = themeRegistry.getActiveName();
  if (themeName !== _mdCacheLastTheme) {
    _mdCache.clear();
    _mdCacheLastTheme = themeName;
  }
  // Width joins the cache key (任务#16): the streaming path renders at the LEFT
  // column width while the committed path renders at full width — the former
  // clear-on-width-change would thrash the cache when the two alternate, and a
  // text-only key would serve wrong-width hits. NUL separator keeps the numeric
  // prefix unambiguous. Old-width entries age out via normal LRU eviction.
  const cacheKey = cols + '\u0000' + text;
  const cached = _mdCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const prevOverride = _renderColsOverride;
  _renderColsOverride = ov;
  let rendered;
  try {
    rendered = _renderMarkdownLiteInner(text);
  } finally {
    _renderColsOverride = prevOverride;
  }
  _mdCache.set(cacheKey, rendered);
  return rendered;
}

/**
 * Stream-safe variant of renderMarkdownLite for the LIVE (in-flight) region.
 *
 * While a code block is still streaming, its closing ``` has not arrived yet, so
 * the base renderer would print the raw opening fence and code lines as plain
 * text — and then the committed transcript suddenly re-renders the same span as a
 * styled box, producing the visible flicker/jump ("先显示三个反引号，闭合后突然变成
 * 代码样式"). To show a graceful INTERMEDIATE state instead, we close a dangling
 * fence with a synthetic ``` before rendering, so an in-progress block already
 * displays as a code box. Once the real closing fence arrives the output is
 * identical, so the live→committed transition no longer jumps.
 *
 * Every other construct (headings, lists, bold, tables, blockquotes) is line- or
 * pair-local and already renders the same here as in the committed path, so the
 * live preview matches what lands in scrollback. Result is LRU-cached via
 * renderMarkdownLite, so a paused stream re-renders for free.
 * @param {string} text
 * @param {number} [colsOverride] - optional column width (任务#16): valid → wrap
 *   against it instead of the full terminal width; absent/invalid → legacy.
 * @returns {string}
 */
function renderMarkdownStreaming(text, colsOverride) {
  if (!text) {
    return text;
  }
  let s = String(text);
  // An odd number of ```-fences means the final one is still open. (Only ```
  // fences get boxed by the renderer, so ~~~ is intentionally not counted.)
  const fences = s.match(/^[ \t]*```/gm);
  if (fences && fences.length % 2 === 1) {
    if (!s.endsWith('\n')) {
      s += '\n';
    }
    s += '```';
  }
  return renderMarkdownLite(s, colsOverride);
}

// ── LaTeX to Unicode terminal-friendly conversion ──────────────────────
const _latexSymbolMap = {
  '\\times': '\u00D7',
  '\\cdot': '\u00B7',
  '\\div': '\u00F7',
  '\\pm': '\u00B1',
  '\\mp': '\u2213',
  '\\leq': '\u2264',
  '\\geq': '\u2265',
  '\\neq': '\u2260',
  '\\approx': '\u2248',
  '\\equiv': '\u2261',
  '\\infty': '\u221E',
  '\\sqrt': '\u221A',
  '\\sum': '\u2211',
  '\\prod': '\u220F',
  '\\int': '\u222B',
  '\\partial': '\u2202',
  '\\nabla': '\u2207',
  '\\alpha': '\u03B1',
  '\\beta': '\u03B2',
  '\\gamma': '\u03B3',
  '\\delta': '\u03B4',
  '\\epsilon': '\u03B5',
  '\\zeta': '\u03B6',
  '\\eta': '\u03B7',
  '\\theta': '\u03B8',
  '\\iota': '\u03B9',
  '\\kappa': '\u03BA',
  '\\lambda': '\u03BB',
  '\\mu': '\u03BC',
  '\\nu': '\u03BD',
  '\\xi': '\u03BE',
  '\\pi': '\u03C0',
  '\\rho': '\u03C1',
  '\\sigma': '\u03C3',
  '\\tau': '\u03C4',
  '\\upsilon': '\u03C5',
  '\\phi': '\u03C6',
  '\\chi': '\u03C7',
  '\\psi': '\u03C8',
  '\\omega': '\u03C9',
  '\\Delta': '\u0394',
  '\\Gamma': '\u0393',
  '\\Lambda': '\u039B',
  '\\Sigma': '\u03A3',
  '\\Omega': '\u03A9',
  '\\Pi': '\u03A0',
  '\\Theta': '\u0398',
  '\\Phi': '\u03A6',
  '\\Psi': '\u03A8',
  '\\leftarrow': '\u2190',
  '\\rightarrow': '\u2192',
  '\\leftrightarrow': '\u2194',
  '\\Rightarrow': '\u21D2',
  '\\Leftarrow': '\u21D0',
  '\\Leftrightarrow': '\u21D4',
  '\\forall': '\u2200',
  '\\exists': '\u2203',
  '\\in': '\u2208',
  '\\notin': '\u2209',
  '\\subset': '\u2282',
  '\\supset': '\u2283',
  '\\cup': '\u222A',
  '\\cap': '\u2229',
  '\\emptyset': '\u2205',
  '\\varnothing': '\u2205',
  '\\land': '\u2227',
  '\\lor': '\u2228',
  '\\neg': '\u00AC',
  '\\ldots': '\u2026',
  '\\cdots': '\u22EF',
  '\\vdots': '\u22EE',
  '\\quad': '  ',
  '\\qquad': '    ',
  '\\,': ' ',
  '\\;': ' ',
  '\\!': '',
  '\\text': '',
  '\\textbf': '',
  '\\mathrm': '',
  '\\mathbf': '',
};

// Sorted by length desc so longer commands match first
const _latexSymbolKeys = Object.keys(_latexSymbolMap).sort((a, b) => b.length - a.length);

function _latexToUnicode(latex) {
  let s = String(latex || '');
  // \frac{a}{b} -> a/b
  s = s.replace(/\\frac\{([^}]*)}\{([^}]*)}/g, '($1/$2)');
  // \sqrt{x} -> √(x)
  s = s.replace(/\\sqrt\{([^}]*)}/g, '\u221A($1)');
  // \text{...}, \textbf{...}, \mathrm{...}, \mathbf{...} -> contents
  s = s.replace(/\\(?:text|textbf|mathrm|mathbf)\{([^}]*)}/g, '$1');
  // x^{exp} -> x^exp, x_{sub} -> x_sub
  s = s.replace(/\^{([^}]*)}/g, '^$1');
  s = s.replace(/_{([^}]*)}/g, '_$1');
  // Replace known symbols
  for (const key of _latexSymbolKeys) {
    if (s.includes(key)) {
      s = s.split(key).join(_latexSymbolMap[key]);
    }
  }
  // Remove remaining braces
  s = s.replace(/[{}]/g, '');
  return s.trim();
}

function _renderLatexFormulas(text) {
  // Block formulas: $$...$$ (possibly multiline)
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, formula) => {
    const rendered = _latexToUnicode(formula);
    return `\n  ${c().yellow(rendered)}\n`;
  });
  // Inline formulas: $...$ (single line, not empty, not starting with space on both sides)
  text = text.replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_m, formula) => {
    return c().yellow(_latexToUnicode(formula));
  });
  return text;
}

// Gate KHY_MD_INLINE_CODE_BEFORE_MATH (default on): protect inline `code` spans
// before LaTeX `$…$` rendering, so `$`/`{}` inside inline code are never eaten by
// the math pass. flagRegistry-first + local CANON fallback; off → legacy order.
const _MD_ICBM_FALSY = new Set(['0', 'false', 'off', 'no']);
let _mdFlagRegistry; // lazy, memoized (undefined = not yet required, null = unavailable)
function _inlineCodeBeforeMathEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    if (_mdFlagRegistry === undefined) {
      try {
        _mdFlagRegistry = require('../services/flagRegistry');
      } catch {
        _mdFlagRegistry = null;
      }
    }
    const reg = _mdFlagRegistry;
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_MD_INLINE_CODE_BEFORE_MATH', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_MD_INLINE_CODE_BEFORE_MATH;
  return !(v !== undefined && _MD_ICBM_FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * _renderInlineHtml — 把 AI 回复里常见的内联 HTML 标签渲染成终端样式,根治
 * 「标签裸露」:教学/示例场景下模型直接回 `<p>…<strong>…</strong></p>` 时,标签
 * 原样透出成尖括号文字。
 *
 * 只处理白名单标签;未知标签(如教学占位符 `<标签名>`)原样保留,绝不误伤。
 * 结构性标签(div/section/li 等)即使不成对也转成换行,保证正文不被尖括号包裹。
 * 纯展示、非破坏:存储层保留原文,只在渲染出口转换。
 */
function _renderInlineHtml(text) {
  let s = String(text == null ? '' : text);
  if (!s.includes('<')) {
    return s;
  }

  // 1) 链接 <a href="url">text</a> —— 与 markdown 链接同款展示。
  s = s.replace(
    /<a\s+[^>]*href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, _q, url, label) => {
      const lab = String(label || '').trim() || url;
      return `${c().hex(THEME.link).underline(lab)} ${c().dim(`(${url})`)}`;
    }
  );

  // 2) 加粗 <strong>/<b>。
  s = s.replace(/<(?:strong|b)\s*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, (_m, inner) =>
    c().bold.hex(_mdColor('mdBold'))(inner)
  );

  // 3) 斜体 <em>/<i>。
  s = s.replace(/<(?:em|i)\s*>([\s\S]*?)<\/(?:em|i)\s*>/gi, (_m, inner) => c().italic(inner));

  // 4) 行内代码 <code>…</code>。
  s = s.replace(/<code\s*>([\s\S]*?)<\/code\s*>/gi, (_m, inner) => c().cyan(inner));

  // 5) 换行 <br> / <br/>。
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');

  // 6) 标题 <h1..h6>…</h1..6> —— 复用 markdown 标题样式。
  s = s.replace(/<h([1-6])\s*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl, title) => {
    const level = Number(lvl);
    const big = _emphasis.bigHeadingPrefix(level);
    if (level === 1) {
      return `\n${big}  ${c().bold.hex(THEME.text)(title)}`;
    }
    if (level === 2) {
      return `\n${big}  ${c().bold.cyan(title)}`;
    }
    const h3Hex = _mdColor('mdH3');
    const styled = _emphasis.shouldBoldHeading(level)
      ? c().bold.hex(h3Hex)(title)
      : c().hex(h3Hex)(title);
    return `  ${c().dim('–')} ${styled}`;
  });

  // 7) 段落 <p>…</p> —— 内容独占一段(上下空行)。
  s = s.replace(/<p\s*>([\s\S]*?)<\/p\s*>/gi, (_m, inner) => `\n${String(inner || '').trim()}\n`);

  // 8) 列表项 <li>…</li> → 项目符号(与 markdown 列表同款)。
  s = s.replace(
    /<li\s*>([\s\S]*?)<\/li\s*>/gi,
    (_m, inner) => `\n  ${c().hex(_mdColor('mdBullet'))('•')} ${String(inner || '').trim()}`
  );

  // 9) 列表容器 <ul>/<ol> 开闭标签 → 换行(不会作为教学占位符出现)。
  s = s.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n');

  // 10) 结构性标签**整行独立成行**(行内无其他内容)才转成空行 —— 防止 `</div>` 这类
  //     单独一行的闭合标签裸露;而句中占位符(如教学里的 `用 <p>`)原样保留,绝不误伤。
  s = s.replace(
    /^\s*<\/?(?:p|div|section|article|header|footer|main|aside|nav|figure|figcaption|blockquote|span|pre)\b[^>]*>\s*$/gim,
    '\n'
  );

  // 折叠相邻换行:至少保留一个,避免段落间堆叠空行。
  s = s.replace(/\n{3,}/g, '\n\n');
  return s;
}

function _renderMarkdownLiteInner(text) {
  // First of all: strip inline tool-call protocol noise (bare JSON invocations
  // + <function=…> tags) before any markdown transform. Fence-aware (code blocks
  // preserved). Gated KHY_TOOLCALL_NOISE_STRIP (default on) → off = passthrough.
  if (_toolCallNoise) {
    text = _toolCallNoise.stripInlineToolCallNoise(text, process.env);
  }

  // Render whitelisted inline HTML (p/strong/em/code/a/h1-6/br) into terminal
  // styling so AI replies don't show raw `<…>` tags. Unknown tags pass through.
  text = _renderInlineHtml(text);

  text = _normalizeListAndRuleArtifacts(text);

  // Pre-pass: render tables before other transforms
  text = _renderMarkdownTables(text);

  // Strip common AI wrapper XML tags (execution_plan, thinking, etc.)
  text = text.replace(
    /<\/?(?:execution_plan|thinking|plan|reasoning|steps|analysis|output)>/gi,
    ''
  );
  // Strip key-findings markers (carry a type="…" attribute) — streaming residue
  // safety net; the loop already removes the full block via _stripExecutionPlan.
  text = text.replace(/<finding\b[^>]*>|<\/finding>/gi, '');

  // Render deeply nested lists as trees before bullet replacement
  text = _renderNestedListTrees(text);

  // LaTeX formulas: convert $...$ and $$...$$ to Unicode math symbols.
  // Must run before the main replace chain because $ can conflict with other patterns.
  // Code blocks are already extracted by the chain below (they get ANSI codes),
  // so we protect them by extracting ```...``` first, rendering LaTeX, then restoring.
  const _codeBlockPlaceholders = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    _codeBlockPlaceholders.push(m);
    return `\x00CB${_codeBlockPlaceholders.length - 1}\x00`;
  });
  // Protect inline code spans from the emphasis/link chain so markdown markers
  // inside `code` are never reinterpreted (e.g. `a*b` must not turn italic).
  // Done while fenced blocks are still hidden as placeholders, so backticks that
  // belong to ``` fences cannot be mis-captured here. Double-backtick first.
  const _inlineCodePlaceholders = [];
  const _protectInlineCode = (code) => {
    _inlineCodePlaceholders.push(code);
    return `\x00IC${_inlineCodePlaceholders.length - 1}\x00`;
  };
  const _protectInlineCodeSpans = () => {
    text = text
      .replace(/``([^`]+?)``/g, (_m, code) => _protectInlineCode(code))
      .replace(/`([^`\n]+?)`/g, (_m, code) => _protectInlineCode(code));
  };
  // KHY_MD_INLINE_CODE_BEFORE_MATH (default on): protect inline code BEFORE LaTeX
  // so `$`/`{}` inside inline code (e.g. a shell command `… "$files = @{}"`) are
  // never mis-parsed as `$…$` math — which drops the `$` delimiters and strips
  // braces (corrupting e.g. a narration command echo into `files = @`). Off →
  // legacy order (LaTeX first, then protect), byte-identical to prior behavior.
  const _inlineBeforeMath = _inlineCodeBeforeMathEnabled(process.env);
  if (_inlineBeforeMath) {
    _protectInlineCodeSpans();
  }
  text = _renderLatexFormulas(text);
  if (!_inlineBeforeMath) {
    _protectInlineCodeSpans();
  }

  // Ordered-list marker alignment (CC ui/OrderedList.tsx: padStart to the run's
  // widest ordinal so dots/content stay flush across 9→10). MUST run while fenced
  // code blocks are still hidden as \x00CB…\x00 placeholders (which can never match
  // the "N." item regex), so numbered lines INSIDE a ``` fence stay verbatim.
  // Running it after the restore below re-indented list-looking code content
  // (`1.`/`2.` gained a leading space to align with `10.`) — a corruption of the
  // verbatim-code contract. Pad spaces fold into the (\s*) indent group of the
  // numbered-list rule; runs before the colorize chain. Gate KHY_OL_MARKER_ALIGN
  // (default on); off → byte-identical (single-width runs are byte-identical too).
  if (orderedListAlignEnabled()) {
    text = alignOrderedListMarkers(text);
  }

  // Restore fenced blocks so the main chain can box + syntax-highlight them.
  text = text.replace(/\x00CB(\d+)\x00/g, (_m, idx) => _codeBlockPlaceholders[Number(idx)]);

  let rendered = text
    // Code blocks (```...```) — syntax-highlighted, intercept mermaid mindmaps
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      if (lang.toLowerCase() === 'mermaid') {
        const rendered = _renderMermaidBlock(code);
        if (rendered) {
          return rendered;
        }
      }
      const lines = code.split('\n');
      // 代码块采用「浅灰底色 + 无边框」渲染:不再用 box-drawing 字符(╭ ╮ ╰ ╯ │ ─)拼
      // 方框。旧方案在每行代码左右各写一个竖线 │,用户在终端选中复制代码时会把这两个
      // │ 一起带走,必须手动删除。改为给每行铺一层 ANSI 背景色形成整齐的底色块来区分
      // 代码区,行尾用背景色补齐到统一宽度;左边距空格放在底色块之外,复制到的就是纯
      // 代码内容(不含任何边框字符)。
      // 面板内容宽度 = 各行代码宽度上限,并夹到终端宽度以内:左边距 2 列 + 底色块内首尾
      // 各 1 列 padding = 共 4 列开销,故 panelW ≤ 屏宽-4,保证整块不超出屏幕。
      const maxLineW = maxOf(
        lines.map((l) => displayWidth(l)),
        18
      );
      const panelW = Math.max(1, Math.min(maxLineW, _effectiveCols() - 4));
      // 底色:256 色中性灰(237),对亮色系语法高亮保持足够对比,且兼容常见终端。
      const shade = (s) => c().bgAnsi256(237)(s);
      // 语言标签:低调暗色,单独占代码块上方一行,不用边框包裹。
      const langLine = lang ? `  ${c().dim(lang)}` : null;
      // 代码行:底色块 = 前置 1 空格 padding + 代码 + 右侧背景色补齐 + 后置 1 空格 padding。
      // 长行按词软折行,保证整块底色对齐且不超出屏幕宽度。
      const codeLines = lines
        .flatMap((l) => _wrapRawToWidth(l, panelW, displayWidth))
        .map((seg) => {
          const highlighted = _highlightCodeLine(seg, lang);
          const rightPad = Math.max(0, panelW - displayWidth(seg));
          return `  ${shade(` ${highlighted}${' '.repeat(rightPad)} `)}`;
        })
        .join('\n');
      return langLine ? `${langLine}\n${codeLines}` : codeLines;
    })
    // Horizontal rules (---, ***, ___) — drop to a blank line. The previous
    // full-width / compact dim rule felt like visual noise between paragraphs
    // (see the "线太多" complaint on 2026-08-31). Surrounding markdown already
    // provides a blank line above and below for visual separation; rendering
    // an explicit rule on top of that was redundant. We keep the placeholder
    // so the surrounding pipeline can still match the rule shape.
    .replace(/^(\s*)[-*_]{3,}\s*$/gm, (_m, indent) => {
      return '';
    })
    // Headers — visual hierarchy: h1 > h2 > h3..h6. 加粗/层级由 textEmphasisPolicy 单一真源裁定。
    // `big` 为 DEC 双宽行首前缀(默认关·实验性):必须置于物理行**最前**才生效,故紧跟换行/行首,
    // 早于缩进与边框;门控关时 big='' 整段逐字节回退到旧渲染。宽度计算一律用未放大的纯 title。
    .replace(/^(#{1,6})\s+(.+)$/gm, (_m, hashes, title) => {
      const level = hashes.length;
      const big = _emphasis.bigHeadingPrefix(level);
      if (level === 1) {
        // H1: bold themed title only — no rule decoration (blank line above
        // provides the separation; rules were deemed visually noisy).
        return `\n${big}  ${c().bold.hex(THEME.text)(title)}`;
      }
      if (level === 2) {
        // H2: bold cyan, no heavy icon(本就加粗)
        return `\n${big}  ${c().bold.cyan(title)}`;
      }
      // H3..H6: 强调层开 → 加粗柔和蓝(主题键 mdH3);关 → 非加粗同色。
      const h3Hex = _mdColor('mdH3');
      const styled = _emphasis.shouldBoldHeading(level)
        ? c().bold.hex(h3Hex)(title)
        : c().hex(h3Hex)(title);
      return `  ${c().dim('–')} ${styled}`;
    })
    // Images ![alt](url) — render BEFORE links so the leading ! is consumed and
    // the image is not mistaken for a plain link.
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
      const label = alt && alt.trim() ? alt.trim() : 'image';
      return `${c().dim('▦')} ${c().hex(THEME.link).underline(label)} ${c().dim(`(${url})`)}`;
    })
    // Links [text](url) — 展示形态由 markdownLink SSOT 裁定(对齐 CC link case):
    //   mailto → 裸邮箱纯文本(剥 scheme);text===url → URL 只显一次;否则 text + dim(url)。
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
      const plan = planLinkDisplay(text, url, process.env);
      if (plan.kind === 'plain') {
        return plan.text;
      } // mailto 裸邮箱:纯文本,不着色(对齐 CC)
      if (plan.kind === 'url-only') {
        return `${c().hex(THEME.link).underline(plan.url)}`;
      }
      return `${c().hex(THEME.link).underline(plan.text)} ${c().dim(`(${plan.url})`)}`;
    })
    // Bold-italic (***text***) — must run before bold/italic so the triple
    // markers are not partially consumed by the bold rule. Shares mdBold accent.
    .replace(/\*\*\*(.+?)\*\*\*/g, (_m, text) => c().bold.italic.hex(_mdColor('mdBold'))(text))
    // Bold — bold + soft warm accent (theme key mdBold) for scannability
    .replace(/\*\*(.+?)\*\*/g, (_m, text) => c().bold.hex(_mdColor('mdBold'))(text))
    // Italic
    .replace(italicStarRegex(process.env), (_m, text) => c().italic(text))
    // Strikethrough (~~text~~). (?!~) keeps ``` ~~~ ``` fence markers intact and
    // .+? never crosses a newline so multi-line tilde fences are unaffected.
    .replace(/~~(?!~)(.+?)~~/g, (_m, text) => c().strikethrough(text))
    // Task list checkboxes (- [ ] / - [x]) — before generic bullets.
    .replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/gm, (_m, indent, mark) => {
      const checked = mark.toLowerCase() === 'x';
      return `${indent}${checked ? c().green('☑') : c().dim('☐')} `;
    })
    // Numbered lists (1. 2. 3.) — preserve the ordinal instead of collapsing to a bullet.
    .replace(/^(\s*)(\d+)\.\s+/gm, (_m, indent, num) => {
      return `${indent}${c().hex(_mdColor('mdListNumber'))(`${num}.`)} `;
    })
    // Bullet lists (-, *, +) — color only the "•" glyph, body keeps default color
    .replace(/^(\s*)[-*+]\s+/gm, (_m, indent) => `${indent}${c().hex(_mdColor('mdBullet'))('•')} `)
    // Blockquotes (>, nested >>) — one dim bar per nesting level.
    // 对齐 CC `markdown.ts` blockquote:竖条 dim,正文 italic·正常亮度(深色主题
    // 下 dim 几乎不可见)。门控 KHY_BLOCKQUOTE_STYLE 开→italic;关→历史 dim 字节回退。
    .replace(/^((?:>\s?)+)(.*)$/gm, (_m, markers, body) => {
      const depth = (markers.match(/>/g) || []).length;
      const bars = Array.from({ length: depth }, () => c().hex(_mdColor('mdQuote'))('│')).join(' ');
      return `  ${bars} ${c()[blockquoteBodyStyle()](body)}`;
    });

  // Underscore emphasis (_italic_, __bold__, ___bi___) — aligns CC's CommonMark
  // emphasis which recognizes both `*` and `_`. Runs after the asterisk chain,
  // with a CommonMark intraword guard so snake_case stays literal. Inline code
  // is still placeholder-protected here (restored below), so `code_with_under`
  // in backticks is untouched. Gate KHY_UNDERSCORE_EMPHASIS (default on); off →
  // step is skipped → underscores byte-identical legacy (raw, unstyled).
  if (underscoreEmphasisEnabled()) {
    rendered = applyUnderscoreEmphasis(rendered, {
      italic: (t) => c().italic(t),
      bold: (t) => c().bold.hex(_mdColor('mdBold'))(t),
      boldItalic: (t) => c().bold.italic(t),
    });
  }

  // Restore inline code spans (cyan), now that the emphasis/link chain is done.
  rendered = rendered.replace(/\x00IC(\d+)\x00/g, (_m, idx) =>
    c().cyan(_inlineCodePlaceholders[Number(idx)])
  );
  return rendered;
}

function _normalizeListAndRuleArtifacts(text) {
  let normalized = String(text || '');
  // Fix malformed list blocks where "-" / "1." and content are split by newline.
  normalized = normalized
    .replace(/^(\s*[-*])\s*\n\s+/gm, '$1 ')
    .replace(/^(\s*\d+\.)\s*\n\s+/gm, '$1 ');
  // Deduplicate accidentally repeated leading sentence:
  // "A。A。..." -> "A。..."
  normalized = _dedupeLeadingSentence(normalized);
  // Drop dangling half-sentences that are often emitted before a fuller line.
  normalized = _dropDanglingLeadFragments(normalized);
  // Some model outputs accidentally prefix long separators with a stray "m".
  normalized = normalized.replace(/^[mM]\s*([─-]{10,})\s*$/gm, '$1');
  // De-scatter: collapse excess blank lines and tighten list blocks so a
  // "标题：" + bullet list renders as a compact unit, not spread across the screen.
  normalized = _tightenVerticalRhythm(normalized);
  return normalized;
}

/**
 * 收紧垂直留白 — 治「渲染太零散」。模型常在小标题/列表之间多打空行，渲染后整段
 * 被拉得很散。本 pass 在不动正文语义的前提下：
 *   1) 连续 2+ 空行 → 至多 1 行；
 *   2) 相邻两个列表项之间的单空行 → 去掉（列表连排）；
 *   3) 「标题行 / 以冒号结尾的引导行」与紧随其后的列表项之间的单空行 → 去掉。
 * 段落之间的单空行保留（不影响普通正文呼吸感）。代码块内空行受保护、绝不改动。
 * 逃生阀 KHY_MD_TIGHTEN=0 完全关闭。
 */
function _tightenVerticalRhythm(text) {
  if (String(process.env.KHY_MD_TIGHTEN || '').trim() === '0') {
    return text;
  }
  let s = String(text || '');
  if (!s) {
    return s;
  }

  // 保护 ```fenced``` 代码块：里面的空行是有意义的，绝不收紧。
  const blocks = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\x00TR${blocks.length - 1}\x00`;
  });

  const isItem = (l) => /^\s*([-*+]|\d+\.)\s+/.test(l);
  const isLabel = (l) => {
    const raw = String(l || '');
    const t = raw.trim().replace(/\*\*/g, '');
    return (
      /[：:]\s*$/.test(t) || // 以冒号结尾的引导行（"文件夹（21个）："）
      /^#{1,6}\s+/.test(raw) || // Markdown 标题
      /^\*\*[^*]+\*\*\s*$/.test(raw.trim())
    ); // 整行加粗的小标题
  };

  const lines = s.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      // 吞掉整段连续空行，再决定保留 0 行还是 1 行。
      let j = i;
      while (j < lines.length && lines[j].trim() === '') {
        j++;
      }
      const prev = out.length ? out[out.length - 1] : '';
      const next = j < lines.length ? lines[j] : '';
      const tightDrop = (isItem(prev) && isItem(next)) || (isLabel(prev) && isItem(next));
      // 跳过首尾空行（prev/next 为空），列表相邻去空行，其余折叠为单空行。
      if (!tightDrop && prev !== '' && next !== '') {
        out.push('');
      }
      i = j - 1;
      continue;
    }
    out.push(lines[i]);
  }
  s = out.join('\n');
  s = s.replace(/\x00TR(\d+)\x00/g, (_m, idx) => blocks[Number(idx)]);
  return s;
}

function _dedupeLeadingSentence(text) {
  const src = String(text || '');
  return src.replace(/^([^\n。！？!?]{2,120}[。！？!?])(?:\s*\1){1,2}\s*/u, '$1');
}

function _dropDanglingLeadFragments(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = String(lines[i] || '').trim();
    if (/^(?:好[的吧呀]?[，,]?\s*)?帮$/.test(cur)) {
      const next = String(lines[i + 1] || '').trim();
      const next2 = String(lines[i + 2] || '').trim();
      const next3 = String(lines[i + 3] || '').trim();
      if (/^帮你/.test(next) || /^帮你/.test(next2) || /^帮你/.test(next3)) {
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Render Markdown tables with aligned columns using Unicode box drawing.
 * Detects table blocks (lines starting with |) and replaces them with
 * aligned, box-drawn tables.
 */
function _renderMarkdownTables(text) {
  const lines = text.split('\n');
  const cols = _effectiveCols();

  // Pass 1: collect table blocks with positions
  const tableBlocks = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|.*\|/.test(lines[i])) {
      const tableLines = [];
      const startIdx = i;
      while (i < lines.length) {
        if (/^\s*\|.*\|/.test(lines[i])) {
          // Check if this is a new table header (has a separator next line)
          if (
            tableLines.length >= 2 &&
            i + 1 < lines.length &&
            /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)*\|$/.test(lines[i + 1]?.trim() || '')
          ) {
            break; // new table starts here, stop current block
          }
          tableLines.push(lines[i]);
          i++;
        } else if (
          lines[i].trim() === '' &&
          i + 1 < lines.length &&
          /^\s*\|.*\|/.test(lines[i + 1])
        ) {
          // Blank line followed by pipe-line: check if it's a new table (has separator after)
          if (
            i + 2 < lines.length &&
            /^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)*\|$/.test(lines[i + 2]?.trim() || '')
          ) {
            break; // blank + header + separator = new table
          }
          // Otherwise it's a blank inside current table (model artifact)
          i++;
        } else {
          break;
        }
      }
      if (tableLines.length >= 2) {
        tableBlocks.push({ lines: tableLines, startIdx, endIdx: i });
      }
    } else {
      i++;
    }
  }

  if (tableBlocks.length === 0) {
    return text;
  }

  // Pass 2: detect pairs
  const directives = _detectAdjacentTablePairs(tableBlocks, lines);

  // Pass 3: render — rebuild output from original lines + rendered tables
  const out = [];
  let lineIdx = 0;
  for (const dir of directives) {
    if (dir.type === 'pair') {
      // Emit non-table lines before the left table
      while (lineIdx < dir.left.startIdx) {
        out.push(lines[lineIdx++]);
      }
      // Skip all lines covered by the pair (left table + gap + right table)
      lineIdx = dir.right.endIdx;

      if (cols > 120) {
        out.push(_renderSideBySideTables(dir.left.lines, dir.right.lines, undefined, undefined));
      } else {
        // Narrow terminal: unified column widths if same column count
        const leftData = _parseTableData(dir.left.lines);
        const rightData = _parseTableData(dir.right.lines);
        if (leftData.colCount === rightData.colCount && leftData.colCount > 0) {
          const unified = [];
          for (let c = 0; c < leftData.colCount; c++) {
            unified.push(Math.max(leftData.colWidths[c], rightData.colWidths[c]));
          }
          out.push(_formatTable(dir.left.lines, { overrideWidths: unified }));
          if (dir.label) {
            out.push(dir.label);
          }
          out.push(_formatTable(dir.right.lines, { overrideWidths: unified }));
        } else {
          out.push(_formatTable(dir.left.lines));
          if (dir.label) {
            out.push(dir.label);
          }
          out.push(_formatTable(dir.right.lines));
        }
      }
    } else {
      // Single table
      while (lineIdx < dir.block.startIdx) {
        out.push(lines[lineIdx++]);
      }
      lineIdx = dir.block.endIdx;
      out.push(_formatTable(dir.block.lines));
    }
  }
  // Emit remaining lines after the last table
  while (lineIdx < lines.length) {
    out.push(lines[lineIdx++]);
  }

  return out.join('\n');
}

/**
 * Parse markdown table lines into structured data.
 * @param {string[]} tableLines - raw markdown pipe-delimited lines
 * @returns {{ rows: string[][], colCount: number, colWidths: number[] }}
 */
function _parseTableData(tableLines) {
  const rows = [];
  let alignments = [];
  for (let i = 0; i < tableLines.length; i++) {
    const line = tableLines[i].trim();
    if (/^\|[\s:]*[-]+[\s:]*(\|[\s:]*[-]+[\s:]*)*\|$/.test(line)) {
      // Separator row: derive per-column alignment from :--- / ---: / :---: markers.
      alignments = line
        .split('|')
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1)
        .map((spec) => {
          const s = spec.trim();
          const left = s.startsWith(':');
          const right = s.endsWith(':');
          if (left && right) {
            return 'center';
          }
          if (right) {
            return 'right';
          }
          if (left) {
            return 'left';
          }
          return 'left';
        });
      continue;
    }
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    rows.push(cells);
  }
  if (rows.length === 0) {
    return { rows: [], colCount: 0, colWidths: [], alignments: [] };
  }
  const colCount = maxOf(rows.map((r) => r.length));
  const colWidths = Array(colCount).fill(0);
  for (const row of rows) {
    for (let col = 0; col < colCount; col++) {
      const cell = row[col] || '';
      // Strip markdown formatting for accurate width calculation
      const plainCell = cell
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(italicStarRegex(process.env), '$1')
        .replace(/~~(?!~)(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
      colWidths[col] = Math.max(colWidths[col], displayWidth(plainCell));
    }
  }
  for (let col = 0; col < colCount; col++) {
    colWidths[col] = Math.max(colWidths[col], 3);
  }
  return { rows, colCount, colWidths, alignments };
}

/**
 * Pad a (possibly ANSI-styled) cell to a display width honoring alignment.
 * @param {string} formatted - cell content (may contain ANSI codes)
 * @param {number} width - target display width
 * @param {'left'|'center'|'right'} align
 */
function _padCellAligned(formatted, width, align) {
  const visibleW = displayWidth(stripAnsi(formatted));
  const total = Math.max(0, width - visibleW);
  if (align === 'right') {
    return ' '.repeat(total) + formatted;
  }
  if (align === 'center') {
    const leftPad = Math.floor(total / 2);
    return ' '.repeat(leftPad) + formatted + ' '.repeat(total - leftPad);
  }
  // Left (default): reuse padToWidth which is ANSI-aware.
  return padToWidth(formatted, width);
}

/**
 * Apply inline markdown formatting (bold, italic, inline code) to text.
 * Used to pre-format table cell content before width-padding.
 */
function _applyInlineFormatting(text) {
  return (
    text
      // Bold / bold-italic share the mdBold accent so table cells match body text.
      .replace(/\*\*\*(.+?)\*\*\*/g, (_m, t) => c().bold.italic.hex(_mdColor('mdBold'))(t))
      .replace(/\*\*(.+?)\*\*/g, (_m, t) => c().bold.hex(_mdColor('mdBold'))(t))
      .replace(italicStarRegex(process.env), (_m, t) => c().italic(t))
      .replace(/~~(?!~)(.+?)~~/g, (_m, t) => c().strikethrough(t))
      .replace(/`([^`]+)`/g, (_m, code) => c().cyan(code))
  );
}

/**
 * Render parsed table data into box-drawn lines (array).
 * Clamps total table width to terminal columns to prevent misalignment from line wrapping.
 * @param {{ rows: string[][], colCount: number, colWidths: number[] }} data
 * @returns {string[]}
 */
function _formatTableFromData(data) {
  const { rows, colCount, colWidths } = data;
  const alignments = data.alignments || [];
  if (rows.length === 0) {
    return [];
  }

  // Copy-clean process output: render tables border-less (aligned columns, no box
  // glyphs) so mid-turn narration text pastes cleanly. Gate KHY_PLAIN_PROCESS_TABLE
  // (default on); off → byte-identical legacy box-drawn table below.
  if (plainProcessTableEnabled()) {
    const _stripMdPlain = (cell) =>
      String(cell == null ? '' : cell)
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(italicStarRegex(process.env), '$1')
        .replace(/~~(?!~)(.+?)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
    const plain = renderPlainTable(
      { rows, colCount },
      {
        measure: displayWidth,
        stripMd: _stripMdPlain,
        format: _applyInlineFormatting,
        header: (s) => c().bold.cyan(s),
        dim: c().dim.bind(c()),
        indent: '  ',
      }
    );
    if (plain) {
      return plain;
    }
    // renderPlainTable returned null (anomalous data) → fall through to box table.
  }

  // Clamp table width to terminal: total = 2(indent) + 1(╭) + Σ(colW+2) + (colCount-1)(┬) + 1(╮)
  //   = 4 + Σ(colW+2) + colCount - 1 = 3 + colCount*3 + Σ(colW)
  const termCols = _effectiveCols();
  const overhead = 4 + colCount * 3; // "  ╭" + N*(│ + 2 padding) + separators + "╮"
  const maxContentWidth = Math.max(colCount * 3, termCols - overhead);
  const totalContentWidth = colWidths.reduce((a, b) => a + b, 0);

  if (totalContentWidth > maxContentWidth && maxContentWidth > 0) {
    // Proportionally shrink columns, minimum 3 chars each
    const scale = maxContentWidth / totalContentWidth;
    let remaining = maxContentWidth;
    for (let i = 0; i < colCount - 1; i++) {
      colWidths[i] = Math.max(3, Math.floor(colWidths[i] * scale));
      remaining -= colWidths[i];
    }
    colWidths[colCount - 1] = Math.max(3, remaining);
  }

  const result = [];
  const dim = c().dim.bind(c());
  // Strip markdown markers for width calc (shared by both render branches).
  const stripMd = (cell) =>
    cell
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(italicStarRegex(process.env), '$1')
      .replace(/~~(?!~)(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
  // CC parity (src/components/MarkdownTable.tsx): wrap overlong cells across
  // lines instead of truncating, so no cell content is silently dropped. Gate
  // KHY_TABLE_CELL_WRAP (default on); off → byte-identical legacy truncation.
  const wrapOn = tableCellWrapEnabled();
  // Header row is always left-aligned for readability; body honors the
  // separator-row alignment markers (default left).
  const styleCell = (formattedCell, col, isHeader) => {
    const align = isHeader ? 'left' : alignments[col] || 'left';
    const padded = _padCellAligned(formattedCell, colWidths[col], align);
    return ' ' + (isHeader ? c().bold.cyan(padded) : padded) + ' ';
  };
  result.push(dim('  ╭' + colWidths.map((w) => '─'.repeat(w + 2)).join('┬') + '╮'));
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const isHeader = r === 0 && rows.length > 1;
    if (!wrapOn) {
      // Legacy truncation branch — byte-identical to the pre-wrap renderer.
      const cells = [];
      for (let col = 0; col < colCount; col++) {
        let cell = row[col] || '';
        const plainCell = stripMd(cell);
        const plainWidth = displayWidth(plainCell);
        if (plainWidth > colWidths[col]) {
          cell = truncateToWidth(plainCell, colWidths[col]);
        }
        cells.push(styleCell(_applyInlineFormatting(cell), col, isHeader));
      }
      result.push(dim('  │') + cells.join(dim('│')) + dim('│'));
    } else {
      // Wrap branch: cells that fit keep their original markdown (single line,
      // identical to legacy); only overflowing cells wrap across physical lines.
      const perCell = [];
      let maxLines = 1;
      for (let col = 0; col < colCount; col++) {
        const original = row[col] || '';
        const plainCell = stripMd(original);
        if (displayWidth(plainCell) <= colWidths[col]) {
          perCell.push([original]);
        } else {
          const wrapped = wrapCellLines(plainCell, colWidths[col], displayWidth);
          perCell.push(wrapped);
          if (wrapped.length > maxLines) {
            maxLines = wrapped.length;
          }
        }
      }
      for (let li = 0; li < maxLines; li++) {
        const cells = [];
        for (let col = 0; col < colCount; col++) {
          const lineText = perCell[col][li] || '';
          cells.push(styleCell(_applyInlineFormatting(lineText), col, isHeader));
        }
        result.push(dim('  │') + cells.join(dim('│')) + dim('│'));
      }
    }
    if (r === 0 && rows.length > 1) {
      result.push(dim('  ├' + colWidths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤'));
    }
  }
  result.push(dim('  ╰' + colWidths.map((w) => '─'.repeat(w + 2)).join('┴') + '╯'));
  return result;
}

/**
 * Format a set of markdown table lines into an aligned box-drawn table.
 * @param {string[]} tableLines
 * @param {{ overrideWidths?: number[] }} [opts]
 * @returns {string}
 */
function _formatTable(tableLines, opts = {}) {
  const data = _parseTableData(tableLines);
  if (data.rows.length === 0) {
    return tableLines.join('\n');
  }
  if (opts.overrideWidths) {
    for (let i = 0; i < data.colWidths.length; i++) {
      data.colWidths[i] = Math.max(data.colWidths[i], opts.overrideWidths[i] || 0);
    }
  }
  return _formatTableFromData(data).join('\n');
}

/**
 * Render two tables side-by-side (when terminal is wide enough).
 * @param {string[]} leftTableLines
 * @param {string[]} rightTableLines
 * @param {string} [leftLabel]
 * @param {string} [rightLabel]
 * @returns {string}
 */
function _renderSideBySideTables(leftTableLines, rightTableLines, leftLabel, rightLabel) {
  const cols = _effectiveCols();
  const gap = '   ';
  const halfWidth = Math.floor((cols - 5) / 2);

  const leftData = _parseTableData(leftTableLines);
  const rightData = _parseTableData(rightTableLines);
  if (leftData.rows.length === 0 || rightData.rows.length === 0) {
    return _formatTable(leftTableLines) + '\n' + _formatTable(rightTableLines);
  }

  // Unify column widths if same column count
  if (leftData.colCount === rightData.colCount) {
    for (let i = 0; i < leftData.colCount; i++) {
      const unified = Math.max(leftData.colWidths[i], rightData.colWidths[i]);
      leftData.colWidths[i] = unified;
      rightData.colWidths[i] = unified;
    }
  }

  const leftLines = _formatTableFromData(leftData);
  const rightLines = _formatTableFromData(rightData);

  // Compute display width of the left table (from the first rendered line)
  const leftTableWidth = leftLines.length > 0 ? displayWidth(leftLines[0]) : 0;

  // Check if both tables fit side by side
  const rightTableWidth = rightLines.length > 0 ? displayWidth(rightLines[0]) : 0;
  if (leftTableWidth + 3 + rightTableWidth > cols) {
    // Fall back to vertical stacking
    return leftLines.join('\n') + '\n' + rightLines.join('\n');
  }

  const result = [];
  const dim = c().dim.bind(c());

  // Labels
  if (leftLabel || rightLabel) {
    const ll = leftLabel
      ? padToWidth('  ' + dim(leftLabel), leftTableWidth)
      : ' '.repeat(leftTableWidth);
    const rl = rightLabel ? '  ' + dim(rightLabel) : '';
    result.push(ll + gap + rl);
  }

  // Zip lines
  const maxRows = Math.max(leftLines.length, rightLines.length);
  const emptyLeft = ' '.repeat(leftTableWidth);
  for (let i = 0; i < maxRows; i++) {
    const left = i < leftLines.length ? padToWidth(leftLines[i], leftTableWidth) : emptyLeft;
    const right = i < rightLines.length ? rightLines[i] : '';
    result.push(left + gap + right);
  }

  return result.join('\n');
}

/**
 * Detect adjacent table pairs for side-by-side or unified-width rendering.
 * @param {Array<{ lines: string[], startIdx: number, endIdx: number }>} blocks
 * @param {string[]} allLines
 * @returns {Array<{ type: 'single'|'pair', block?: object, left?: object, right?: object, label?: string }>}
 */
function _detectAdjacentTablePairs(blocks, allLines) {
  if (blocks.length === 0) {
    return [];
  }
  const directives = [];
  let i = 0;
  while (i < blocks.length) {
    if (i + 1 < blocks.length) {
      const gap = allLines.slice(blocks[i].endIdx, blocks[i + 1].startIdx);
      const nonBlank = gap.filter((l) => l.trim() !== '');
      const isPair = nonBlank.length === 0;
      if (isPair) {
        const label = nonBlank.length === 1 ? nonBlank[0].trim() : undefined;
        directives.push({ type: 'pair', left: blocks[i], right: blocks[i + 1], label });
        i += 2;
        continue;
      }
    }
    directives.push({ type: 'single', block: blocks[i] });
    i++;
  }
  return directives;
}

module.exports = { renderMarkdownLite, renderMarkdownStreaming, _wrapRawToWidth };
