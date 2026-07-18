/**
 * MCP Type Definitions
 *
 * Mirrors Claude Code's MCP type system for Khy OS.
 * Defines connection states, server configs, serialization types,
 * and the overall MCP client state structure.
 */

// ── Transport Types ─────────────────────────────────────────────────────────

/**
 * Supported MCP transport mechanisms.
 * @readonly
 * @enum {string}
 */
const Transport = Object.freeze({
  STDIO: 'stdio',
  SSE: 'sse',
  HTTP: 'http',
  WS: 'ws',
});

// ── Connection State Types ──────────────────────────────────────────────────

/**
 * @readonly
 * @enum {string}
 */
const ConnectionState = Object.freeze({
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  FAILED: 'failed',
  PENDING: 'pending',
  DISABLED: 'disabled',
});

/**
 * Config scope — where a server config originates.
 * @readonly
 * @enum {string}
 */
const ConfigScope = Object.freeze({
  LOCAL: 'local',       // .khyquant/mcp.json in project dir
  USER: 'user',         // ~/.khy/mcp.json or ~/.khyquant/mcp.json
  DYNAMIC: 'dynamic',   // Added at runtime via API
});

// ── Server Config Shapes ────────────────────────────────────────────────────

/**
 * Validate a stdio server config.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateStdioConfig(config) {
  const errors = [];
  if (!config.command || typeof config.command !== 'string') {
    errors.push('command is required and must be a non-empty string');
  }
  if (config.args && !Array.isArray(config.args)) {
    errors.push('args must be an array of strings');
  }
  if (config.env && typeof config.env !== 'object') {
    errors.push('env must be an object mapping string keys to string values');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate an SSE/HTTP server config.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateUrlConfig(config) {
  const errors = [];
  if (!config.url || typeof config.url !== 'string') {
    errors.push('url is required and must be a non-empty string');
  }
  if (config.headers && typeof config.headers !== 'object') {
    errors.push('headers must be an object mapping string keys to string values');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a server config based on its transport type.
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateServerConfig(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be a non-null object'] };
  }

  const type = config.type || Transport.STDIO;
  switch (type) {
    case Transport.STDIO:
      return validateStdioConfig(config);
    case Transport.SSE:
    case Transport.HTTP:
    case Transport.WS:
      return validateUrlConfig(config);
    default:
      return { valid: false, errors: [`unknown transport type: ${type}`] };
  }
}

// ── Serialization Types ─────────────────────────────────────────────────────

/**
 * Normalize a server or tool name for use inside an `mcp__server__tool` token
 * (s19 normalize_mcp_name). Every character outside `[A-Za-z0-9_-]` is replaced
 * with `_`, so special characters in a server/tool name cannot break the `__`
 * delimiter, collide across servers, or inject into the qualified name.
 * Mirrors Claude Code's buildMcpToolName normalization and the teaching
 * version's `_DISALLOWED_CHARS.sub('_', name)`.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeMcpName(name) {
  return String(name == null ? '' : name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Create a serialized tool descriptor from an MCP tool definition.
 *
 * The qualified `name` is built from NORMALIZED segments so it is always
 * collision/injection-safe, while `originalToolName` retains the raw name for
 * dispatch (the registered tool's execute closes over it, so a lossy qualified
 * name never has to be re-parsed back to the original). MCP annotation hints
 * (readOnlyHint / destructiveHint) are mapped to registry permission flags.
 *
 * @param {string} serverName
 * @param {object} mcpTool - Raw tool from MCP server's tools/list response
 * @returns {object} SerializedTool
 */
function serializeTool(serverName, mcpTool) {
  const safeServer = normalizeMcpName(serverName);
  const safeTool = normalizeMcpName(mcpTool.name);
  const ann = (mcpTool && mcpTool.annotations) || {};
  return {
    name: `mcp__${safeServer}__${safeTool}`,
    originalToolName: mcpTool.name,
    serverName,
    normalizedServerName: safeServer,
    description: mcpTool.description || '',
    inputJSONSchema: mcpTool.inputSchema || { type: 'object', properties: {} },
    isMcp: true,
    // Annotation-driven permission flags (explicit hints only; absence ⇒ false,
    // leaving the decision to the permission layer rather than guessing).
    isReadOnly: ann.readOnlyHint === true,
    isDestructive: ann.destructiveHint === true,
    annotations: ann,
  };
}

/**
 * Create a serialized client descriptor from a connection.
 * @param {object} connection - MCPServerConnection
 * @returns {object} SerializedClient
 */
function serializeClient(connection) {
  return {
    name: connection.name,
    type: connection.type,
    capabilities: connection.capabilities || undefined,
    serverInfo: connection.serverInfo || undefined,
    instructions: connection.instructions || undefined,
    tools: (connection.tools || []).map(t => serializeTool(connection.name, t)),
    error: connection.error || undefined,
  };
}

/**
 * Build the full MCP CLI state snapshot for serialization.
 * @param {Map<string, object>} connections - Map of server name to MCPServerConnection
 * @returns {object} MCPCliState
 */
function buildCliState(connections) {
  const clients = [];
  const tools = [];
  const configs = {};
  const resources = {};

  for (const [name, conn] of connections) {
    clients.push(serializeClient(conn));
    configs[name] = conn.config || {};

    if (conn.type === ConnectionState.CONNECTED && conn.tools) {
      for (const tool of conn.tools) {
        tools.push(serializeTool(name, tool));
      }
    }

    if (conn.resources) {
      resources[name] = conn.resources.map(r => ({ ...r, server: name }));
    }
  }

  return { clients, configs, tools, resources };
}

module.exports = {
  Transport,
  ConnectionState,
  ConfigScope,
  validateServerConfig,
  validateStdioConfig,
  validateUrlConfig,
  normalizeMcpName,
  serializeTool,
  serializeClient,
  buildCliState,
};
