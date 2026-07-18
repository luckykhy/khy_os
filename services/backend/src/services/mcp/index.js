/**
 * MCP Service Module — Model Context Protocol client for Khy OS.
 *
 * Architecture aligned with Claude Code's MCP subsystem:
 *   - MCPServerConnection states: connected / connecting / failed / pending / disabled
 *   - MCPClient with connect(), listTools(), callTool(), disconnect()
 *   - Server instruction extraction and tool schema normalization
 *   - Config loaded from ~/.khy/mcp.json (user) and ./.khy/mcp.json (project)
 *
 * Config format (matches Claude Code's mcpServers schema):
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@anthropic/mcp-server-filesystem", "/path"],
 *         "env": {}
 *       },
 *       "postgres": {
 *         "type": "sse",
 *         "url": "http://localhost:3100/sse"
 *       }
 *     }
 *   }
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const EventEmitter = require('events');
const {
  Transport,
  ConnectionState,
  ConfigScope,
  validateServerConfig,
  normalizeMcpName,
  serializeTool,
  buildCliState,
} = require('./types');

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 2_000;

// Config file locations (priority: project > user > legacy)
const CONFIG_PATHS = {
  user: path.join(os.homedir(), '.khy', 'mcp.json'),
  legacy: path.join(os.homedir(), '.khyquant', 'mcp.json'),
};

// ── MCPClient ───────────────────────────────────────────────────────────────

class MCPClient extends EventEmitter {
  /**
   * @param {string} name - Server display name
   * @param {object} config - Server config (stdio / sse / http / ws)
   * @param {object} [options]
   * @param {number} [options.connectTimeout]
   * @param {number} [options.requestTimeout]
   */
  constructor(name, config, options = {}) {
    super();
    this.name = name;
    this.config = config;
    this.transportType = config.type || Transport.STDIO;
    this.connectTimeout = options.connectTimeout || DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT_MS;

    /** @type {'connected'|'connecting'|'failed'|'pending'|'disabled'} */
    this.state = ConnectionState.PENDING;
    this.capabilities = {};
    this.serverInfo = null;
    this.instructions = null;

    this._process = null;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._reconnectAttempt = 0;
    this._lastError = null;

    // Remote-transport state (http / sse). For stdio these stay null.
    this._sessionId = null;     // Mcp-Session-Id echoed back on streamable HTTP
    this._postUrl = null;       // POST endpoint (sse: discovered; http: the url)
    this._sseAbort = null;      // AbortController for an open SSE GET stream
  }

  // ── Connection Lifecycle ────────────────────────────────────────────────

  /**
   * Connect to the MCP server. Supports stdio transport (spawn process).
   * SSE/HTTP/WS transports are stub-ready for future extension.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.state === ConnectionState.CONNECTED) return;
    if (this.state === ConnectionState.DISABLED) {
      throw new Error(`MCP server "${this.name}" is disabled`);
    }

    // Validate config before attempting connection
    const validation = validateServerConfig(this.config);
    if (!validation.valid) {
      this.state = ConnectionState.FAILED;
      this._lastError = `Invalid config: ${validation.errors.join('; ')}`;
      this.emit('stateChange', this.state, this._lastError);
      throw new Error(this._lastError);
    }

    this.state = ConnectionState.CONNECTING;
    this.emit('stateChange', this.state);

    try {
      if (this.transportType === Transport.STDIO) {
        await this._connectStdio();
      } else if (this.transportType === Transport.HTTP) {
        await this._connectHttp();
      } else if (this.transportType === Transport.SSE) {
        await this._connectSse();
      } else {
        // WS transport remains a future extension.
        throw new Error(`Transport "${this.transportType}" is not yet supported`);
      }

      this.state = ConnectionState.CONNECTED;
      this._reconnectAttempt = 0;
      this.emit('stateChange', this.state);
    } catch (err) {
      this.state = ConnectionState.FAILED;
      this._lastError = err.message;
      this.emit('stateChange', this.state, err.message);
      throw err;
    }
  }

  /**
   * Disconnect from the MCP server and clean up resources.
   * @returns {Promise<void>}
   */
  async disconnect() {
    // Cancel all pending requests
    for (const [id, { reject }] of this._pendingRequests) {
      reject(new Error('Client disconnecting'));
      this._pendingRequests.delete(id);
    }

    if (this._process) {
      const { safeSignal } = require('../../tools/platformUtils');
      safeSignal(this._process, 'SIGTERM');
      this._process = null;
    }

    if (this._readline) {
      this._readline.close();
      this._readline = null;
    }

    // Tear down any open SSE GET stream and best-effort notify the server that
    // the streamable-HTTP session is over (DELETE is advisory; ignore failures).
    if (this._sseAbort) {
      try { this._sseAbort.abort(); } catch { /* already aborted */ }
      this._sseAbort = null;
    }
    if (this.transportType === Transport.HTTP && this._sessionId && this._postUrl) {
      const sid = this._sessionId;
      const url = this._postUrl;
      fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } }).catch(() => {});
    }
    this._sessionId = null;
    this._postUrl = null;

    this.state = ConnectionState.PENDING;
    this._tools = [];
    this._resources = [];
    this._prompts = [];
    this.emit('stateChange', this.state);
  }

  /**
   * Attempt reconnection with exponential backoff.
   * @returns {Promise<boolean>} true if reconnection succeeded
   */
  async reconnect() {
    if (this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this._lastError = `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded`;
      this.state = ConnectionState.FAILED;
      this.emit('stateChange', this.state, this._lastError);
      return false;
    }

    this._reconnectAttempt++;
    const delay = RECONNECT_DELAY_MS * Math.pow(2, this._reconnectAttempt - 1);

    await new Promise(r => setTimeout(r, delay));

    try {
      await this.disconnect();
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  // ── Tool Operations ─────────────────────────────────────────────────────

  /**
   * List all tools exposed by this MCP server.
   * @returns {object[]} Array of tool definitions
   */
  listTools() {
    return this._tools.map(t => serializeTool(this.name, t));
  }

  /**
   * Call a tool on the MCP server.
   * @param {string} toolName - The tool name (original, not prefixed)
   * @param {object} [args={}] - Tool arguments
   * @returns {Promise<object>} Tool call result
   */
  async callTool(toolName, args = {}) {
    this._ensureConnected();

    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  /**
   * List resources exposed by this MCP server.
   * @returns {object[]}
   */
  listResources() {
    return this._resources;
  }

  /**
   * Read a resource's contents from this MCP server.
   * @param {string} uri - Resource URI (as advertised in resources/list)
   * @returns {Promise<object>} The resources/read result ({ contents: [...] })
   */
  async readResource(uri) {
    this._ensureConnected();
    return this._sendRequest('resources/read', { uri });
  }

  /**
   * List prompt templates exposed by this MCP server.
   * @returns {object[]}
   */
  listPrompts() {
    return this._prompts;
  }

  /**
   * Fetch a rendered prompt template from this MCP server.
   * @param {string} name - Prompt name
   * @param {object} [args={}] - Prompt arguments
   * @returns {Promise<object>} The prompts/get result ({ messages: [...] })
   */
  async getPrompt(name, args = {}) {
    this._ensureConnected();
    return this._sendRequest('prompts/get', { name, arguments: args });
  }

  /**
   * Get the server's instruction string (if provided during initialization).
   * @returns {string|null}
   */
  getInstructions() {
    return this.instructions;
  }

  /**
   * Get raw tool definitions (not serialized).
   * @returns {object[]}
   */
  get tools() {
    return this._tools;
  }

  /**
   * Get prompts exposed by this MCP server.
   * @returns {object[]}
   */
  get prompts() {
    return this._prompts;
  }

  /**
   * Build a connection snapshot for serialization.
   * @returns {object}
   */
  toConnectionObject() {
    return {
      name: this.name,
      type: this.state,
      config: this.config,
      capabilities: this.capabilities,
      serverInfo: this.serverInfo,
      instructions: this.instructions,
      tools: this._tools,
      resources: this._resources,
      error: this._lastError,
      reconnectAttempt: this._reconnectAttempt,
      maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    };
  }

  // ── Internal: Stdio Transport ───────────────────────────────────────────

  /** @private */
  async _connectStdio() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP server "${this.name}" connection timed out after ${this.connectTimeout}ms`));
      }, this.connectTimeout);

      try {
        const env = { ...process.env, ...(this.config.env || {}) };
        this._process = spawn(this.config.command, this.config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });

        // Detach the MCP server child (and its stdio pipes) from the parent's
        // event-loop keepalive. An MCP server is a long-lived helper subprocess:
        // while khy is running we talk to it, but it must never *keep the parent
        // alive on its own*. Without unref(), a process that has finished all its
        // own work (e.g. a unit-test runner, a one-shot CLI invocation) hangs
        // waiting on this persistent child + its stdio sockets instead of exiting.
        // unref() only affects keepalive accounting — the child stays fully usable
        // for the lifetime of the parent; explicit disconnect() still tears it down.
        try {
          this._process.unref?.();
          this._process.stdout?.unref?.();
          this._process.stderr?.unref?.();
          this._process.stdin?.unref?.();
        } catch { /* unref is best-effort; never let it break connect */ }

        // JSON-RPC line-delimited protocol on stdout
        this._readline = readline.createInterface({ input: this._process.stdout });
        this._readline.on('line', (line) => {
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);
          } catch { /* ignore non-JSON lines */ }
        });

        this._process.stderr.on('data', (data) => {
          const text = data.toString().trim();
          if (text) this._lastError = text;
        });

        // Fail-soft on a dead write sink. If the child exits during startup
        // (e.g. a broken launcher that exits 0 without ever serving), the next
        // stdin.write() surfaces its failure asynchronously as an 'error' event
        // on the stdin socket (commonly EPIPE). Without a listener that event is
        // unhandled and crashes the whole process. Capture it so the connection
        // fails via the timeout/exit path instead of taking khy down. The sync
        // `stdin.writable` guard in _writeRaw cannot catch this async case.
        if (this._process.stdin) {
          this._process.stdin.on('error', (err) => {
            this._lastError = `stdin write failed: ${err && err.message ? err.message : String(err)}`;
          });
        }

        this._process.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        this._process.on('exit', (code) => {
          if (this.state === ConnectionState.CONNECTING) {
            clearTimeout(timer);
            reject(new Error(`MCP server "${this.name}" exited with code ${code} during startup`));
          } else if (this.state === ConnectionState.CONNECTED) {
            this.state = ConnectionState.FAILED;
            this._lastError = `Process exited with code ${code}`;
            this.emit('stateChange', this.state, this._lastError);
            this.emit('unexpectedExit', code);
          }
        });

        // MCP initialize handshake
        this._sendRequest('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          clientInfo: {
            name: 'khy-os',
            version: _getVersion(),
          },
        }).then(async (result) => {
          clearTimeout(timer);

          // Extract server metadata
          this.capabilities = result.capabilities || {};
          this.serverInfo = result.serverInfo || null;
          this.instructions = result.instructions || null;

          // Send initialized notification
          this._sendNotification('notifications/initialized', {});

          // Fetch tools, resources, prompts in parallel (best-effort).
          await this._loadServerInventory();

          resolve();
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ── Internal: Streamable HTTP Transport ─────────────────────────────────

  /**
   * Connect over the modern Streamable HTTP transport (MCP 2025 spec): a single
   * POST endpoint that replies with either JSON or an SSE stream. The session id
   * returned on `initialize` is echoed on every later request.
   * @private
   */
  async _connectHttp() {
    this._postUrl = this.config.url;
    this._sessionId = null;

    const result = await this._sendRequestHttp('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'khy-os', version: _getVersion() },
    });

    this.capabilities = result?.capabilities || {};
    this.serverInfo = result?.serverInfo || null;
    this.instructions = result?.instructions || null;

    this._sendNotification('notifications/initialized', {});
    await this._loadServerInventory();
  }

  // ── Internal: Legacy SSE Transport ──────────────────────────────────────

  /**
   * Connect over the legacy HTTP+SSE transport (MCP 2024-11-05): open a GET
   * stream, wait for the server's `endpoint` event to learn the POST URL, then
   * drive the initialize handshake. Responses arrive asynchronously on the GET
   * stream and are routed through the shared pending-request map.
   * @private
   */
  async _connectSse() {
    const headers = {
      Accept: 'text/event-stream',
      ...(this.config.headers || {}),
    };
    const bearer = await this._resolveBearer();
    if (bearer && !headers.Authorization) headers.Authorization = `Bearer ${bearer}`;

    this._sseAbort = new AbortController();
    const endpointReady = _deferred();

    const res = await fetch(this.config.url, {
      method: 'GET',
      headers,
      signal: this._sseAbort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`MCP SSE connect failed: HTTP ${res.status}`);
    }

    // Pump the stream in the background; resolve endpointReady on first endpoint.
    this._pumpSseStream(res, endpointReady).catch((err) => {
      if (this.state === ConnectionState.CONNECTED) {
        this.state = ConnectionState.FAILED;
        this._lastError = err.message;
        this.emit('stateChange', this.state, err.message);
        this.emit('unexpectedExit', -1);
      }
      endpointReady.reject(err);
    });

    // Wait for the endpoint event (bounded by the connect timeout).
    const epTimer = setTimeout(
      () => endpointReady.reject(new Error(`MCP SSE "${this.name}" endpoint event timed out`)),
      this.connectTimeout,
    );
    try {
      await endpointReady.promise;
    } finally {
      clearTimeout(epTimer);
    }

    const result = await this._sendRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'khy-os', version: _getVersion() },
    });
    this.capabilities = result?.capabilities || {};
    this.serverInfo = result?.serverInfo || null;
    this.instructions = result?.instructions || null;

    this._sendNotification('notifications/initialized', {});
    await this._loadServerInventory();
  }

  /**
   * Read the legacy SSE GET stream line by line, dispatching `endpoint` events
   * (POST URL discovery) and `message` events (JSON-RPC frames → _handleMessage).
   * @private
   */
  async _pumpSseStream(res, endpointReady) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const { event, data } = _parseSseEvent(rawEvent);
        if (data == null) continue;

        if (event === 'endpoint') {
          // data is the (possibly relative) POST URL.
          try { this._postUrl = new URL(data, this.config.url).toString(); }
          catch { this._postUrl = data; }
          endpointReady.resolve();
          continue;
        }
        // Default event type is "message".
        let msg;
        try { msg = JSON.parse(data); } catch { continue; }
        this._handleMessage(msg);
      }
    }
  }

  // ── Internal: shared inventory load ─────────────────────────────────────

  /**
   * Fetch tools / resources / prompts after a successful handshake. Each list is
   * best-effort: a server that does not implement a capability simply yields [].
   * @private
   */
  async _loadServerInventory() {
    const [toolsResult, resourcesResult, promptsResult] = await Promise.allSettled([
      this._sendRequest('tools/list', {}),
      this._sendRequest('resources/list', {}),
      this._sendRequest('prompts/list', {}),
    ]);
    this._tools = toolsResult.status === 'fulfilled' ? (toolsResult.value?.tools || []) : [];
    this._resources = resourcesResult.status === 'fulfilled' ? (resourcesResult.value?.resources || []) : [];
    this._prompts = promptsResult.status === 'fulfilled' ? (promptsResult.value?.prompts || []) : [];
  }

  // ── Internal: JSON-RPC ──────────────────────────────────────────────────

  /**
   * Dispatch a JSON-RPC request over the active transport.
   * Streamable HTTP couples request/response in one fetch; stdio and legacy SSE
   * use the shared pending-request map fed by `_handleMessage`.
   * @private
   */
  _sendRequest(method, params) {
    if (this.transportType === Transport.HTTP) {
      return this._sendRequestHttp(method, params);
    }
    return this._sendRequestPending(method, params);
  }

  /**
   * Pending-map request model (stdio + legacy SSE): write the frame to the
   * transport's sink and resolve when a matching id arrives via _handleMessage.
   * @private
   */
  _sendRequestPending(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      this._pendingRequests.set(id, { resolve, reject, method });

      // Per-request timeout
      const timer = setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`MCP request "${method}" timed out after ${this.requestTimeout}ms`));
        }
      }, this.requestTimeout);
      const entry = this._pendingRequests.get(id);
      if (entry) entry._timer = timer;

      Promise.resolve(this._writeRaw(msg)).catch((err) => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * Streamable HTTP request model: POST the frame, then read the response from
   * either an `application/json` body or a `text/event-stream` reply, capturing
   * the session id on the way.
   * @private
   */
  async _sendRequestHttp(method, params) {
    const id = ++this._requestId;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers = await this._buildHttpHeaders();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeout);
    let res;
    try {
      res = await fetch(this._postUrl, { method: 'POST', headers, body, signal: ac.signal });
    } catch (err) {
      clearTimeout(timer);
      if (ac.signal.aborted) {
        throw new Error(`MCP request "${method}" timed out after ${this.requestTimeout}ms`);
      }
      throw err;
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) this._sessionId = sid;

    if (!res.ok) {
      clearTimeout(timer);
      const text = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status} for "${method}": ${text.slice(0, 200)}`);
    }

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    try {
      if (ctype.includes('text/event-stream')) {
        return await this._readSseResponse(res, id);
      }
      // 202 Accepted with empty body (e.g. server queued work) → no result.
      if (res.status === 204 || res.headers.get('content-length') === '0') return {};
      const json = await res.json();
      return this._unwrapRpc(json, id);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read a streamable-HTTP SSE reply until the JSON-RPC response with `id`
   * arrives. Server-initiated notifications interleaved on the stream are routed
   * through _handleMessage so list_changed events still take effect.
   * @private
   */
  async _readSseResponse(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const data = _parseSseData(rawEvent);
          if (data == null) continue;
          let msg;
          try { msg = JSON.parse(data); } catch { continue; }
          if (msg.id === id) {
            return this._unwrapRpc(msg, id);
          }
          // Unrelated server message (notification / other id): route it.
          this._handleMessage(msg);
        }
      }
    } finally {
      try { reader.cancel(); } catch { /* stream already closed */ }
    }
    throw new Error(`MCP HTTP stream closed before response to request ${id}`);
  }

  /** @private Throw on JSON-RPC error, else return the result object. */
  _unwrapRpc(msg, id) {
    if (msg && msg.error) {
      throw new Error(msg.error.message || `MCP error: code ${msg.error.code}`);
    }
    if (msg && msg.id === id) return msg.result;
    return msg && msg.result;
  }

  /** @private Build headers for a streamable-HTTP POST, including OAuth bearer. */
  async _buildHttpHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers || {}),
    };
    if (this._sessionId) headers['Mcp-Session-Id'] = this._sessionId;
    const bearer = await this._resolveBearer();
    if (bearer && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    return headers;
  }

  /**
   * Resolve a bearer token for this server: an explicit config.token wins,
   * otherwise consult the OAuth token store (auto-refreshes if expired).
   * @private
   */
  async _resolveBearer() {
    if (this.config.token) return this.config.token;
    try {
      const { getTokenStore } = require('./oauthTokenStore');
      const store = getTokenStore();
      return await store.getToken(this.name);
    } catch {
      return null;
    }
  }

  /**
   * Write a raw frame to the transport sink (stdio stdin / SSE POST endpoint).
   * @private
   * @returns {void|Promise<void>}
   */
  _writeRaw(str) {
    if (this.transportType === Transport.STDIO) {
      if (!this._process?.stdin?.writable) {
        throw new Error('Cannot send request: process stdin not writable');
      }
      this._process.stdin.write(str + '\n');
      return;
    }
    // Legacy SSE: POST the frame to the discovered endpoint; the response (or
    // ack) is delivered asynchronously on the open GET stream.
    return (async () => {
      const headers = await this._buildHttpHeaders();
      const res = await fetch(this._postUrl, { method: 'POST', headers, body: str });
      if (!res.ok && res.status !== 202) {
        const text = await res.text().catch(() => '');
        throw new Error(`MCP SSE POST ${res.status}: ${text.slice(0, 200)}`);
      }
    })();
  }

  /** @private */
  _sendNotification(method, params) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    try {
      const r = this._writeRaw(msg);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* notifications are best-effort */ }
  }

  /** @private */
  _handleMessage(msg) {
    // Response to a pending request
    if (msg.id != null && this._pendingRequests.has(msg.id)) {
      const entry = this._pendingRequests.get(msg.id);
      this._pendingRequests.delete(msg.id);
      if (entry._timer) clearTimeout(entry._timer);

      if (msg.error) {
        entry.reject(new Error(msg.error.message || `MCP error: code ${msg.error.code}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server-initiated notifications
    if (msg.method === 'notifications/tools/list_changed') {
      this._refreshTools();
    } else if (msg.method === 'notifications/resources/list_changed') {
      this._refreshResources();
    }
  }

  /** @private */
  async _refreshTools() {
    try {
      const result = await this._sendRequest('tools/list', {});
      this._tools = result.tools || [];
      this.emit('toolsChanged', this._tools);
    } catch { /* best effort */ }
  }

  /** @private */
  async _refreshResources() {
    try {
      const result = await this._sendRequest('resources/list', {});
      this._resources = result.resources || [];
      this.emit('resourcesChanged', this._resources);
    } catch { /* best effort */ }
  }

  /** @private */
  _ensureConnected() {
    if (this.state !== ConnectionState.CONNECTED) {
      throw new Error(`MCP server "${this.name}" is not connected (state: ${this.state})`);
    }
  }
}

// ── Connection Manager ──────────────────────────────────────────────────────

/** @type {Map<string, MCPClient>} */
const _connections = new Map();

/**
 * Load MCP config from disk. Checks project-local, user-level, and legacy paths.
 * @param {string} [projectDir] - Optional project directory for local config
 * @returns {object} Merged config with mcpServers map
 */
function loadConfig(projectDir) {
  const merged = { mcpServers: {} };

  // CC tool-marketplace bridge (gated, default ON): also reuse MCP servers that
  // Claude Code has configured (~/.claude.json user + projects[dir] maps, and
  // <projectDir>/.mcp.json). khy's MCP schema is byte-identical to CC's, so we
  // fold CC's entries straight in. Seeded FIRST → LOWEST priority: khy's own
  // config below overrides on name collision. OFF → this block is skipped and
  // the merge is byte-identical to the legacy khy-only chain.
  try {
    const ccBridge = require('./ccMcpBridge');
    if (ccBridge.isCcMcpBridgeEnabled()) {
      for (const src of ccBridge.ccMcpConfigSources({ homedir: os.homedir(), projectDir })) {
        try {
          if (!fs.existsSync(src.path)) continue;
          // Parse each source file, extract the mcpServers map per its shape.
          const raw = JSON.parse(fs.readFileSync(src.path, 'utf-8'));
          const servers = ccBridge.extractMcpServers(raw, src.kind, projectDir);
          for (const [name, cfg] of Object.entries(servers)) {
            merged.mcpServers[name] = { ...cfg, _scope: ConfigScope.USER, _configPath: src.path, _ccBridged: true };
          }
        } catch { /* skip malformed CC config */ }
      }
    }
  } catch { /* bridge unavailable → khy-only MCP discovery */ }

  // Load order: user < project (project overrides user)
  const paths = [
    { path: CONFIG_PATHS.user, scope: ConfigScope.USER },
    { path: CONFIG_PATHS.legacy, scope: ConfigScope.USER },
  ];

  if (projectDir) {
    paths.push({
      path: path.join(projectDir, '.khy', 'mcp.json'),
      scope: ConfigScope.LOCAL,
    });
    // Legacy project config
    paths.push({
      path: path.join(projectDir, '.khyquant', 'mcp.json'),
      scope: ConfigScope.LOCAL,
    });
  }

  for (const { path: configPath, scope } of paths) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Support both new format { mcpServers: {...} } and legacy { servers: [...] }
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        for (const [name, config] of Object.entries(raw.mcpServers)) {
          merged.mcpServers[name] = { ...config, _scope: scope, _configPath: configPath };
        }
      } else if (Array.isArray(raw.servers)) {
        // Legacy format: convert array to named map
        for (const serverConfig of raw.servers) {
          if (!serverConfig.name) continue;
          const { name, enabled, ...rest } = serverConfig;
          if (enabled === false) {
            merged.mcpServers[name] = { ...rest, _scope: scope, _disabled: true };
          } else {
            merged.mcpServers[name] = { ...rest, _scope: scope };
          }
        }
      }
    } catch { /* skip malformed config files */ }
  }

  return merged;
}

/**
 * Save MCP server config to the user-level config file.
 * @param {object} config - Full config object with mcpServers
 */
function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATHS.user);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Strip internal fields before saving
  const clean = { mcpServers: {} };
  for (const [name, serverConfig] of Object.entries(config.mcpServers || {})) {
    const { _scope, _configPath, _disabled, ...rest } = serverConfig;
    clean.mcpServers[name] = rest;
  }

  fs.writeFileSync(CONFIG_PATHS.user, JSON.stringify(clean, null, 2), 'utf-8');
}

/**
 * Connect to a single MCP server by name and config.
 * @param {string} name - Server name
 * @param {object} config - Server config
 * @param {object} [options] - Connection options
 * @returns {Promise<MCPClient>}
 */
async function connectMCPServer(name, config, options = {}) {
  // Disconnect existing connection for this name
  if (_connections.has(name)) {
    await disconnectMCPServer(name);
  }

  const client = new MCPClient(name, config, options);

  // Handle unexpected exits with auto-reconnect
  client.on('unexpectedExit', async () => {
    const reconnected = await client.reconnect();
    if (!reconnected) {
      _connections.delete(name);
    }
  });

  _connections.set(name, client);

  await client.connect();
  return client;
}

/**
 * Disconnect a single MCP server by name.
 * @param {string} name
 * @returns {Promise<void>}
 */
async function disconnectMCPServer(name) {
  const client = _connections.get(name);
  if (!client) return;

  await client.disconnect();
  _connections.delete(name);
}

/**
 * Connect to all configured MCP servers.
 * @param {string} [projectDir] - Optional project directory
 * @returns {Promise<{ connected: string[], failed: { name: string, error: string }[] }>}
 */
async function connectAll(projectDir) {
  const config = loadConfig(projectDir);
  const connected = [];
  const failed = [];

  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) return { connected, failed };

  // Connect in parallel
  const results = await Promise.allSettled(
    entries.map(async ([name, serverConfig]) => {
      if (serverConfig._disabled) {
        return { name, status: 'disabled' };
      }
      await connectMCPServer(name, serverConfig);
      return { name, status: 'connected' };
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 'connected') {
        connected.push(result.value.name);
      }
    } else {
      const name = entries[results.indexOf(result)]?.[0] || 'unknown';
      failed.push({ name, error: result.reason?.message || 'Unknown error' });
    }
  }

  return { connected, failed };
}

/**
 * Disconnect all MCP servers.
 * @returns {Promise<void>}
 */
async function disconnectAll() {
  const promises = [];
  for (const name of _connections.keys()) {
    promises.push(disconnectMCPServer(name));
  }
  await Promise.allSettled(promises);
}

/**
 * List all tools from all connected MCP servers.
 * @returns {object[]} Array of serialized tool definitions
 */
function listMCPTools() {
  const tools = [];
  for (const client of _connections.values()) {
    if (client.state === ConnectionState.CONNECTED) {
      tools.push(...client.listTools());
    }
  }
  return tools;
}

/**
 * Call a tool by its fully qualified name (mcp__serverName__toolName).
 * @param {string} qualifiedName - e.g., "mcp__filesystem__read_file"
 * @param {object} [args={}]
 * @returns {Promise<object>}
 */
async function callMCPTool(qualifiedName, args = {}) {
  const parts = qualifiedName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') {
    throw new Error(`Invalid MCP tool name: ${qualifiedName}. Expected format: mcp__serverName__toolName`);
  }

  const serverName = parts[1];
  const toolName = parts.slice(2).join('__'); // Tool name may contain __

  // Direct hit on the (possibly already-normalized) server key.
  let client = _connections.get(serverName);
  if (!client) {
    // The qualified name carries the NORMALIZED server segment, which may not
    // equal the raw connection key (e.g. "my.server" -> "my_server"). Fall back
    // to matching by normalized name, and recover the original tool name from
    // the resolved client's serialized tools so a normalized tool segment still
    // dispatches with the raw name the server expects.
    for (const [key, c] of _connections) {
      if (normalizeMcpName(key) === serverName) { client = c; break; }
    }
  }
  if (!client) {
    throw new Error(`MCP server "${serverName}" not found`);
  }

  // Map the (normalized) tool segment back to the server's original tool name.
  let originalToolName = toolName;
  if (typeof client.listTools === 'function') {
    const match = client.listTools().find((t) => t.name === qualifiedName);
    if (match && match.originalToolName != null) originalToolName = match.originalToolName;
  }

  return client.callTool(originalToolName, args);
}

/**
 * Resolve a connected client by its raw or normalized name.
 * @param {string} serverName
 * @returns {MCPClient|undefined}
 */
function _resolveClient(serverName) {
  let client = _connections.get(serverName);
  if (client) return client;
  for (const [key, c] of _connections) {
    if (normalizeMcpName(key) === serverName) return c;
  }
  return undefined;
}

/**
 * Convenience dispatch by separate server + tool name (used by MCPTool, whose
 * schema takes server_name and tool_name independently rather than a single
 * `mcp__server__tool` token).
 * @param {string} serverName
 * @param {string} toolName
 * @param {object} [args={}]
 * @returns {Promise<object>}
 */
async function callTool(serverName, toolName, args = {}) {
  const client = _resolveClient(serverName);
  if (!client) throw new Error(`MCP server "${serverName}" not found`);
  // Accept either the raw tool name or a serialized qualified name.
  let originalToolName = toolName;
  if (typeof client.listTools === 'function') {
    const match = client.listTools().find(
      (t) => t.name === toolName || t.originalToolName === toolName,
    );
    if (match && match.originalToolName != null) originalToolName = match.originalToolName;
  }
  return client.callTool(originalToolName, args);
}

/**
 * List resources across all connected servers, or a single server when named.
 * Each entry is tagged with its owning server for round-tripping to readResource.
 * @param {string} [serverName]
 * @returns {object[]}
 */
function listResources(serverName) {
  const out = [];
  const clients = serverName
    ? [_resolveClient(serverName)].filter(Boolean)
    : [..._connections.values()];
  for (const client of clients) {
    if (client.state !== ConnectionState.CONNECTED) continue;
    for (const r of client.listResources()) {
      out.push({ ...r, server: client.name });
    }
  }
  return out;
}

/**
 * Read a resource's contents from a named server.
 * @param {string} serverName
 * @param {string} uri
 * @returns {Promise<object>}
 */
async function readResource(serverName, uri) {
  const client = _resolveClient(serverName);
  if (!client) throw new Error(`MCP server "${serverName}" not found`);
  return client.readResource(uri);
}

/**
 * List prompt templates across all connected servers, or one named server.
 * @param {string} [serverName]
 * @returns {object[]}
 */
function listPrompts(serverName) {
  const out = [];
  const clients = serverName
    ? [_resolveClient(serverName)].filter(Boolean)
    : [..._connections.values()];
  for (const client of clients) {
    if (client.state !== ConnectionState.CONNECTED) continue;
    for (const p of client.listPrompts()) {
      out.push({ ...p, server: client.name });
    }
  }
  return out;
}

/**
 * Fetch a rendered prompt template from a named server.
 * @param {string} serverName
 * @param {string} name
 * @param {object} [args={}]
 * @returns {Promise<object>}
 */
async function getPrompt(serverName, name, args = {}) {
  const client = _resolveClient(serverName);
  if (!client) throw new Error(`MCP server "${serverName}" not found`);
  return client.getPrompt(name, args);
}

/**
 * Authenticate with a remote MCP server. Stores static credentials directly, or
 * runs an OAuth device/auth-code flow, persisting the result in the shared token
 * store so HTTP/SSE transports inject the bearer automatically.
 *
 * @param {string} serverName
 * @param {object} [opts]
 * @param {'oauth'|'device'|'api_key'|'token'} [opts.method='oauth']
 * @param {object} [opts.credentials]
 * @returns {Promise<object>} { method, expiresAt? } or a pending-flow descriptor
 */
async function authenticate(serverName, opts = {}) {
  const { getTokenStore } = require('./oauthTokenStore');
  const store = getTokenStore();
  const method = opts.method || 'oauth';
  const creds = opts.credentials || {};

  if (method === 'api_key' || method === 'token') {
    const accessToken = creds.token || creds.api_key || creds.apiKey;
    if (!accessToken) throw new Error(`authenticate(${serverName}): a token/api_key credential is required`);
    await store.store(serverName, {
      accessToken,
      tokenType: creds.tokenType || 'Bearer',
      expiresAt: creds.expiresAt || null,
    });
    return { method, stored: true };
  }

  if (method === 'device') {
    return store.startDeviceCodeFlow(serverName, creds);
  }

  // Default: authorization-code flow (returns an authorize URL + verifier).
  return store.startAuthCodeFlow(serverName, creds);
}

/**
 * Get all server instructions (for system prompt injection).
 * @returns {string[]} Array of instruction strings from connected servers
 */
function getMCPInstructions() {
  const instructions = [];
  for (const client of _connections.values()) {
    if (client.state === ConnectionState.CONNECTED && client.instructions) {
      instructions.push(`[MCP Server: ${client.name}]\n${client.instructions}`);
    }
  }
  return instructions;
}

/**
 * Get the current state of all connections.
 * @returns {object} MCPCliState
 */
function getState() {
  return buildCliState(_connections);
}

/**
 * Get a specific client by name.
 * @param {string} name
 * @returns {MCPClient|undefined}
 */
function getClient(name) {
  return _connections.get(name);
}

/**
 * Get all connected client names.
 * @returns {string[]}
 */
function getConnectedServers() {
  const names = [];
  for (const [name, client] of _connections) {
    if (client.state === ConnectionState.CONNECTED) {
      names.push(name);
    }
  }
  return names;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

function _getVersion() {
  try {
    return require('../../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

/** A promise plus its resolve/reject handles, for cross-callback signalling. */
function _deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Parse one raw SSE event block ("event:"/"data:" lines separated by \n) into
 * its event type and concatenated data payload.
 * @param {string} raw
 * @returns {{ event: string, data: string|null }}
 */
function _parseSseEvent(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  return { event, data: dataLines.length ? dataLines.join('\n') : null };
}

/** Extract just the data payload from an SSE event block. */
function _parseSseData(raw) {
  return _parseSseEvent(raw).data;
}

module.exports = {
  // Core class
  MCPClient,

  // Connection management
  connectMCPServer,
  disconnectMCPServer,
  connectAll,
  disconnectAll,

  // Tool operations
  listMCPTools,
  callMCPTool,
  callTool,

  // Resources & prompts
  listResources,
  readResource,
  listPrompts,
  getPrompt,

  // Authentication
  authenticate,

  // State & instructions
  getMCPInstructions,
  getState,
  getClient,
  getConnectedServers,

  // Config
  loadConfig,
  saveConfig,

  // Re-export types
  Transport,
  ConnectionState,
  ConfigScope,
};
