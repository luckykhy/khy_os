/**
 * MCP (Model Context Protocol) Client — connect to external MCP servers.
 *
 * MCP allows KHY-Quant to connect to external tool providers (databases,
 * APIs, file systems) that expose their capabilities via the MCP protocol.
 *
 * Configuration: ~/.khyquant/mcp.json
 *
 * {
 *   "servers": [
 *     {
 *       "name": "filesystem",
 *       "command": "npx",
 *       "args": ["-y", "@anthropic/mcp-server-filesystem", "/path"],
 *       "enabled": true
 *     },
 *     {
 *       "name": "postgres",
 *       "command": "npx",
 *       "args": ["-y", "@anthropic/mcp-server-postgres", "postgresql://..."],
 *       "enabled": true
 *     }
 *   ]
 * }
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

const MCP_CONFIG_PATH = path.join(os.homedir(), '.khyquant', 'mcp.json');

class MCPClient {
  constructor(config) {
    this.name = config.name;
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.enabled = config.enabled !== false;

    this._process = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._ready = false;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._buffer = '';
  }

  /**
   * Start the MCP server process and initialize.
   */
  async connect() {
    if (!this.enabled) return false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP server "${this.name}" timed out during startup`));
      }, 15000);

      try {
        const env = { ...process.env, ...this.env };
        this._process = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });

        // Read JSON-RPC messages from stdout
        const rl = readline.createInterface({ input: this._process.stdout });
        rl.on('line', (line) => {
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch { /* ignore non-JSON lines */ }
        });

        this._process.stderr.on('data', (data) => {
          // MCP servers may log to stderr
          const text = data.toString().trim();
          if (text) {
            // Store last error for diagnostics
            this._lastError = text;
          }
        });

        this._process.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        this._process.on('exit', (code) => {
          this._ready = false;
          if (!this._ready) {
            clearTimeout(timeout);
            reject(new Error(`MCP server "${this.name}" exited with code ${code}`));
          }
        });

        // Initialize the MCP connection
        this._sendRequest('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          clientInfo: {
            name: 'khy-quant',
            version: require('../../package.json').version,
          },
        }).then(async (result) => {
          clearTimeout(timeout);

          // Send initialized notification
          this._sendNotification('notifications/initialized', {});

          // Fetch available tools
          try {
            const toolsResult = await this._sendRequest('tools/list', {});
            this._tools = toolsResult.tools || [];
          } catch { this._tools = []; }

          // Fetch resources
          try {
            const resourcesResult = await this._sendRequest('resources/list', {});
            this._resources = resourcesResult.resources || [];
          } catch { this._resources = []; }

          this._ready = true;
          resolve(true);
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName, args = {}) {
    if (!this._ready) throw new Error(`MCP server "${this.name}" not connected`);

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  /**
   * Get available tools.
   */
  get tools() {
    return this._tools;
  }

  /**
   * Get available resources.
   */
  get resources() {
    return this._resources;
  }

  /**
   * Check if connected and ready.
   */
  get isReady() {
    return this._ready;
  }

  /**
   * Disconnect from MCP server.
   */
  async disconnect() {
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
    }
    this._ready = false;
  }

  // ── Internal JSON-RPC ──

  _sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this._pendingRequests.set(id, { resolve, reject });
      this._process.stdin.write(msg + '\n');

      // Timeout per request
      setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  _sendNotification(method, params) {
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });
    if (this._process?.stdin?.writable) {
      this._process.stdin.write(msg + '\n');
    }
  }

  _handleMessage(msg) {
    if (msg.id && this._pendingRequests.has(msg.id)) {
      const { resolve, reject } = this._pendingRequests.get(msg.id);
      this._pendingRequests.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error.message || 'MCP error'));
      } else {
        resolve(msg.result);
      }
    }
    // Handle notifications from server (e.g., tool updates)
    if (msg.method === 'notifications/tools/list_changed') {
      this._sendRequest('tools/list', {}).then(result => {
        this._tools = result.tools || [];
      }).catch(() => {});
    }
  }
}

/**
 * Load MCP configuration.
 */
function loadMCPConfig() {
  try {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { servers: [] };
}

/**
 * Save MCP configuration.
 */
function saveMCPConfig(config) {
  try {
    const dir = path.dirname(MCP_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Connect to all configured MCP servers.
 * Returns array of connected MCPClient instances.
 */
async function connectAll() {
  const config = loadMCPConfig();
  const clients = [];

  for (const serverConfig of config.servers) {
    if (!serverConfig.enabled) continue;

    const client = new MCPClient(serverConfig);
    try {
      await client.connect();
      clients.push(client);
    } catch (err) {
      // Log but don't fail — MCP is optional
      console.error(`  MCP "${serverConfig.name}": ${err.message}`);
    }
  }

  return clients;
}

/**
 * Disconnect all MCP clients.
 */
async function disconnectAll(clients) {
  for (const client of clients) {
    await client.disconnect();
  }
}

module.exports = {
  MCPClient,
  loadMCPConfig,
  saveMCPConfig,
  connectAll,
  disconnectAll,
};
