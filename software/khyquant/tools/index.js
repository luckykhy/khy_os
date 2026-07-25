/**
 * Tool Registry — auto-discovery and management of all tools.
 *
 * Loads tool definitions from this directory and bridges with the legacy
 * BUILTIN_TOOLS array in toolCalling.js for backward compatibility.
 *
 * Discovery order:
 *   1. Subdirectory-based tools (e.g. FileReadTool/index.js) — BaseTool classes
 *   2. Flat .js files in this directory (e.g. quote.js) — defineTool() format
 *   3. Legacy BUILTIN_TOOLS from toolCalling.js
 *
 * Subdirectory tools take priority: if both FileReadTool/index.js and
 * readFile.js define a tool with the same name, the subdirectory version wins.
 *
 * Usage:
 *   const tools = require('./tools');
 *   tools.getAll()           // → Map<name, tool>
 *   tools.get('quote')       // → tool definition
 *   tools.getDefinitions()   // → function-calling format array
 *   await tools.execute('quote', { symbol: 'sh600519' })
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { defineTool, validateParams, BaseTool } = require('./_baseTool');
const { filterToolsByProfile, getProfileTools, listProfiles } = require('./toolProfile');

// ── Registry state ──────────────────────────────────────────────────

let _tools = new Map();    // name → tool definition
let _mcpTools = new Map(); // name → MCP tool definition (tracked separately)
let _loaded = false;
let _denyRules = null;     // cached deny rules

// ── getAll() memoization (Ch2「不要每轮重建可复用结构」) ─────────────
// getAll() merges _tools ⊎ _mcpTools into a fresh ~200-entry Map on every
// call, yet the registry mutates only at register/clearMcpTools/reload (the
// full loadTools population happens once, before the first getAll). Memoize
// the merged base Map behind a monotonic version counter that every mutation
// bumps; the cache is returned only when the version is unchanged.
// INVARIANT: every consumer of getAll() treats the Map as READ-ONLY (audited:
// capabilityRegistry/metaToolEngine/toolCalling/toolUseLoop/toolSearch all
// only iterate/get). Downstream profile/deferral filters build their own new
// Maps, so the shared cached Map is never mutated. Gate off → legacy rebuild.
let _toolsVersion = 0;       // bumps on every registry mutation
let _getAllCache = null;     // memoized merged base Map
let _getAllCacheVersion = -1;

/** Bump the registry version so the next getAll() rebuilds its cache. */
function _bumpToolsVersion() {
  _toolsVersion++;
  _getAllCache = null;
}

/**
 * Whether getAll() memoization is enabled (default-on gate KHY_TOOL_REGISTRY_MEMO).
 * `=0/off/false/no` → byte-identical legacy rebuild on every call.
 */
function _isRegistryMemoEnabled() {
  const v = String(process.env.KHY_TOOL_REGISTRY_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// ── Deferred loading session state ─────────────────────────────────
let _revealedDeferred = new Set();   // mid-session revealed tool names
let _inflightReveals = new Map();    // name → Promise (concurrent dedup)
let _deferralEnabled = (process.env.KHY_DEFER_TOOLS !== '0'); // default: enabled
// Monotonic fingerprint of the revealed-deferred set. Reveal/reset mutate the
// Set membership WITHOUT bumping _toolsVersion, so assembleToolPool()'s deferral
// filter depends on this counter to know when its memoized pool went stale.
// A counter (not size) is required: two distinct reveal sets can share a size.
let _revealVersion = 0;

// ── Auto-discovery ──────────────────────────────────────────────────

/**
 * Load all tool files from this directory and subdirectories.
 *
 * Phase 1: Load subdirectory tools (FooTool/index.js) — BaseTool classes
 * Phase 2: Load flat .js files (foo.js) — defineTool() format
 * Phase 3: Bridge legacy BUILTIN_TOOLS from toolCalling.js
 *
 * Files/dirs starting with _ or named index.js are excluded.
 */
function loadTools() {
  if (_loaded) return;
  _loaded = true;

  // ── Phase 1: Load subdirectory-based tools (BaseTool classes) ───
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });
    const dirs = entries.filter(e =>
      e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.')
    );

    for (const dir of dirs) {
      const indexPath = path.join(__dirname, dir.name, 'index.js');
      if (!fs.existsSync(indexPath)) continue;

      try {
        const exported = require(indexPath);

        // Case 1: exported object is already a frozen defineTool() result
        if (exported && exported.name && typeof exported.execute === 'function' && typeof exported.toFunctionDef === 'function') {
          _tools.set(exported.name, exported);
          continue;
        }

        // Case 2: exported is a BaseTool instance — convert to defineTool format
        if (exported && exported instanceof BaseTool) {
          const toolDef = exported.toToolDef();
          _tools.set(toolDef.name, toolDef);
          continue;
        }

        // Case 3: exported has a default that is a BaseTool instance
        if (exported && exported.default && exported.default instanceof BaseTool) {
          const toolDef = exported.default.toToolDef();
          _tools.set(toolDef.name, toolDef);
          continue;
        }

        // Case 4: exported is a BaseTool subclass (constructor) — instantiate
        if (typeof exported === 'function' && exported.prototype instanceof BaseTool) {
          const instance = new exported();
          const toolDef = instance.toToolDef();
          _tools.set(toolDef.name, toolDef);
          continue;
        }

        // Case 5: exported.default is a BaseTool subclass — instantiate
        if (exported && typeof exported.default === 'function' && exported.default.prototype instanceof BaseTool) {
          const instance = new exported.default();
          const toolDef = instance.toToolDef();
          _tools.set(toolDef.name, toolDef);
          continue;
        }

        // Case 6: plain { name, execute } object — wrap it
        if (exported && exported.name && typeof exported.execute === 'function') {
          _tools.set(exported.name, exported);
        }
      } catch (err) {
        console.warn(`[ToolRegistry] Failed to load ${dir.name}/index.js: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[ToolRegistry] Failed to scan tool subdirectories: ${err.message}`);
  }

  // ── Phase 2: Load flat .js tool files from this directory ───────
  try {
    const files = fs.readdirSync(__dirname).filter(f =>
      f.endsWith('.js') && !f.startsWith('_') && f !== 'index.js'
    );

    for (const file of files) {
      try {
        const tool = require(path.join(__dirname, file));
        if (tool && tool.name && tool.execute) {
          // Only add if not already registered by a subdirectory tool
          if (!_tools.has(tool.name)) {
            _tools.set(tool.name, tool);
          }
        }
      } catch (err) {
        console.warn(`[ToolRegistry] Failed to load ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`[ToolRegistry] Failed to scan tools directory: ${err.message}`);
  }

  // ── Phase 3: Bridge legacy BUILTIN_TOOLS from toolCalling.js ─────
  // This ensures all existing tools are available through the registry.
  try {
    const toolCalling = require('../services/toolCalling');
    if (toolCalling.BUILTIN_TOOLS && Array.isArray(toolCalling.BUILTIN_TOOLS)) {
      for (const legacy of toolCalling.BUILTIN_TOOLS) {
        if (legacy.name && !_tools.has(legacy.name)) {
          // Wrap legacy tool in the new interface
          const wrapped = defineTool({
            name: legacy.name,
            description: legacy.description || '',
            category: legacy.category || 'custom',
            risk: legacy.risk || 'medium',
            inputSchema: _convertLegacyParams(legacy.parameters),
            execute: legacy.handler,
          });
          _tools.set(wrapped.name, wrapped);
        }
      }
    }
  } catch {
    // toolCalling not available — that's fine, use only file-based tools
  }

  // ── Phase 4: Register tool-associated slash commands ─────────────
  try {
    const cmdReg = require('../cli/commandRegistry');
    for (const tool of _tools.values()) {
      if (tool._pendingCommands) {
        cmdReg.registerBulk(tool._pendingCommands, 'tool');
      }
    }
  } catch { /* commandRegistry not available */ }
}

/**
 * Convert legacy parameter format to inputSchema format.
 * Legacy: { symbol: { type: 'string', required: true, description: '...' } }
 * New:    same format (compatible)
 */
function _convertLegacyParams(params) {
  if (!params || typeof params !== 'object') return {};
  // The formats are actually compatible, just pass through
  return { ...params };
}

/**
 * Merge two tool maps with primary-map precedence on name collisions.
 * @param {Map<string, object>} primary
 * @param {Map<string, object>} secondary
 * @returns {Map<string, object>}
 */
function mergeToolMaps(primary, secondary) {
  const merged = new Map(primary);
  for (const [name, tool] of secondary) {
    if (!merged.has(name)) merged.set(name, tool);
  }
  return merged;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get all registered tools.
 * @returns {Map<string, object>}
 */
function getAll() {
  if (!_loaded) loadTools();
  if (!_isRegistryMemoEnabled()) {
    return mergeToolMaps(_tools, _mcpTools);
  }
  if (_getAllCache && _getAllCacheVersion === _toolsVersion) {
    return _getAllCache;
  }
  const merged = mergeToolMaps(_tools, _mcpTools);
  _getAllCache = merged;
  _getAllCacheVersion = _toolsVersion;
  return merged;
}

/**
 * Get a specific tool by name.
 * @param {string} name
 * @returns {object|undefined}
 */
function get(name) {
  if (!_loaded) loadTools();
  return _tools.get(name) || _mcpTools.get(name);
}

/**
 * Get tool definitions in Claude/OpenAI function-calling format.
 * @param {string} [profileId] - Optional profile to filter tools (minimal/coding/analysis/full)
 * @returns {Array<{name, description, parameters}>}
 */
function getDefinitions(profileId) {
  let tools = getAll();
  if (profileId && profileId !== 'full') {
    tools = filterToolsByProfile(tools, profileId);
  }
  // Deferral filtering: exclude unrevealed deferred tools
  if (_deferralEnabled && profileId !== 'full') {
    tools = _filterDeferred(tools);
  }
  return [...tools.values()].map(t => t.toFunctionDef());
}

/**
 * Get tools grouped by category.
 * @returns {object} { data: [tools], analysis: [tools], ... }
 */
function getByCategory() {
  const grouped = {};
  for (const tool of getAll().values()) {
    if (!grouped[tool.category]) grouped[tool.category] = [];
    grouped[tool.category].push(tool);
  }
  return grouped;
}

/**
 * Register a new tool (for MCP, plugins, or dynamic registration).
 * @param {object} tool - Tool definition (from defineTool or compatible)
 * @param {object} [options]
 * @param {boolean} [options.isMcp] - Track as MCP tool (separate partition for sorting)
 */
function register(tool, options = {}) {
  if (!_loaded) loadTools();
  if (!tool || !tool.name) {
    throw new Error('Tool must have a name');
  }
  // Wrap if it doesn't have the standard interface
  let registered;
  if (!tool.validate || !tool.toFunctionDef) {
    registered = defineTool({
      name: tool.name,
      description: tool.description || '',
      category: tool.category || (options.isMcp ? 'mcp' : 'custom'),
      risk: tool.risk || 'medium',
      inputSchema: tool.inputSchema || tool.parameters || {},
      execute: tool.execute || tool.handler,
      isReadOnly: tool.isReadOnly,
      isDestructive: tool.isDestructive,
      isConcurrencySafe: tool.isConcurrencySafe,
      isEnabled: tool.isEnabled,
      interruptBehavior: tool.interruptBehavior,
      // Sandbox-escape declaration must survive dynamic registration (MCP/plugins),
      // else the syscall gateway can never force such a tool to L2 (typed-YES).
      sandboxEscape: tool.sandboxEscape,
      requiresSandboxEscape: tool.requiresSandboxEscape,
      shouldDefer: tool.shouldDefer,
      alwaysLoad: tool.alwaysLoad,
      aliases: tool.aliases,
      searchHint: tool.searchHint,
      maxResultSizeChars: tool.maxResultSizeChars,
      prompt: tool.prompt,
      validateInput: tool.validateInput,
      getActivityDescription: tool.getActivityDescription,
      getToolUseSummary: tool.getToolUseSummary,
    });
  } else {
    registered = tool;
  }

  if (options.isMcp) {
    _mcpTools.set(registered.name, registered);
  } else {
    _tools.set(registered.name, registered);
  }
  _bumpToolsVersion();
}

/**
 * Execute a tool by name with parameter validation.
 * Delegates to toolCalling.executeTool for permission checking.
 *
 * @param {string} name - Tool name
 * @param {object} params - Tool parameters
 * @param {object} [context] - Execution context
 * @returns {Promise<object>} Execution result
 */
async function execute(name, params = {}, context = {}) {
  const tool = get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  // Optional param-normalization hook — clamp/canonicalize params BEFORE schema
  // validation (e.g. shellCommand clamps an over-max timeout instead of rejecting
  // it into an opaque "Invalid tool parameters"). Fail-soft; only tools that
  // define normalizeParams are affected. The normalized `p` is what gets validated
  // AND delegated onward (clamp is idempotent, so executeTool's re-normalize is a
  // no-op).
  let p = params;
  if (typeof tool.normalizeParams === 'function') {
    try { p = tool.normalizeParams(params, process.env); } catch { p = params; }
  }

  // Validate parameters — CC-aligned grouped, LLM-friendly message (gate
  // KHY_CC_VALIDATION_ERROR; off → byte-identical `Validation failed: a; b`).
  const validation = tool.validate(p);
  if (!validation.valid) {
    return {
      success: false,
      error: require('./ccValidationError').formatValidationError(name, validation, process.env),
    };
  }

  // Delegate to toolCalling for permission checking
  const { normalizeToolResult } = require('./_toolResultNormalizer');
  try {
    const toolCalling = require('../services/toolCalling');
    const result = await toolCalling.executeTool(name, p, context || {});
    return normalizeToolResult(result);
  } catch {
    // toolCalling not available — execute directly (no permission check)
    try {
      const result = await tool.execute(p, context);
      return normalizeToolResult(result);
    } catch (err) {
      return { success: false, error: err.message, content: err.message };
    }
  }
}

/**
 * Get the count of registered tools.
 * @returns {number}
 */
function count() {
  return getAll().size;
}

/**
 * Clear only the MCP partition of the registry (built-in tools untouched).
 * Used by the MCP tool-pool bridge to rebuild the dynamic MCP tool set on each
 * sync (s19: the tool pool is dynamic, a cached pool goes stale).
 */
function clearMcpTools() {
  _mcpTools.clear();
  _bumpToolsVersion();
}

/**
 * Names of the currently-registered MCP tools.
 * @returns {string[]}
 */
function getMcpToolNames() {
  if (!_loaded) loadTools();
  return [..._mcpTools.keys()];
}

/**
 * Force reload all tools (for development/hot-reload).
 */
function reload() {
  _tools.clear();
  _mcpTools.clear();
  _denyRules = null;
  _loaded = false;
  _bumpToolsVersion();

  // Clear require cache for tool files (flat and subdirectory)
  try {
    const entries = fs.readdirSync(__dirname, { withFileTypes: true });

    // Clear subdirectory tool caches
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) {
        const indexPath = path.join(__dirname, entry.name, 'index.js');
        try { delete require.cache[require.resolve(indexPath)]; } catch { /* ignore */ }
      }
    }

    // Clear flat file caches
    const files = entries.filter(e =>
      e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_') && e.name !== 'index.js'
    );
    for (const file of files) {
      const fullPath = path.join(__dirname, file.name);
      try { delete require.cache[require.resolve(fullPath)]; } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  loadTools();
  return _tools.size;
}

// ── Deny Rules ─────────────────────────────────────────────────────

/**
 * Load deny rules from user config.
 * Format: [{ "tool": "shellCommand", "reason": "..." }, { "tool": "mcp__*" }]
 * @returns {Array<{ tool: string, reason?: string }>}
 */
function loadDenyRules() {
  if (_denyRules !== null) return _denyRules;
  try {
    const { getDataHome } = require('../utils/dataHome');
    const configPath = path.join(getDataHome(), 'tool_deny_rules.json');
    if (!fs.existsSync(configPath)) { _denyRules = []; return _denyRules; }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    _denyRules = Array.isArray(raw) ? raw.filter(r => r && r.tool) : [];
  } catch {
    _denyRules = [];
  }
  return _denyRules;
}

/**
 * Check if a tool name matches any deny rule (supports glob * wildcard).
 * @param {string} name
 * @param {Array} rules
 * @returns {boolean}
 */
function isDenied(name, rules) {
  for (const rule of rules) {
    if (rule.tool === name) return true;
    if (rule.tool.includes('*')) {
      const pattern = new RegExp('^' + rule.tool.replace(/\*/g, '.*') + '$');
      if (pattern.test(name)) return true;
    }
  }
  return false;
}

/**
 * Filter a tool map by deny rules.
 * @param {Map} toolMap
 * @param {Array} rules
 * @returns {Map}
 */
function filterByDenyRules(toolMap, rules) {
  if (!rules || rules.length === 0) return toolMap;
  const result = new Map();
  for (const [name, tool] of toolMap) {
    if (!isDenied(name, rules)) result.set(name, tool);
  }
  return result;
}

// ── Tool Pool Assembly ─────────────────────────────────────────────

/**
 * Assemble the final tool pool with deny rules, sorted for prompt cache stability.
 *
 * Strategy: built-in tools (sorted by name) + MCP tools (sorted by name).
 * Separated sorting preserves prompt cache breakpoints — MCP tool changes
 * don't invalidate the built-in tool cache prefix.
 *
 * uniqBy(name) ensures built-in tools take priority over MCP tools with
 * the same name.
 *
 * @param {Array} [denyRules] - Optional deny rules override
 * @returns {Map<string, object>}
 */
/**
 * Assemble the final tool pool with deny rules and profile filtering,
 * sorted for prompt cache stability.
 *
 * @param {Array} [denyRules] - Optional deny rules override
 * @param {string} [profileId] - Optional profile to filter tools (minimal/coding/analysis/full)
 * @returns {Map<string, object>}
 */
function assembleToolPool(denyRules, profileId) {
  if (!_loaded) loadTools();

  // Memoize the default (deny-rules-unspecified) production path. The pool is a
  // pure function of: registry contents (_toolsVersion), profileId, deferral
  // toggle (_deferralEnabled), and the revealed-deferred set (_revealVersion).
  // A caller-supplied denyRules override is un-keyable here, so it always
  // rebuilds. INVARIANT: the sole consumer (claudeAdapter.buildDirectToolDefs)
  // treats the returned Map as READ-ONLY (iterate + toFunctionDef only), so the
  // shared cached Map is safe. Gate off → byte-identical legacy rebuild.
  if (denyRules === undefined && _isAssemblePoolMemoEnabled()) {
    const key = _assemblePoolCacheKey(profileId);
    if (_assemblePoolCache.has(key)) return _assemblePoolCache.get(key);
    const built = _buildToolPool(undefined, profileId);
    if (_assemblePoolCache.size >= _ASSEMBLE_POOL_CACHE_CAP) _assemblePoolCache.clear();
    _assemblePoolCache.set(key, built);
    return built;
  }

  return _buildToolPool(denyRules, profileId);
}

// ── assembleToolPool() memoization (Ch2「不要每轮重建可复用结构」) ─────
// buildDirectToolDefs() (native cloud path) rebuilds the full sorted+filtered
// tool pool on every model round-trip: 2× filterByDenyRules, 2× profile filter,
// 2× deferral filter, 2× full sort of ~200 tools, then a merge — the priciest
// per-round-trip derivation. It is a pure function of registry version, profile,
// deferral toggle, and reveal fingerprint (all captured in the key below).
const _assemblePoolCache = new Map();
const _ASSEMBLE_POOL_CACHE_CAP = 16;
function _isAssemblePoolMemoEnabled() {
  const v = String(process.env.KHY_TOOL_ASSEMBLE_POOL_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
function _assemblePoolCacheKey(profileId) {
  return `${profileId || 'full'}|${_toolsVersion}|${_deferralEnabled ? 1 : 0}|${_revealVersion}`;
}

/** Build the sorted, deny/profile/deferral-filtered, merged tool pool. Pure. */
function _buildToolPool(denyRules, profileId) {
  const rules = denyRules || loadDenyRules();

  // Partition: built-in vs MCP
  let builtIn = filterByDenyRules(_tools, rules);
  let mcp = filterByDenyRules(_mcpTools, rules);

  // Apply profile filtering (before sorting for efficiency)
  if (profileId && profileId !== 'full') {
    builtIn = filterToolsByProfile(builtIn, profileId);
    mcp = filterToolsByProfile(mcp, profileId);
  }

  // Apply deferral filtering
  if (_deferralEnabled && profileId !== 'full') {
    builtIn = _filterDeferred(builtIn);
    mcp = _filterDeferred(mcp);
  }

  // Sort each partition by name, then concatenate
  const byName = (a, b) => a[0].localeCompare(b[0]);
  const sortedBuiltIn = [...builtIn.entries()].sort(byName);
  const sortedMcp = [...mcp.entries()].sort(byName);

  // Merge with built-in priority (uniqBy name)
  const result = new Map();
  for (const [name, tool] of sortedBuiltIn) {
    result.set(name, tool);
  }
  for (const [name, tool] of sortedMcp) {
    if (!result.has(name)) result.set(name, tool);
  }

  return result;
}

// ── Deferred Loading Support ───────────────────────────────────────

/**
 * Get tools that should be deferred (not loaded into initial prompt).
 * @returns {Map<string, object>}
 */
function getDeferredTools() {
  if (!_loaded) loadTools();
  const result = new Map();
  for (const [name, tool] of _tools) {
    if (tool.shouldDefer && !tool.alwaysLoad) {
      result.set(name, tool);
    }
  }
  for (const [name, tool] of _mcpTools) {
    if (tool.shouldDefer && !tool.alwaysLoad && !result.has(name)) {
      result.set(name, tool);
    }
  }
  return result;
}

/**
 * Get tools that should be loaded immediately (non-deferred).
 * @returns {Map<string, object>}
 */
function getNonDeferredTools() {
  if (!_loaded) loadTools();
  const result = new Map();
  for (const [name, tool] of _tools) {
    if (!tool.shouldDefer || tool.alwaysLoad) {
      result.set(name, tool);
    }
  }
  for (const [name, tool] of _mcpTools) {
    if ((!tool.shouldDefer || tool.alwaysLoad) && !result.has(name)) {
      result.set(name, tool);
    }
  }
  return result;
}

// ── Deferred Session Management ──────────────────────────────────

/**
 * Filter out unrevealed deferred tools from a tool map.
 * @param {Map<string, object>} toolMap
 * @returns {Map<string, object>}
 */
function _filterDeferred(toolMap) {
  const result = new Map();
  for (const [name, tool] of toolMap) {
    if (tool.shouldDefer && !tool.alwaysLoad && !_revealedDeferred.has(name)) continue;
    result.set(name, tool);
  }
  return result;
}

/**
 * Filter deferred tools using an AgentContext's revealedDeferred set.
 * @param {Map<string, object>} toolMap
 * @param {Set<string>} revealedSet - Per-agent revealed deferred set
 * @returns {Map<string, object>}
 */
function _filterDeferredForContext(toolMap, revealedSet) {
  const result = new Map();
  for (const [name, tool] of toolMap) {
    if (tool.shouldDefer && !tool.alwaysLoad && !revealedSet.has(name)) continue;
    result.set(name, tool);
  }
  return result;
}

// ── AgentContext-aware API ─────────────────────────────────────────

/**
 * Get tool definitions scoped to a specific AgentContext.
 * Uses the agent's own revealedDeferred set and optional toolFilter.
 *
 * @param {import('../services/agentContext').AgentContext} agentContext
 * @returns {Array<{name, description, parameters}>}
 */
function getDefinitionsForContext(agentContext) {
  let tools = getAll();
  const profileId = agentContext.toolFilter;
  if (profileId && profileId !== 'full') {
    tools = filterToolsByProfile(tools, profileId);
  }
  // Use agent-specific revealed deferred set
  if (_deferralEnabled && profileId !== 'full') {
    tools = _filterDeferredForContext(tools, agentContext.revealedDeferred);
  }
  return [...tools.values()].map(t => t.toFunctionDef());
}

/**
 * Reveal a deferred tool in a specific AgentContext (not global session).
 *
 * @param {string} name - Tool name to reveal
 * @param {import('../services/agentContext').AgentContext} agentContext
 * @returns {{ revealed: boolean, reason?: string, tool?: object, error?: string }}
 */
function ensureToolForContext(name, agentContext) {
  if (!_loaded) loadTools();

  const tool = _tools.get(name) || _mcpTools.get(name);
  if (!tool) {
    return { revealed: false, error: `Tool not found: ${name}` };
  }

  if (!tool.shouldDefer || tool.alwaysLoad || agentContext.revealedDeferred.has(name)) {
    return { revealed: false, reason: 'already available', tool };
  }

  agentContext.revealedDeferred.add(name);
  return { revealed: true, tool };
}

/**
 * Reveal a deferred tool, making it available in the current session.
 * Handles concurrent calls for the same tool via inflight dedup.
 *
 * @param {string} name - Tool name to reveal
 * @returns {Promise<{ revealed: boolean, reason?: string, tool?: object, error?: string }>}
 */
async function ensureTool(name) {
  if (!_loaded) loadTools();

  const tool = _tools.get(name) || _mcpTools.get(name);
  if (!tool) {
    return { revealed: false, error: `Tool not found: ${name}` };
  }

  // Already available (non-deferred, alwaysLoad, or previously revealed)
  if (!tool.shouldDefer || tool.alwaysLoad || _revealedDeferred.has(name)) {
    return { revealed: false, reason: 'already available', tool };
  }

  // Concurrent dedup: return existing inflight promise
  if (_inflightReveals.has(name)) {
    return _inflightReveals.get(name);
  }

  const revealPromise = (async () => {
    try {
      _revealedDeferred.add(name);
      _revealVersion++;
      return { revealed: true, tool };
    } finally {
      _inflightReveals.delete(name);
    }
  })();

  _inflightReveals.set(name, revealPromise);
  return revealPromise;
}

/**
 * Reset deferred session state (call when starting a new conversation).
 */
function resetDeferredSession() {
  _revealedDeferred.clear();
  _inflightReveals.clear();
  _revealVersion++;
}

/**
 * Dynamically enable/disable deferral mechanism.
 * @param {boolean} enabled
 */
function setDeferralEnabled(enabled) {
  _deferralEnabled = !!enabled;
}

/**
 * Get a copy of the revealed deferred tools set.
 * @returns {Set<string>}
 */
function getRevealedDeferred() {
  return new Set(_revealedDeferred);
}

/**
 * Get a tool's rich description (calls prompt() method).
 * @param {string} name
 * @returns {Promise<string>}
 */
async function getToolPrompt(name) {
  if (!_loaded) loadTools();
  const tool = _tools.get(name) || _mcpTools.get(name);
  if (!tool) return '';
  return tool.prompt();
}

// ── Result Size Management ─────────────────────────────────────────

const DEFAULT_MAX_RESULT_CHARS = 30000;  // 30K default
const RESULT_DIR = path.join(os.homedir(), '.khyquant', 'tool_results');

/**
 * Apply result size budget. Truncates oversized output and optionally
 * persists the full result to disk.
 *
 * @param {string} toolName - Tool name (for limit lookup)
 * @param {string} output - Raw output string
 * @param {number} [maxChars] - Override max chars (otherwise uses tool's maxResultSizeChars)
 * @returns {{ output: string, truncated: boolean, diskPath?: string }}
 */
function applyResultBudget(toolName, output, maxChars) {
  if (typeof output !== 'string') {
    try { output = JSON.stringify(output); } catch { output = String(output); }
  }

  // Determine limit
  let limit = maxChars;
  if (limit === undefined) {
    if (!_loaded) loadTools();
    const tool = _tools.get(toolName) || _mcpTools.get(toolName);
    if (tool && tool.maxResultSizeChars !== undefined) {
      limit = tool.maxResultSizeChars;
    } else {
      limit = DEFAULT_MAX_RESULT_CHARS;
    }
  }

  // Infinity = exempt from truncation
  if (!Number.isFinite(limit)) {
    return { output, truncated: false };
  }

  if (output.length <= limit) {
    return { output, truncated: false };
  }

  // Truncate and persist full result to disk
  let diskPath;
  try {
    if (!fs.existsSync(RESULT_DIR)) fs.mkdirSync(RESULT_DIR, { recursive: true });
    const filename = `${toolName}_${Date.now()}.txt`;
    diskPath = path.join(RESULT_DIR, filename);
    fs.writeFileSync(diskPath, output, 'utf-8');

    // Clean old results (keep last 20)
    const files = fs.readdirSync(RESULT_DIR).sort();
    while (files.length > 20) {
      try { fs.unlinkSync(path.join(RESULT_DIR, files.shift())); } catch {}
    }
  } catch {
    diskPath = undefined;
  }

  const preview = output.slice(0, limit);
  const suffix = diskPath
    ? `\n... (truncated from ${output.length} chars, full result at: ${diskPath})`
    : `\n... (truncated from ${output.length} chars)`;

  return { output: preview + suffix, truncated: true, diskPath };
}

/**
 * Get tools exempt from result size budgeting (maxResultSizeChars = Infinity).
 * @returns {Set<string>}
 */
function getResultSizeExempt() {
  const exempt = new Set();
  for (const [name, tool] of getAll()) {
    if (tool.maxResultSizeChars !== undefined && !Number.isFinite(tool.maxResultSizeChars)) {
      exempt.add(name);
    }
  }
  return exempt;
}

// ── Behavioral Query Methods ───────────────────────────────────────

/**
 * Get all read-only tools (safe for auto-approval in normal permission mode).
 * @returns {Map<string, object>}
 */
function getReadOnly() {
  const result = new Map();
  for (const [name, tool] of getAll()) {
    if (typeof tool.isReadOnly === 'function' && tool.isReadOnly()) {
      result.set(name, tool);
    }
  }
  return result;
}

/**
 * Get tools that would be destructive for the given input.
 * @param {object} [input] - Tool parameters to evaluate dynamic checks
 * @returns {Map<string, object>}
 */
function getDestructive(input) {
  const result = new Map();
  for (const [name, tool] of getAll()) {
    if (typeof tool.isDestructive === 'function' && tool.isDestructive(input)) {
      result.set(name, tool);
    }
  }
  return result;
}

/**
 * Get all tools safe for parallel (concurrent) execution.
 * @returns {Map<string, object>}
 */
function getConcurrencySafe() {
  const result = new Map();
  for (const [name, tool] of getAll()) {
    if (typeof tool.isConcurrencySafe === 'function' && tool.isConcurrencySafe()) {
      result.set(name, tool);
    }
  }
  return result;
}

/**
 * Get all currently enabled tools (respects isEnabled checks like isGitRepo).
 * @returns {Map<string, object>}
 */
function getEnabled() {
  const result = new Map();
  for (const [name, tool] of getAll()) {
    const enabled = typeof tool.isEnabled === 'function' ? tool.isEnabled() : true;
    if (enabled) result.set(name, tool);
  }
  return result;
}

/**
 * Get function-calling definitions for enabled tools only.
 * @returns {Array<{name, description, parameters}>}
 */
function getEnabledDefinitions() {
  return [...getEnabled().values()].map(t => t.toFunctionDef());
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  getAll,
  get,
  getDefinitions,
  getByCategory,
  register,
  execute,
  count,
  clearMcpTools,
  getMcpToolNames,
  reload,
  loadTools,
  getReadOnly,
  getDestructive,
  getConcurrencySafe,
  getEnabled,
  getEnabledDefinitions,
  // Chapter 5 additions
  assembleToolPool,
  loadDenyRules,
  filterByDenyRules,
  getDeferredTools,
  getNonDeferredTools,
  getToolPrompt,
  applyResultBudget,
  getResultSizeExempt,
  // Deferred session management
  ensureTool,
  resetDeferredSession,
  setDeferralEnabled,
  getRevealedDeferred,
  // AgentContext-aware API
  getDefinitionsForContext,
  ensureToolForContext,
  // Chapter 6: tool profiles
  listProfiles,
  getProfileTools,
  filterToolsByProfile,

  // assembleToolPool memo (Ch2) — exported for unit testing. Not used in production paths.
  _buildToolPool,
  _assemblePoolCacheKey,
  _assemblePoolMemoSize: () => _assemblePoolCache.size,
  _resetAssemblePoolMemo: () => _assemblePoolCache.clear(),
};
