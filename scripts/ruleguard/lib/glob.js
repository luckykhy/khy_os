'use strict';

/**
 * glob.js — zero-dependency glob matching for rule `paths` globs.
 *
 * Supports the subset used by RULES-REGISTRY.json `paths` fields: `**`, `*`,
 * `?`, literal paths, and a leading `!` negation. No brace expansion and no
 * negation-after-match: patterns are a flat positive/negative list, positives
 * matching is required before a negative veto is consulted.
 *
 * Deliberately dependency-free: this repo gates its dependency footprint
 * (check-dependency-size.js), so a 40-line matcher beats adding picomatch.
 */

const REGEX_SPECIALS = '\\^$.|+()[]{}';

/**
 * Convert one glob pattern to an anchored RegExp over a slash-normalized path.
 * A trailing double-star matches zero or more directories, so `services/**`
 * matches both `services/a.js` and `services/backend/src/a.js`.
 */
function globToRegExp(pattern) {
  const raw = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (ch === '*') {
      if (raw[i + 1] === '*') {
        // `**` — optional trailing separator is folded into the match so that
        // `services/**` still matches `services/x.js` and not only nested paths.
        i += 1;
        if (raw[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      continue;
    }

    if (REGEX_SPECIALS.includes(ch)) {
      out += `\\${ch}`;
      continue;
    }

    out += ch;
  }

  return new RegExp(`^${out}$`);
}

/**
 * Compile a positive pattern list and a negative pattern list.
 * Returns { positive: RegExp[], negative: RegExp[] } where each RegExp is
 * already anchored and slash-normalized.
 */
function compileGlobs(patterns) {
  const positive = [];
  const negative = [];

  for (const raw of Array.isArray(patterns) ? patterns : []) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (text.startsWith('!')) {
      negative.push(globToRegExp(text.slice(1)));
    } else {
      positive.push(globToRegExp(text));
    }
  }

  return { positive, negative };
}

/**
 * Test one repo-relative path against a positive/negative glob pair.
 * A path matches when at least one positive glob matches and no negative glob
 * matches. An empty positive list never matches — callers must decide whether
 * that means "no scope declared" (skip) rather than "not in scope".
 */
function testPath(pathname, globs) {
  const normalized = String(pathname || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || !globs.positive.length) return false;
  if (!globs.positive.some((re) => re.test(normalized))) return false;
  return !globs.negative.some((re) => re.test(normalized));
}

/** Test a path against a raw pattern array (compile + test in one call). */
function matchesAny(patterns, pathname) {
  return testPath(pathname, compileGlobs(patterns));
}

/** Split a comma-separated scope string into individual glob tokens. */
function splitScope(scope) {
  return String(scope || '')
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = { globToRegExp, compileGlobs, testPath, matchesAny, splitScope };
