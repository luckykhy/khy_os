'use strict';

/**
 * MCP tool-pool bridge (s19) — the `assemble_tool_pool` equivalent.
 *
 * KHY already had every shape (a stdio MCPClient, `mcp__server__tool` naming,
 * a registry that partitions MCP tools in assembleToolPool), but the chain was
 * never wired end-to-end: discovered MCP tools reached the prompt listing yet
 * never became *callable*. This module closes the gap — connect → list →
 * register-into-pool → dispatch:
 *
 *   For every tool on every connected server it registers a first-class tool in
 *   the shared registry under the collision-safe `mcp__server__tool` name. The
 *   registered tool's execute() closes over the owning client and the ORIGINAL
 *   (un-normalized) tool name, so dispatch never depends on lossy re-parsing of
 *   the normalized qualified name — mirroring the teaching version's
 *   `lambda c=client, t=tool_def["name"]: c.call_tool(t, kw)`.
 *
 * Rebuild semantics (s19: "the tool pool is dynamic, a cached pool goes stale"):
 * each sync first clears the MCP partition, then re-registers the tools of the
 * currently-connected servers, so a disconnected server's tools disappear.
 *
 * Dependencies are injectable (manager / registry) so the full
 * register-and-dispatch cycle is unit-testable with fakes — no subprocess, no
 * network.
 */

// 工具注册表真源是 src/tools（导出 register / clearMcpTools / getMcpToolNames…），
// 不是 cli/handlers/tools（只导出 handleToolsCommand，上述方法全为 undefined）。
// 旧写法既造成 services→cli 分层倒置，又让默认路径在运行期静默拿不到注册表。
const defaultRegistry = require('../../../../tools');

const defaultManager = require('../../../../agents/index');

const { planMcpDisclosure, estimateToolTokens, isDisclosureEnabled } = require('./mcpDisclosurePlan');

/**
 * Append an MCP permission annotation to a description (s19 (readOnly) /
 * (destructive) text annotation). readOnly takes precedence when both are set.
 * @param {string} description
 * @param {{ isReadOnly?: boolean, isDestructive?: boolean }} flags
 * @returns {string}
 */
function annotateDescription(description, flags = {}) {
  const base = description || '';
  if (flags.isReadOnly) {
    return `${base} (readOnly)`.trim();
  }
  if (flags.isDestructive) {
    return `${base} (destructive)`.trim();
  }
  return base;
}

/**
 * Build a registry-compatible callable tool from one serialized MCP tool bound
 * to its owning client.
 * @param {object} serialized - output of serializeTool (qualified name etc.)
 * @param {object} client - the MCPClient that owns the tool (has callTool)
 * @returns {object} a tool definition accepted by registry.register
 */
function buildCallableTool(serialized, client, { shouldDefer = false } = {}) {
  const originalToolName =
    serialized.originalToolName != null ? serialized.originalToolName : serialized.name;
  return {
    name: serialized.name,
    description: annotateDescription(serialized.description, serialized),
    category: 'mcp',
    inputSchema: serialized.inputJSONSchema || { type: 'object', properties: {} },
    isReadOnly: !!serialized.isReadOnly,
    isDestructive: !!serialized.isDestructive,
    // Progressive disclosure: deferred MCP tools stay callable after the model
    // reveals them via the existing toolSearch → ensureTool path.
    ...(shouldDefer ? { shouldDefer: true } : {}),
    isEnabled: () => true,
    // Closure dispatch: route straight to the owning client with the ORIGINAL
    // tool name, immune to normalization of the qualified `name`.
    execute: async (params = {}) => client.callTool(originalToolName, params || {}),
  };
}

/**
 * Register every tool from the connected MCP servers into the tool registry.
 *
 * Progressive disclosure (mcpDisclosurePlan): the full directory is estimated
 * first; only when it would crowd the prompt past threshold × context window
 * is the whole MCP partition registered as deferred (toolSearch reveals it on
 * demand). Small directories keep the legacy always-inline behavior.
 *
 * @param {object} [opts]
 * @param {object} [opts.manager]  MCP manager (default: services/mcp/index).
 * @param {object} [opts.registry] tool registry (default: src/tools).
 * @param {number} [opts.contextWindowTokens] model window for the budget check.
 * @returns {{ registered: string[], servers: string[], disclosure: object }}
 */
function syncMcpToolsToRegistry({
  manager = defaultManager,
  registry = defaultRegistry,
  contextWindowTokens = 0,
} = {}) {
  // s19 rebuild: drop the stale MCP partition before re-registering live tools.
  if (typeof registry.clearMcpTools === 'function') {
    registry.clearMcpTools();
  }

  const servers =
    typeof manager.getConnectedServers === 'function' ? manager.getConnectedServers() : [];

  // Phase 1: collect (server, client, tool) triples without touching the registry.
  const pending = [];
  for (const serverName of servers) {
    const client = typeof manager.getClient === 'function' ? manager.getClient(serverName) : null;
    if (
      !client ||
      typeof client.listTools !== 'function' ||
      typeof client.callTool !== 'function'
    ) {
      continue;
    }
    let serializedTools;
    try {
      serializedTools = client.listTools() || [];
    } catch {
      serializedTools = [];
    }
    for (const serialized of serializedTools) {
      if (!serialized || !serialized.name) {
        continue;
      }
      pending.push({ serialized, client });
    }
  }

  // Phase 2: one disclosure decision for the whole MCP directory.
  const serializedAll = pending.map((p) => p.serialized);
  const disclosure = planMcpDisclosure({
    toolCount: serializedAll.length,
    estTokens: estimateToolTokens(serializedAll),
    contextWindowTokens,
  }, { enabled: isDisclosureEnabled() });

  const registered = [];
  for (const { serialized, client } of pending) {
    registry.register(
      buildCallableTool(serialized, client, { shouldDefer: disclosure.mode === 'deferred' }),
      { isMcp: true },
    );
    registered.push(serialized.name);
  }

  return { registered, servers, disclosure };
}

/**
 * s20 per-turn entry point: refresh the registry's MCP partition to match the
 * currently-connected servers, called from the agent loop right before the tool
 * pool is assembled for the model (the "Before LLM → assemble_tool_pool" slot).
 *
 * Designed to be a near-zero-cost no-op in the common case (no MCP servers): it
 * only touches the registry when servers are connected, or to drop stale tools
 * after the last server disconnects. It NEVER throws — a refresh failure must
 * never break the loop — so callers can invoke it unguarded.
 *
 * @param {object} [opts]
 * @param {object} [opts.manager]
 * @param {object} [opts.registry]
 * @returns {{ refreshed: boolean, registered: string[], servers: string[] }}
 */
function refreshMcpToolPool({
  manager = defaultManager,
  registry = defaultRegistry,
  contextWindowTokens = 0,
} = {}) {
  try {
    const servers =
      typeof manager.getConnectedServers === 'function' ? manager.getConnectedServers() : [];

    if (!servers.length) {
      // Nothing connected. Drop any tools left over from a prior connection so a
      // disconnected server's tools cannot linger in the pool, but otherwise do
      // no work (don't churn the registry every idle turn).
      const stale =
        typeof registry.getMcpToolNames === 'function' ? registry.getMcpToolNames() : [];
      if (stale.length && typeof registry.clearMcpTools === 'function') {
        registry.clearMcpTools();
        return {
          refreshed: true,
          registered: [],
          servers: [],
          disclosure: planMcpDisclosure({ toolCount: 0, estTokens: 0, contextWindowTokens }),
        };
      }
      return {
        refreshed: false,
        registered: [],
        servers: [],
        disclosure: planMcpDisclosure({ toolCount: 0, estTokens: 0, contextWindowTokens }),
      };
    }

    const res = syncMcpToolsToRegistry({ manager, registry, contextWindowTokens });
    return {
      refreshed: true,
      registered: res.registered,
      servers: res.servers,
      disclosure: res.disclosure,
    };
  } catch {
    return { refreshed: false, registered: [], servers: [], disclosure: null };
  }
}

module.exports = {
  syncMcpToolsToRegistry,
  refreshMcpToolPool,
  buildCallableTool,
  annotateDescription,
};
