/**
 * Permission Rules — pattern-based allow/deny rule storage.
 *
 * Rules are matched against tool invocations. Each rule has:
 *   - toolName: exact match on the tool name
 *   - pattern: optional regex/glob to match against tool parameters
 *   - decision: 'allow' or 'deny'
 *   - scope: 'session' (cleared on restart) or 'persistent' (saved to disk)
 *
 * Deny rules take precedence over allow rules (fail-closed).
 *
 * Persistent rules are stored in ~/.khy/permission-rules.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ──────────────────────────────────────────────────────────

const RULES_FILE = path.join(os.homedir(), '.khy', 'permission-rules.json');

// ── State ──────────────────────────────────────────────────────────────

/**
 * Rule format:
 * {
 *   toolName: string,
 *   pattern: string|null,     // regex pattern to match against params
 *   decision: 'allow'|'deny',
 *   scope: 'session'|'persistent',
 *   createdAt: string,        // ISO timestamp
 * }
 */
let _rules = [];
let _loaded = false;

// ── Persistence ────────────────────────────────────────────────────────

function _ensureDir() {
  const dir = path.dirname(RULES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _load() {
  if (_loaded) return;
  _loaded = true;

  try {
    if (fs.existsSync(RULES_FILE)) {
      const data = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
      _rules = Array.isArray(data.rules) ? data.rules : [];
      // Restore only persistent rules (session rules are transient)
      _rules = _rules.filter(r => r.scope === 'persistent');
    }
  } catch {
    _rules = [];
  }
}

function _save() {
  try {
    _ensureDir();
    const persistent = _rules.filter(r => r.scope === 'persistent');
    fs.writeFileSync(RULES_FILE, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      rules: persistent,
    }, null, 2), 'utf-8');
  } catch {
    // Best effort
  }
}

// ── Rule management ────────────────────────────────────────────────────

/**
 * Add an always-allow rule for a tool.
 *
 * @param {string} toolName - Tool to allow
 * @param {string|null} [pattern] - Optional regex pattern to match against params
 * @param {object} [options]
 * @param {'session'|'persistent'} [options.scope='persistent']
 */
function addAlwaysAllow(toolName, pattern = null, options = {}) {
  _load();

  const scope = options.scope || 'persistent';
  const rule = {
    toolName,
    pattern: pattern || null,
    decision: 'allow',
    scope,
    createdAt: new Date().toISOString(),
  };

  // Remove existing rules for same tool+pattern to avoid duplicates
  _removeMatchingRule(toolName, pattern);
  _rules.push(rule);

  if (scope === 'persistent') _save();
}

/**
 * Add an always-deny rule for a tool.
 *
 * @param {string} toolName - Tool to deny
 * @param {string|null} [pattern] - Optional regex pattern to match against params
 * @param {object} [options]
 * @param {'session'|'persistent'} [options.scope='persistent']
 */
function addAlwaysDeny(toolName, pattern = null, options = {}) {
  _load();

  const scope = options.scope || 'persistent';
  const rule = {
    toolName,
    pattern: pattern || null,
    decision: 'deny',
    scope,
    createdAt: new Date().toISOString(),
  };

  _removeMatchingRule(toolName, pattern);
  _rules.push(rule);

  if (scope === 'persistent') _save();
}

/**
 * Remove a rule matching tool+pattern.
 * @param {string} toolName
 * @param {string|null} [pattern]
 * @returns {boolean} true if a rule was removed
 */
function removeRule(toolName, pattern = null) {
  _load();
  const removed = _removeMatchingRule(toolName, pattern);
  if (removed) _save();
  return removed;
}

function _removeMatchingRule(toolName, pattern) {
  const before = _rules.length;
  _rules = _rules.filter(r => {
    if (r.toolName !== toolName) return true;
    if (pattern === null && r.pattern === null) return false;
    if (pattern !== null && r.pattern !== null && r.pattern === pattern) return false;
    return true;
  });
  return _rules.length < before;
}

// ── Permission checking ────────────────────────────────────────────────

/**
 * Check whether a tool invocation matches any rule.
 *
 * @param {string} toolName - The tool being invoked
 * @param {object} [params] - Tool parameters
 * @returns {'allow'|'deny'|'ask'} Decision
 */
function checkPermission(toolName, params = {}) {
  _load();

  // Serialize params for pattern matching
  const paramStr = _serializeParams(params);

  // Deny rules take precedence (fail-closed)
  for (const rule of _rules) {
    if (rule.toolName !== toolName) continue;
    if (rule.decision !== 'deny') continue;

    if (_matchesPattern(rule.pattern, paramStr)) {
      return 'deny';
    }
  }

  // Then check allow rules
  for (const rule of _rules) {
    if (rule.toolName !== toolName) continue;
    if (rule.decision !== 'allow') continue;

    if (_matchesPattern(rule.pattern, paramStr)) {
      return 'allow';
    }
  }

  // No matching rule
  return 'ask';
}

/**
 * Match a rule pattern against serialized parameters.
 *
 * @param {string|null} pattern - Regex pattern string, or null for "match any"
 * @param {string} paramStr    - Serialized parameters
 * @returns {boolean}
 */
function _matchesPattern(pattern, paramStr) {
  // Null pattern matches everything for this tool
  if (pattern === null) return true;

  try {
    const re = new RegExp(pattern, 'i');
    return re.test(paramStr);
  } catch {
    // Invalid regex — treat as literal substring match
    return paramStr.includes(pattern);
  }
}

/**
 * Serialize tool params to a string for pattern matching.
 * @param {object} params
 * @returns {string}
 */
function _serializeParams(params) {
  if (!params || typeof params !== 'object') return '';

  // For bash tools, the command string is the primary match target
  if (params.command) return String(params.command);
  if (params.cmd) return String(params.cmd);

  // For file tools, the path is the primary match target
  if (params.file_path) return String(params.file_path);
  if (params.path) return String(params.path);

  // Fallback: JSON representation
  try {
    return JSON.stringify(params);
  } catch {
    return '';
  }
}

// ── Query ──────────────────────────────────────────────────────────────

/**
 * Get all rules.
 * @returns {Array<object>}
 */
function getAllRules() {
  _load();
  return [..._rules];
}

/**
 * Get rules for a specific tool.
 * @param {string} toolName
 * @returns {Array<object>}
 */
function getRulesForTool(toolName) {
  _load();
  return _rules.filter(r => r.toolName === toolName);
}

/**
 * Clear all rules.
 * @param {object} [options]
 * @param {boolean} [options.sessionOnly=false] - Only clear session rules
 */
function clearRules(options = {}) {
  _load();
  if (options.sessionOnly) {
    _rules = _rules.filter(r => r.scope === 'persistent');
  } else {
    _rules = [];
    _save();
  }
}

/**
 * Reset the module (for testing).
 */
function reset() {
  _rules = [];
  _loaded = false;
}

module.exports = {
  addAlwaysAllow,
  addAlwaysDeny,
  removeRule,
  checkPermission,
  getAllRules,
  getRulesForTool,
  clearRules,
  reset,
  RULES_FILE,
};
