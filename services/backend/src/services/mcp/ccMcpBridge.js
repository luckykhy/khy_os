'use strict';

/**
 * ccMcpBridge.js — pure leaf: the single source of truth for *where* Claude
 * Code stores configured MCP servers on disk, and *how* to extract the
 * mcpServers map out of each of CC's config shapes, so khy can reuse CC's tool
 * (MCP) marketplace — any MCP server CC has set up becomes usable in khy.
 * Zero-IO / deterministic / never throws.
 *
 * Background (verified on a real dev box): CC keeps MCP server configs in three
 * places, all using a `mcpServers` map whose schema is BYTE-IDENTICAL to khy's
 * ({command,args,env} | {type:'sse'|'http',url}):
 *   - ~/.claude.json  → top-level `mcpServers`              (user scope)
 *   - ~/.claude.json  → `projects[<projectDir>].mcpServers` (project scope)
 *   - <projectDir>/.mcp.json → `mcpServers`                 (CC project file)
 * Because khy's MCP loader already accepts exactly this shape, "reuse CC's tool
 * marketplace" reduces to: enumerate CC's config sources, and pull the
 * mcpServers map out of each shape. That is what this leaf computes — the shell
 * (services/mcp/index.js loadConfig) does the fs reads and merges the result.
 *
 * Contract: zero IO (no fs/network/clock; homedir/projectDir and already-parsed
 * JSON injected by the shell), deterministic, never throws (fail-soft → []/{}),
 * env gate KHY_CC_MCP_BRIDGE default ON; OFF → isEnabled=false and the shell
 * reverts byte-for-byte to its legacy khy-only MCP discovery.
 *
 * Honest boundary: this only *discovers/reuses* MCP servers CC already has on
 * disk; it does not install, network-fetch, or launch anything itself (khy's
 * existing MCP client connects them). Installing new servers stays CC's job.
 */

const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** KHY_CC_MCP_BRIDGE gate: default ON, {0,false,off,no} (case/space-insensitive) → OFF. */
function isCcMcpBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_CC_MCP_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/** Join fail-soft: any bad segment → ''. Keeps the leaf non-throwing. */
// 收敛到 utils/pathJoinSafe 单一真源(逐字节委托,调用点不变)
const _join = require('../../utils/pathJoinSafe');

/**
 * Enumerate Claude Code's MCP config sources (does NOT touch the fs — the shell
 * decides which exist, reads + parses them, and calls extractMcpServers).
 *
 * @param {object} args
 * @param {string} args.homedir  user home (shell injects os.homedir())
 * @param {string} [args.projectDir] current project dir (optional)
 * @returns {Array<{path:string, kind:string}>} sources in priority order
 *   (user before project — the shell seeds these at LOWEST priority so khy's own
 *   config overrides on name collision). kind ∈
 *   {'claudeJson-user','claudeJson-project','mcpJson'}. Empty on bad input.
 */
function ccMcpConfigSources({ homedir, projectDir } = {}) {
  try {
    const out = [];
    const push = (p, kind) => { if (p) out.push({ path: p, kind }); };

    if (homedir) {
      const claudeJson = _join(homedir, '.claude.json');
      // Same file carries both the user-scope map and per-project maps; the
      // shell reads it once per source but extraction picks the right shape.
      push(claudeJson, 'claudeJson-user');
      if (projectDir) push(claudeJson, 'claudeJson-project');
    }
    // CC's project-local .mcp.json convention (byte-identical mcpServers map).
    if (projectDir) push(_join(projectDir, '.mcp.json'), 'mcpJson');

    return out;
  } catch {
    return [];
  }
}

/** Look up a project entry in CC's projects map, tolerating path normalization. */
function _projectEntry(projects, projectDir) {
  if (!projects || typeof projects !== 'object' || !projectDir) return null;
  if (Object.prototype.hasOwnProperty.call(projects, projectDir)) return projects[projectDir];
  let resolved = '';
  try { resolved = path.resolve(String(projectDir)); } catch { resolved = ''; }
  if (resolved && Object.prototype.hasOwnProperty.call(projects, resolved)) return projects[resolved];
  return null;
}

/**
 * Extract the mcpServers map out of one parsed CC config object, per its shape.
 * Pure — the shell passes the already-parsed JSON.
 *
 * @param {object} raw parsed JSON from the source file
 * @param {string} kind one of ccMcpConfigSources' kinds
 * @param {string} [projectDir] required to key into claudeJson-project
 * @returns {object} { name: serverConfig } map (empty on any miss / bad input)
 */
function extractMcpServers(raw, kind, projectDir) {
  try {
    if (!raw || typeof raw !== 'object') return {};
    let map = null;
    if (kind === 'claudeJson-user' || kind === 'mcpJson') {
      map = raw.mcpServers;
    } else if (kind === 'claudeJson-project') {
      const entry = _projectEntry(raw.projects, projectDir);
      map = entry && entry.mcpServers;
    }
    if (!map || typeof map !== 'object') return {};
    // Shallow-copy each server config so callers can annotate (add _scope etc.)
    // without mutating the injected input.
    const out = {};
    for (const [name, cfg] of Object.entries(map)) {
      if (name && cfg && typeof cfg === 'object') out[name] = { ...cfg };
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  isCcMcpBridgeEnabled,
  ccMcpConfigSources,
  extractMcpServers,
};
