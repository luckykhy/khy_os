'use strict';

/**
 * referencesService.js — References (cross-directory codebase references),
 * opencode-aligned: a config table mapping alias → local dir or git repository,
 * injected into the system prompt so the agent knows what external resources
 * exist, plus `@alias/…` mention resolution and an external-directory boundary.
 *
 * Config sources (merged, project overrides user):
 *   - user   : <dataHome>/references.json   (same home as permissions.json)
 *   - project: <git-root>/.khy/references.json
 *
 * Schema (per alias):
 *   {
 *     "docs": { "path": "../product-docs", "description": "…", "hidden": false },
 *     "sdk":  { "repository": "owner/repo", "branch": "main", "description": "…" }
 *   }
 *
 * - `path` is resolved against the config file's own directory, so project
 *   references may point anywhere the user trusts.
 * - `repository` is lazily cloned on first use into <dataHome>/ref-cache/<alias>
 *   (shallow, default branch; `branch` overrides). Only `owner/repo` short
 *   format is accepted — no arbitrary URLs (defense against URL injection).
 *
 * Boundary rule (external_directory analogue): the agent may READ through
 * `@alias` mentions only what lives under a declared reference root or under
 * cwd. Everything else is outside the boundary and is NOT inlined by
 * resolveMentionAbs — the read goes through the normal permission pipeline.
 *
 * Design rules:
 *   - Pure leaf where possible; every fs/network failure is fail-soft.
 *   - Never throws from the public surface (returns '' / [] / null).
 *   - Gate KHY_REFERENCES (default on; only explicit 0/false/off/no disables).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env) {
  const v = (env || process.env || {}).KHY_REFERENCES;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/** Absolute paths of all config files (user + project), order = precedence. */
function getConfigPaths(cwd) {
  const { getDataHome } = require('../utils/dataHome');
  const paths = [];
  try {
    paths.push(path.join(getDataHome(), 'references.json'));
  } catch {
    /* dataHome unavailable */
  }
  try {
    const root = findGitRoot(cwd || process.cwd());
    if (root) {
      paths.push(path.join(root, '.khy', 'references.json'));
    } else {
      paths.push(path.join(cwd || process.cwd(), '.khy', 'references.json'));
    }
  } catch {
    /* no git root */
  }
  return paths;
}

function findGitRoot(from) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 4000,
    });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

function _readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a single ref entry against its config file directory.
 * Returns a normalized entry { alias, type:'path'|'repo', target, description,
 * hidden } where `target` is the final ABSOLUTE directory (local dir, or the
 * lazy-clone cache dir for repositories). Repositories are cloned lazily here
 * on first resolution (first-use cost only). Never throws.
 */
function _normalizeEntry(alias, raw, baseDir, cacheRoot) {
  const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!entry) {
    return null;
  }

  const description = String(entry.description || '');
  const hidden = entry.hidden === true;
  const branch = entry.branch ? String(entry.branch) : undefined;

  if (typeof entry.path === 'string' && entry.path.trim()) {
    const abs = path.resolve(baseDir, entry.path.trim());
    return { alias, type: 'path', target: abs, description, hidden, branch };
  }

  if (typeof entry.repository === 'string' && entry.repository.trim()) {
    const repo = entry.repository.trim();
    // Only `owner/repo` short format. Anything with a scheme, host, or extra
    // slashes is refused — defensive against URL/arg injection into git clone.
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return {
        alias,
        type: 'repo',
        target: null,
        description,
        hidden,
        branch,
        error: 'unsafe_repo',
      };
    }
    const target = path.join(cacheRoot, alias);
    return { alias, type: 'repo', target, repo, description, hidden, branch };
  }

  return null;
}

/**
 * Load and merge all references. Repositories are materialized lazily (only
 * when their entry is actually resolved), so a config with many repos costs
 * nothing at prompt-assembly time. Never throws.
 *
 * @param {string} [cwd]
 * @param {object} [opts] { env, _configPaths, _cacheRoot } test seams
 * @returns {Map<string, object>} alias → normalized entry
 */
function loadReferences(cwd, opts = {}) {
  const map = new Map();
  try {
    if (!isEnabled(opts.env)) {
      return map;
    }
    const base = cwd || process.cwd();
    const paths = Array.isArray(opts._configPaths) ? opts._configPaths : getConfigPaths(base);
    let cacheRoot;
    try {
      const { getDataHome } = require('../utils/dataHome');
      cacheRoot = path.join(getDataHome(), 'ref-cache');
    } catch {
      cacheRoot = path.join(os.homedir(), '.khy', 'ref-cache');
    }

    // Project-first so it can shadow user entries; user applied second but we
    // apply in precedence order and let later writes override earlier ones.
    // Order = user, then project → project overrides user on same alias.
    for (const filePath of paths) {
      const parsed = _readJsonSafe(filePath);
      if (!parsed) {
        continue;
      }
      const baseDir = path.dirname(filePath);
      for (const alias of Object.keys(parsed)) {
        const entry = _normalizeEntry(alias, parsed[alias], baseDir, cacheRoot);
        if (entry) {
          map.set(alias, entry);
        }
      }
    }
  } catch {
    /* fail-soft */
  }
  return map;
}

/** Single cached copy per process (config files rarely change mid-session). */
let _cacheCwd = null;
let _cacheMap = null;
function loadReferencesCached(cwd) {
  const base = cwd || process.cwd();
  if (_cacheCwd === base && _cacheMap) {
    return _cacheMap;
  }
  _cacheMap = loadReferences(base);
  _cacheCwd = base;
  return _cacheMap;
}

/** Clear the in-process cache (tests / config reload). */
function _clearCache() {
  _cacheCwd = null;
  _cacheMap = null;
}

/**
 * Ensure a repository-backed entry is materialized (lazy shallow clone).
 * Idempotent; cached in-process. Returns the target dir, or null on failure.
 * Never throws.
 */
function ensureRepository(entry) {
  if (!entry || entry.type !== 'repo') {
    return entry && entry.target ? entry.target : null;
  }
  if (!entry.repo) {
    return null;
  }
  try {
    if (fs.existsSync(path.join(entry.target, '.git'))) {
      return entry.target;
    }
    fs.mkdirSync(path.dirname(entry.target), { recursive: true });
    const args = ['clone', '--depth', '1'];
    if (entry.branch) {
      args.push('--branch', entry.branch);
    }
    args.push(`https://github.com/${entry.repo}.git`, entry.target);
    execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120000,
      windowsHide: true,
    });
    return entry.target;
  } catch {
    return null;
  }
}

/**
 * Build the system-prompt injection block listing all visible references.
 * Pure string assembly — repositories are NOT cloned here (lazy).
 *
 * @returns {string|null} null when no references are configured.
 */
function buildReferencesContext(cwd, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return null;
    }
    const refs = loadReferences(cwd || process.cwd(), opts);
    const lines = [];
    for (const [alias, entry] of refs) {
      if (entry.hidden) {
        continue;
      }
      const loc =
        entry.type === 'repo' ? `repository:${entry.repo || alias}` : `path:${entry.target}`;
      lines.push(`- @${alias} — ${entry.description ? entry.description + ' ' : ''}(${loc})`);
    }
    if (lines.length === 0) {
      return null;
    }
    return (
      `# References\n` +
      'The following external resources are available for reference. Use `@alias` to ' +
      'mention a file or directory from them (e.g. `@docs/README.md`), which injects ' +
      'its content into the conversation.\n' +
      lines.join('\n')
    );
  } catch {
    return null;
  }
}

/**
 * Resolve a `@alias/…` mention to an absolute path. Also verifies the target
 * stays inside the declared reference root (boundary). Returns null when the
 * alias is unknown, the entry is broken, or the sub-path escapes the root.
 *
 * @param {string} mention e.g. 'docs/README.md' or 'docs' (no leading @)
 * @param {string} [cwd]
 * @param {object} [opts] { env, _refs, _isUnderTrustedRoot } test seams
 * @returns {string|null} absolute path inside the reference root, or null
 */
function resolveMentionAbs(mention, cwd, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return null;
    }
    const text = String(mention || '');
    if (!text) {
      return null;
    }
    const [alias, ...rest] = text.split('/');
    if (!alias) {
      return null;
    }

    const refs = opts._refs || loadReferencesCached(cwd || process.cwd());
    const entry = refs.get(alias);
    if (!entry) {
      return null;
    }

    let root = entry.target;
    if (entry.type === 'repo') {
      root = ensureRepository(entry);
      if (!root) {
        return null;
      }
    }

    const target = rest.length > 0 ? path.resolve(root, ...rest) : root;

    // Boundary: the resolved target must stay INSIDE the declared root.
    const rel = path.relative(root, target);
    if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
      return target;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Boundary check for @-mention injection of an already-absolute path: allowed
 * when it lives under cwd, under a declared reference root, or under a trusted
 * user root (desktop/documents…). Anything else is outside the boundary and
 * the caller must NOT inline it. Pure, never throws.
 *
 * @param {string} absPath absolute path to be inlined via `@`
 * @param {string} [cwd]
 * @param {object} [opts] { env, _refs, _isUnderTrustedRoot } test seams
 * @returns {boolean}
 */
function isWithinBoundary(absPath, cwd, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return true;
    } // gate off → historical behavior
    const p = String(absPath || '');
    if (!p) {
      return false;
    }
    const base = cwd || process.cwd();

    const under = (root) => {
      try {
        const rel = path.relative(path.resolve(root), path.resolve(p));
        return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      } catch {
        return false;
      }
    };

    if (under(base)) {
      return true;
    }

    const refs = opts._refs || loadReferencesCached(base);
    for (const entry of refs.values()) {
      if (under(entry.target)) {
        return true;
      }
    }

    try {
      const isUnderTrustedRoot =
        opts._isUnderTrustedRoot || require('../tools/_userDirs').isUnderTrustedRoot;
      if (isUnderTrustedRoot(p)) {
        return true;
      }
    } catch {
      /* best-effort */
    }

    return false;
  } catch {
    return true; // fail-open on internal error keeps today's behavior
  }
}

/**
 * List visible reference aliases for the @-picker (classic + TUI).
 * @returns {Array<{name:string, display:string, isDir:boolean, isRef:boolean}>}
 */
function listRefEntries(cwd, opts = {}) {
  const out = [];
  try {
    if (!isEnabled(opts.env)) {
      return out;
    }
    for (const [alias, entry] of loadReferences(cwd || process.cwd(), opts)) {
      if (entry.hidden) {
        continue;
      }
      out.push({
        name: alias,
        display: `${alias}/`,
        isDir: true,
        isRef: true,
        desc:
          entry.description || (entry.type === 'repo' ? `repository:${entry.repo}` : 'reference'),
      });
    }
  } catch {
    /* fail-soft */
  }
  return out;
}

module.exports = {
  isEnabled,
  getConfigPaths,
  loadReferences,
  loadReferencesCached,
  ensureRepository,
  buildReferencesContext,
  resolveMentionAbs,
  isWithinBoundary,
  listRefEntries,
  findGitRoot,
  _clearCache,
};
