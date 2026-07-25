/**
 * permissionPolicy/matchers.js — pure matching + classification helpers used by
 * the policy evaluator. Dependency-free (no minimatch): the glob engine is a
 * small, well-scoped translator that covers the patterns a permission whitelist
 * actually needs (`*`, `**`, `?`, literal segments).
 */
'use strict';

const path = require('path');

// ── Tool → category classification ─────────────────────────────────────
//
// Categories: 'fileRead' | 'fileWrite' | 'fileDelete' | 'network' |
//             'codeExec' | 'shell' | 'git' | 'other'.
//
// Names cover both the CC-aligned canonical tool names (Read/Write/Edit/...)
// and the legacy khy names (readFile/writeFile/...) plus their lowercased
// normalized forms, so classification is robust regardless of which surface
// the call arrives on.

const CATEGORY_BY_TOOL = new Map();
function _reg(category, names) {
  for (const n of names) CATEGORY_BY_TOOL.set(_norm(n), category);
}
_reg('fileRead', ['Read', 'readFile', 'read_file', 'cat', 'FileReadTool', 'NotebookRead']);
_reg('fileWrite', [
  'Write', 'writeFile', 'write_file', 'create_file', 'FileWriteTool',
  'Edit', 'editFile', 'edit_file', 'MultiEdit', 'FileEditTool', 'MultiEditTool',
  'apply_patch', 'applyPatch', 'ApplyPatchTool', 'NotebookEdit',
]);
_reg('fileDelete', ['deleteFile', 'delete_file', 'rm', 'removeFile']);
_reg('network', ['WebFetch', 'webFetch', 'dataFetch', 'WebSearch', 'webSearch', 'fetch', 'http_request']);
_reg('codeExec', ['executeCode', 'execute_code', 'REPL', 'repl', 'eval', 'runCode', 'run_code']);
_reg('shell', ['shellCommand', 'shell_command', 'bash', 'Bash', 'sh', 'PowerShell', 'PowerShellTool', 'exec']);
_reg('git', ['gitCommit', 'gitStatus', 'gitDiff', 'gitPush', 'git']);

function _norm(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Classify a tool call into a coarse permission category. Prefers an explicit
 * registry hint (category/isReadOnly/isDestructive) when supplied by the
 * caller, then falls back to the static name map, then to params shape.
 *
 * @param {string} toolName
 * @param {object} [params]
 * @param {object} [hint] - { category, isReadOnly, isDestructive } from the registry
 * @returns {string} category
 */
function detectCategory(toolName, params = {}, hint = {}) {
  const mapped = CATEGORY_BY_TOOL.get(_norm(toolName));
  if (mapped) {
    // A shell call that only reads is still gated as 'shell' (the command
    // whitelist is the right lever there), so we keep the name-based mapping.
    return mapped;
  }

  // Registry-driven fallback for tools not in the static map.
  const cat = String(hint.category || '').toLowerCase();
  if (cat === 'git') return 'git';
  if (cat === 'execution') return params && (params.command || params.cmd) ? 'shell' : 'codeExec';
  if (cat === 'data') return 'network';
  if (cat === 'filesystem') {
    if (hint.isReadOnly === true) return 'fileRead';
    if (hint.isDestructive === true) return 'fileDelete';
    return 'fileWrite';
  }

  // Param-shape heuristics as a last resort.
  if (params && (params.url || params.urls)) return 'network';
  if (params && (params.command || params.cmd)) return 'shell';
  if (params && params.code && (params.language || params.lang)) return 'codeExec';
  if (params && (params.file_path || params.path || params.filePath)) {
    return hint.isReadOnly === true ? 'fileRead' : 'fileWrite';
  }
  return 'other';
}

/** Extract the filesystem path a tool call targets, if any. */
function extractPath(params = {}) {
  return params.file_path || params.filePath || params.path || params.target || null;
}

/** Extract the URL a network tool call targets, if any. */
function extractUrl(params = {}) {
  return params.url || (Array.isArray(params.urls) ? params.urls[0] : null) || params.endpoint || null;
}

/** Extract the language for a code-execution call. */
function extractLanguage(params = {}) {
  return String(params.language || params.lang || '').trim().toLowerCase() || null;
}

/** Extract the shell command text, if any. */
function extractCommand(params = {}) {
  return params.command || params.cmd || params.script || null;
}

// ── Glob matching ───────────────────────────────────────────────────────

/**
 * Translate a glob pattern into a RegExp.
 *   `**` matches across path separators, `*` matches within a segment,
 *   `?` matches a single non-separator char. All other chars are literal.
 * The match is anchored (full-string).
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  const g = String(glob || '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**` → any chars including separators
        i++;
        if (g[i + 1] === '/') {
          // `**/` form: 门控 KHY_GLOB_DOUBLESTAR_ANCHOR(默认开)发出锚定的可选前缀
          // `(?:.*[/\\])?`,使 `**/id_rsa` 匹配任意目录下的 id_rsa(及 id_rsa 自身),但
          // 不再误匹配 `backup_id_rsa`。门关/异常 → legacy `.*` + 吞斜杠(逐字节回退)。
          let frag = null;
          try { frag = require('../globDoublestarAnchor').doublestarSlashFragment(process.env); } catch { frag = null; }
          if (frag != null) {
            re += frag;
            i++; // 吞掉斜杠(片段已含分隔符语义)
          } else {
            re += '.*';
            i++; // swallow a trailing slash so `**/x` also matches `x`(legacy)
          }
        } else {
          re += '.*';
        }
      } else {
        re += '[^/\\\\]*';
      }
    } else if (c === '?') {
      re += '[^/\\\\]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else if (c === '/') {
      re += '[/\\\\]';
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Expand a leading `~` to the user home for path-glob comparison. */
function _expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) {
    return path.join(require('os').homedir(), p.slice(1));
  }
  return p;
}

/**
 * True when `targetPath` matches any glob in `patterns`. Both sides are
 * normalized (home-expanded, resolved) so relative/absolute forms compare
 * sanely. Empty pattern list ⇒ false (no whitelist configured).
 *
 * @param {string} targetPath
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchPath(targetPath, patterns) {
  if (!targetPath || !Array.isArray(patterns) || patterns.length === 0) return false;
  let abs;
  try {
    abs = path.resolve(_expandHome(targetPath));
  } catch {
    abs = String(targetPath);
  }
  const candidates = new Set([String(targetPath), abs, abs.replace(/\\/g, '/')]);
  for (const pat of patterns) {
    const expanded = _expandHome(pat);
    let absPat;
    try { absPat = path.resolve(expanded); } catch { absPat = String(expanded); }
    const reList = [
      globToRegExp(String(pat)),
      globToRegExp(String(expanded)),
      globToRegExp(absPat),
      globToRegExp(absPat.replace(/\\/g, '/')),
    ];
    for (const cand of candidates) {
      for (const re of reList) {
        if (re.test(cand)) return true;
      }
    }
  }
  return false;
}

/**
 * True when `url` matches any pattern in `patterns`. A bare-domain pattern
 * ("*.github.com" or "github.com") matches by hostname; a pattern containing
 * "://" or "/" is treated as a full URL glob.
 *
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchUrl(url, patterns) {
  if (!url || !Array.isArray(patterns) || patterns.length === 0) return false;
  let host = '';
  try {
    host = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
  } catch {
    host = '';
  }
  for (const pat of patterns) {
    const p = String(pat || '').trim();
    if (!p) continue;
    const isUrlGlob = p.includes('://') || p.includes('/');
    if (isUrlGlob) {
      if (globToRegExp(p).test(url)) return true;
    } else if (host) {
      // Domain pattern: match the host, and let "*.x.com" also cover "x.com".
      if (globToRegExp(p).test(host)) return true;
      if (p.startsWith('*.') && (host === p.slice(2) || globToRegExp(p.slice(2)).test(host))) return true;
    }
  }
  return false;
}

/**
 * True when a tool call matches a configured sensitive-operation pattern.
 * Patterns are matched as case-insensitive substrings against the command
 * text (for shell) or "<toolName> <serialized params>" otherwise.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {string[]} patterns
 * @returns {boolean}
 */
function isSensitiveOperation(toolName, params, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  const command = extractCommand(params);
  let haystack = command ? String(command) : '';
  if (!haystack) {
    try { haystack = `${toolName} ${JSON.stringify(params || {})}`; } catch { haystack = String(toolName); }
  }
  const lower = haystack.toLowerCase();
  return patterns.some((p) => p && lower.includes(String(p).toLowerCase()));
}

module.exports = {
  detectCategory,
  extractPath,
  extractUrl,
  extractLanguage,
  extractCommand,
  globToRegExp,
  matchPath,
  matchUrl,
  isSensitiveOperation,
};
