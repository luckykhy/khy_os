/**
 * permissionPolicy/config.js — load / save / scaffold the fine-grained
 * permission policy stored at `<dataHome>/permissions.json` (i.e. ~/.khy/permissions.json).
 *
 * This file is a SEPARATE namespace from the legacy profile-based
 * `~/.khyquant/permissions.json` (permissionStore). The policy here is the
 * config-driven, category + whitelist model required by the enterprise
 * permission middleware:
 *
 *   - global default strategy: auto | confirm | deny
 *   - per-tool overrides
 *   - filesystem path whitelist (glob), split read/write/delete
 *   - network URL/domain whitelist (glob)
 *   - code-execution allowed languages + resource limits
 *   - sensitive operations that always force confirmation
 *
 * Design rules honored:
 *   - Zero hardcoded home dir: the file path is resolved via utils/dataHome.
 *   - Absent file ⇒ no policy ⇒ middleware is a strict no-op (existing behavior
 *     is 100% unchanged until the user opts in by writing this file).
 *   - Reads never throw: a malformed file degrades to "no policy", fail-closed
 *     at the evaluation layer (which only ever ADDS protection).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STRATEGIES = ['auto', 'confirm', 'deny'];

/**
 * Canonical default policy. Mirrors the documented schema. A freshly
 * scaffolded file is intentionally conservative: defaultPolicy = 'confirm'
 * so nothing is silently auto-run, and the whitelists start empty.
 */
function defaultPolicy() {
  return {
    version: 1,
    // Global default applied when no per-tool / per-category rule matches.
    defaultPolicy: 'confirm',
    // Per-tool overrides keyed by tool name (canonical or alias, e.g. "Read",
    // "Write", "shellCommand"). Value is one of STRATEGIES.
    tools: {},
    // Filesystem path whitelists (glob). `pathWhitelist` applies to all file
    // operations; the read/write/delete lists further restrict by verb.
    filesystem: {
      pathWhitelist: [],
      readWhitelist: [],
      writeWhitelist: [],
      deleteWhitelist: [],
    },
    // Network access: only URLs/domains matching a whitelist glob are allowed
    // under 'auto'. Patterns may be bare domains ("*.github.com") or full URL
    // globs ("https://api.example.com/*").
    network: {
      urlWhitelist: [],
    },
    // Code execution: when allowedLanguages is non-empty, only those languages
    // may run; everything else is denied. limits are advisory caps surfaced to
    // the executor (0 = no extra limit imposed by policy).
    codeExecution: {
      allowedLanguages: [],
      limits: { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 },
    },
    // Sensitive operations: any tool/command matching one of these substrings
    // is forced to at least 'confirm' (二次确认), regardless of defaultPolicy.
    sensitiveOperations: {
      requireConfirm: [
        'git push',
        'git reset --hard',
        'deploy',
        'rm -rf',
        'drop table',
        '批量删除',
      ],
    },
  };
}

/** Absolute path to the policy file (resolved via the data-home resolver). */
function getPolicyPath() {
  // Resolve under the modern data home (~/.khy by default, or KHY_DATA_HOME /
  // the .location.json pointer). getDataHome() does not create stray dirs.
  const { getDataHome } = require('../../utils/dataHome');
  return path.join(getDataHome(), 'permissions.json');
}

/** True when a policy file exists on disk. */
function policyExists() {
  try {
    return fs.existsSync(getPolicyPath());
  } catch {
    return false;
  }
}

/**
 * Load the policy from disk, deep-merged onto the defaults so a partial file
 * is always complete. Returns null when no file exists (⇒ middleware no-op) or
 * when the file is unreadable/invalid (fail-closed: the evaluator treats null
 * as "do not relax anything").
 *
 * @returns {object|null}
 */
function loadPolicy() {
  if (!policyExists()) return null;
  try {
    const raw = fs.readFileSync(getPolicyPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return _merge(defaultPolicy(), parsed);
  } catch {
    return null;
  }
}

/**
 * Persist a policy object to disk (pretty-printed). Creates the parent
 * directory if needed. Returns { success, path } or { success:false, error }.
 *
 * @param {object} policy
 */
function savePolicy(policy) {
  try {
    const file = getPolicyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const merged = _merge(defaultPolicy(), policy && typeof policy === 'object' ? policy : {});
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    return { success: true, path: file };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Ensure a policy file exists, scaffolding the conservative default if absent.
 * Returns the loaded (possibly just-created) policy.
 *
 * @returns {object}
 */
function ensurePolicy() {
  if (!policyExists()) {
    savePolicy(defaultPolicy());
  }
  return loadPolicy() || defaultPolicy();
}

/** Normalize a strategy string; returns null when not a valid strategy. */
function normalizeStrategy(value) {
  const v = String(value || '').trim().toLowerCase();
  return STRATEGIES.includes(v) ? v : null;
}

// ── internal ───────────────────────────────────────────────────────────

/**
 * Shallow-typed deep merge: objects merge recursively, arrays and scalars from
 * `override` replace `base` wholesale (matching the khySettings convention).
 */
function _merge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = _merge(base[key], override[key]);
    }
    return out;
  }
  return override !== undefined ? override : base;
}

module.exports = {
  STRATEGIES,
  defaultPolicy,
  getPolicyPath,
  policyExists,
  loadPolicy,
  savePolicy,
  ensurePolicy,
  normalizeStrategy,
  _merge,
};
