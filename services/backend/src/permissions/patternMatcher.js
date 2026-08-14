/**
 * permissions/patternMatcher.js — pure-leaf pattern matching for permission
 * pattern rules (wildcard command prefixes like `npm run *`, param globs).
 *
 * Contract:
 *   - Pure functions only: zero IO, never touches the tool registry.
 *   - Glob compilation is DELEGATED to permissionPolicy/matchers.globToRegExp
 *     (single source of truth — no copied glob engine here).
 *   - Param serialization semantics are ALIGNED with the historical
 *     permissions/rules.js `_serializeParams` (command > cmd > file_path >
 *     path > JSON fallback) without requiring that orphan module.
 *   - Compiled RegExps are cached in a module-level Map bounded by
 *     KHY_PERMISSION_PATTERN_CACHE_CAP (flagRegistry numeric, default 256);
 *     when full, the OLDEST entry is evicted (Map insertion order).
 *   - Fail-closed: compound shell commands (&&, ||, |, ;, redirects,
 *     backticks, $( ), newlines, &) refuse prefix generalization → null.
 */
'use strict';

// Fail-soft fallback ONLY for when flagRegistry itself cannot be loaded;
// the authoritative default lives in flagRegistry (KHY_PERMISSION_PATTERN_CACHE_CAP).
const _FALLBACK_CACHE_CAP = 256;

// Shell metacharacters that make a command "compound" — pattern rules must
// never generalize across command boundaries (fail-closed).
const _COMPOUND_RE = /[|;&<>`\r\n]/;

// Leading environment assignment token, e.g. `FOO=1` in `FOO=1 npm test`.
const _ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Extract the simple command prefix from a shell command string.
 *
 * Skips leading env assignments (`FOO=1 npm test` → `npm test`). Any compound
 * structure (`&&`, `||`, `|`, `;`, `>`, `<`, backtick, `$(`, `&`, newline)
 * returns null — a pattern rule must never silently cover the second half of
 * a compound command (fail-closed).
 *
 * @param {string} command
 * @returns {string|null} normalized simple command, or null when unsafe/empty
 */
function extractCommandPrefix(command) {
  if (typeof command !== 'string') {
    return null;
  }
  const text = command.trim();
  if (!text) {
    return null;
  }
  if (_COMPOUND_RE.test(text) || text.includes('$(')) {
    return null;
  }

  const tokens = text.split(/\s+/);
  let i = 0;
  while (i < tokens.length && _ENV_ASSIGN_RE.test(tokens[i])) {
    i++;
  }
  if (i >= tokens.length) {
    return null;
  } // only env assignments — no command
  return tokens.slice(i).join(' ');
}

/**
 * Serialize tool params for pattern matching. Semantics aligned with the
 * historical permissions/rules.js `_serializeParams` priority:
 * command > cmd > file_path > path > JSON fallback.
 *
 * @param {object} params
 * @returns {string}
 */
function _serializeParams(params) {
  if (!params || typeof params !== 'object') {
    return '';
  }
  if (params.command) {
    return String(params.command);
  }
  if (params.cmd) {
    return String(params.cmd);
  }
  if (params.file_path) {
    return String(params.file_path);
  }
  if (params.path) {
    return String(params.path);
  }
  try {
    return JSON.stringify(params);
  } catch {
    return '';
  }
}

// ── Compiled-RegExp cache (bounded, oldest-evicted) ─────────────────────

const _regexCache = new Map(); // pattern → RegExp (insertion order = age)

function _cacheCap() {
  try {
    const { resolveNumeric } = require('../services/flagRegistry');
    const cap = resolveNumeric('KHY_PERMISSION_PATTERN_CACHE_CAP');
    return cap > 0 ? cap : _FALLBACK_CACHE_CAP;
  } catch {
    return _FALLBACK_CACHE_CAP;
  }
}

/**
 * Compile a glob pattern to a RegExp via permissionPolicy/matchers
 * globToRegExp (reused, not copied), memoized in the bounded cache.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function _compilePattern(pattern) {
  const cached = _regexCache.get(pattern);
  if (cached) {
    return cached;
  }

  const { globToRegExp } = require('../services/permissionPolicy/matchers');
  const re = globToRegExp(pattern);

  const cap = _cacheCap();
  while (_regexCache.size >= cap) {
    const oldest = _regexCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    _regexCache.delete(oldest);
  }
  _regexCache.set(pattern, re);
  return re;
}

/**
 * Match a pattern rule against a tool call. Three forms:
 *   (a) exact tool name — rule has no pattern (null/empty) → tool name match.
 *   (b) toolName + command-prefix glob — params carry command/cmd; the simple
 *       prefix is extracted first (compound commands → no match, fail-closed)
 *       then glob-matched against the pattern (e.g. `npm run *`).
 *   (c) toolName + param glob — non-command params (file_path/path/JSON)
 *       glob-matched against the pattern.
 *
 * @param {{toolName:string, pattern?:string|null}} rule
 * @param {string} toolName
 * @param {object} [params]
 * @returns {boolean} true when the rule matches this call
 */
function matchPatternRule(rule, toolName, params) {
  try {
    if (!rule || typeof rule !== 'object') {
      return false;
    }
    if (String(rule.toolName || '') !== String(toolName || '')) {
      return false;
    }
    if (!rule.toolName) {
      return false;
    }

    const pattern = rule.pattern;
    if (pattern == null || String(pattern).trim() === '') {
      return true; // form (a): exact tool-name rule
    }

    const serialized = _serializeParams(params);
    const isCommandCall = !!(params && (params.command || params.cmd));

    if (isCommandCall) {
      // form (b): extract simple prefix first — compound commands never match
      const prefix = extractCommandPrefix(serialized);
      if (prefix === null) {
        return false;
      }
      return _compilePattern(String(pattern)).test(prefix);
    }

    // form (c): glob against serialized non-command params
    if (!serialized) {
      return false;
    }
    return _compilePattern(String(pattern)).test(serialized);
  } catch {
    return false; // fail-closed: any matcher error → no match
  }
}

module.exports = {
  extractCommandPrefix,
  matchPatternRule,
  // internals exported for tests only
  _serializeParams,
  _compilePattern,
  _regexCache,
};
