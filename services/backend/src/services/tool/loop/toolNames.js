'use strict';

/**
 * loop/toolNames.js — tool-name canonicalization + per-request memoized name
 * sets (extracted verbatim from toolUseLoopCore.js as slice 4 of the `loop/`
 * phase decomposition; fulfils the "工具名 memo helper 族" carve).
 *
 * Two bounded, order/dup-independent memo caches used to be rebuilt every model
 * round inside runToolUseLoop's hot path; both are pure functions of the enabled
 * tool-name set (plus module-frozen constants), so they are memoized here:
 *   - known-name set   → ToolLoopDetector.registerTools (array)
 *   - enabled-name set → capability gate membership probe (Set)
 * Each falls back to a fresh build when its KHY_*_MEMO flag is off, and clears
 * wholesale at CAP (never unbounded growth).
 *
 * One core-local constant is consumed here — NATURAL_ACTION_TO_TOOL (the frozen
 * natural-language-action → canonical-tool map). It is injected once at core load
 * via setToolNamesDeps to avoid a require cycle back into the core (same pattern
 * as loop/steering). Everything else is an external sibling/util required directly.
 */

const _normalizeToolKey = require('../../../utils/normalizeAlnumKey');
const { normalizeToolCall } = require('../../claudeCompat');

// Injected at core load; defensive empty object so an un-injected require never
// throws (Object.values({}) === []).
let NATURAL_ACTION_TO_TOOL = {};
function setToolNamesDeps(deps) {
  if (deps && deps.NATURAL_ACTION_TO_TOOL) {
    NATURAL_ACTION_TO_TOOL = deps.NATURAL_ACTION_TO_TOOL;
  }
}

function _expandToolNameVariants(name = '') {
  const raw = String(name || '').trim();
  if (!raw) {
    return [];
  }
  const variants = new Set();
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) {
      return;
    }
    variants.add(text);
    variants.add(text.toLowerCase());
    variants.add(_normalizeToolKey(text));
  };

  push(raw);
  push(raw.replace(/[\s-]+/g, '_'));
  push(raw.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
  push(raw.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));

  try {
    const normalized = normalizeToolCall(raw, {});
    if (normalized?.name) {
      push(normalized.name);
    }
  } catch {
    /* best effort */
  }

  return [...variants].filter(Boolean);
}

// ── Known-tool-name set memo (Ch2 "don't rebuild a reusable structure each round")
const _knownNameCache = new Map();
const _KNOWN_NAME_CACHE_CAP = 16;
function _isKnownNameMemoEnabled() {
  const v = String(process.env.KHY_TOOL_KNOWN_NAME_SET_MEMO || '')
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// Build the deduped known-name array from an enabled-tools Map/object. Pure:
// depends only on tool names + aliases + module-frozen constants.
function _computeKnownToolNames(allTools) {
  const knownNameSet = new Set();
  const registerName = (name) => {
    for (const v of _expandToolNameVariants(name)) {
      knownNameSet.add(v);
    }
  };
  const names = allTools instanceof Map ? [...allTools.keys()] : Object.keys(allTools);
  for (const name of names) {
    registerName(name);
  }
  for (const tool of allTools instanceof Map ? allTools.values() : Object.values(allTools)) {
    if (tool.aliases && Array.isArray(tool.aliases)) {
      for (const alias of tool.aliases) {
        registerName(alias);
      }
    }
  }
  for (const mappedName of Object.values(NATURAL_ACTION_TO_TOOL)) {
    registerName(mappedName);
  }
  for (const common of [
    'shellCommand',
    'shell_command',
    'bash',
    'powershell',
    'cmd',
    'pwsh',
    'writeFile',
    'write_file',
    'readFile',
    'read_file',
    'editFile',
    'edit_file',
    'open_app',
    'openApp',
  ]) {
    registerName(common);
  }
  return [...knownNameSet];
}

// Order/dup-independent canonical key over the enabled tool NAMES (aliases are a
// deterministic property of each frozen tool, so names alone identify the result).
function _knownNameCacheKey(allTools) {
  const names = allTools instanceof Map ? [...allTools.keys()] : Object.keys(allTools);
  return [...new Set(names)].sort().join(' ');
}

function _resolveKnownToolNames(allTools) {
  if (!_isKnownNameMemoEnabled()) {
    return _computeKnownToolNames(allTools);
  }
  const key = _knownNameCacheKey(allTools);
  if (_knownNameCache.has(key)) {
    return _knownNameCache.get(key);
  }
  const built = _computeKnownToolNames(allTools);
  if (_knownNameCache.size >= _KNOWN_NAME_CACHE_CAP) {
    _knownNameCache.clear();
  }
  _knownNameCache.set(key, built);
  return built;
}

// ── Enabled-tool-name-set memo (capability gate) ─────────────────────────────
const _enabledNameSetCache = new Map();
const _ENABLED_NAME_SET_CACHE_CAP = 16;
function _isEnabledNameSetMemoEnabled() {
  const v = String(process.env.KHY_TOOL_ENABLED_NAME_SET_MEMO || '')
    .trim()
    .toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// Build the enabled-tool name Set from an enabled-tools Map/object. Pure: depends
// only on tool names + aliases expanded through _expandToolNameVariants.
function _buildEnabledToolNameSet(enabled) {
  const out = new Set();
  const registerName = (name) => {
    for (const v of _expandToolNameVariants(name)) {
      out.add(v);
    }
  };
  if (!enabled) {
    return out;
  }

  const names = enabled instanceof Map ? [...enabled.keys()] : Object.keys(enabled);
  for (const name of names) {
    registerName(name);
  }

  const defs = enabled instanceof Map ? [...enabled.values()] : Object.values(enabled);
  for (const tool of defs) {
    if (Array.isArray(tool?.aliases)) {
      for (const alias of tool.aliases) {
        registerName(alias);
      }
    }
  }
  return out;
}

// Order/dup-independent canonical key over the enabled tool NAMES (aliases are a
// deterministic property of each frozen tool, so names alone identify the result).
function _enabledNameSetCacheKey(enabled) {
  const names = enabled instanceof Map ? [...enabled.keys()] : Object.keys(enabled);
  return [...new Set(names)].sort().join(' ');
}

function _collectEnabledToolNameSet() {
  let enabled;
  try {
    const toolRegistry = require('../../../tools');
    enabled = toolRegistry.getEnabled ? toolRegistry.getEnabled() : toolRegistry.getAll?.();
  } catch {
    /* best effort */ return new Set();
  }

  if (!enabled) {
    return new Set();
  }
  if (!_isEnabledNameSetMemoEnabled()) {
    return _buildEnabledToolNameSet(enabled);
  }

  const key = _enabledNameSetCacheKey(enabled);
  if (_enabledNameSetCache.has(key)) {
    return _enabledNameSetCache.get(key);
  }
  const built = _buildEnabledToolNameSet(enabled);
  if (_enabledNameSetCache.size >= _ENABLED_NAME_SET_CACHE_CAP) {
    _enabledNameSetCache.clear();
  }
  _enabledNameSetCache.set(key, built);
  return built;
}

// Test observability (were inline closures over the caches in the core).
function _knownNameMemoSize() {
  return _knownNameCache.size;
}
function _resetKnownNameMemo() {
  _knownNameCache.clear();
}
function _enabledNameSetMemoSize() {
  return _enabledNameSetCache.size;
}
function _resetEnabledNameSetMemo() {
  _enabledNameSetCache.clear();
}

module.exports = {
  setToolNamesDeps,
  _expandToolNameVariants,
  _computeKnownToolNames,
  _knownNameCacheKey,
  _resolveKnownToolNames,
  _buildEnabledToolNameSet,
  _enabledNameSetCacheKey,
  _collectEnabledToolNameSet,
  _knownNameMemoSize,
  _resetKnownNameMemo,
  _enabledNameSetMemoSize,
  _resetEnabledNameSetMemo,
};
