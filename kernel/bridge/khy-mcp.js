#!/usr/bin/env node
/* khy-mcp.js — expose KHY-OS to an external agent over MCP (requirement 1, side b).
 *
 * An external agent such as Claude Code connects to the OS by speaking the Model
 * Context Protocol to this server. The server owns one KhyBridge and publishes
 * the shared tool surface (khy-tools.js) — the very same handlers the built-in
 * agent calls in-process — so external and built-in agents drive the OS through
 * one implementation, no protocol logic duplicated.
 *
 * Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout. We use
 * only Node stdlib (no MCP SDK) to keep the bridge dependency-free and loosely
 * coupled: the server is a plain process the agent host spawns. Diagnostics go
 * to stderr; stdout carries protocol bytes only.
 *
 * Run directly:  KHY_COM2_SOCK=/tmp/khy-agent.sock node bridge/khy-mcp.js
 *           or:  node bridge/khy-mcp.js --socket /tmp/khy-agent.sock
 * In an MCP client config, register this command with that env/arg.
 */
'use strict';

const fs = require('fs');
const readline = require('readline');
const { KhyBridge } = require('./khy-bridge');
const { makeTools } = require('./khy-tools');

const SERVER_INFO = { name: 'khy-os', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2024-11-05';

/* Serve MCP over a pair of streams using the given tool descriptors. Decoupled
 * from process stdio so it is unit-testable with arbitrary streams. */
class KhyMcpServer {
  constructor(tools, { input, output, log } = {}) {
    this.tools = tools;
    this.input = input || process.stdin;
    this.output = output || process.stdout;
    this.log = log || ((m) => process.stderr.write(`[khy-mcp] ${m}\n`));
    this._rl = null;
  }

  start() {
    this._rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this._rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_e) {
        this.log(`dropping non-JSON line (${text.length} bytes)`);
        return; // never let a bad line desync the protocol
      }
      this._dispatch(msg);
    });
    return this;
  }

  _write(obj) {
    this.output.write(`${JSON.stringify(obj)}\n`);
  }

  _reply(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  _error(id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async _dispatch(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;

    // Notifications (no id): acknowledge by doing nothing observable.
    if (!isRequest) {
      return; // e.g. notifications/initialized, notifications/cancelled
    }

    try {
      switch (method) {
        case 'initialize':
          this._reply(id, {
            protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          });
          return;
        case 'ping':
          this._reply(id, {});
          return;
        case 'tools/list':
          this._reply(id, {
            tools: this.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
          return;
        case 'tools/call':
          await this._callTool(id, params || {});
          return;
        default:
          this._error(id, -32601, `method not found: ${method}`);
          return;
      }
    } catch (e) {
      this._error(id, -32603, `internal error: ${e && e.message ? e.message : e}`);
    }
  }

  async _callTool(id, params) {
    const tool = this.tools.find((t) => t.name === params.name);
    if (!tool) {
      this._error(id, -32602, `unknown tool: ${params.name}`);
      return;
    }
    try {
      const result = await tool.handler(params.arguments || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      this._reply(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      // A tool failure is reported in-band (isError) per MCP, not as a JSON-RPC error.
      this._reply(id, {
        content: [{ type: 'text', text: `${tool.name} failed: ${e && e.message ? e.message : e}` }],
        isError: true,
      });
    }
  }

  stop() {
    if (this._rl) this._rl.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Connect the bridge, tolerating an MCP client that spawns us before the OS is
 * up: wait (bounded) for the socket to appear, then retry connect until the
 * deadline. KHY_MCP_CONNECT_TIMEOUT_MS bounds the whole wait (0 = single try). */
async function connectWithWait(socketPath, log) {
  const timeoutMs = Number(process.env.KHY_MCP_CONNECT_TIMEOUT_MS || 30000);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let announced = false;
  for (;;) {
    if (fs.existsSync(socketPath)) {
      try {
        const bridge = new KhyBridge({ socketPath });
        await bridge.connect();
        return bridge;
      } catch (e) {
        if (Date.now() >= deadline) throw e;
      }
    } else if (!announced) {
      log(`waiting for COM2 socket ${socketPath} (start the OS, e.g. make -C kernel run-agent)`);
      announced = true;
    }
    if (Date.now() >= deadline) {
      throw new Error(`COM2 socket ${socketPath} never became connectable within ${timeoutMs}ms`);
    }
    await sleep(250);
  }
}

/* Entry point when spawned by an MCP client. */
async function main() {
  const argv = process.argv.slice(2);
  let socketPath = process.env.KHY_COM2_SOCK || null;
  const si = argv.indexOf('--socket');
  if (si >= 0 && argv[si + 1]) socketPath = argv[si + 1];
  if (!socketPath) {
    process.stderr.write('[khy-mcp] no COM2 socket: set KHY_COM2_SOCK or pass --socket <path>\n');
    process.exit(2);
  }

  const log = (m) => process.stderr.write(`[khy-mcp] ${m}\n`);
  const bridge = await connectWithWait(socketPath, log);
  log(`attached to ${socketPath}; serving MCP on stdio`);
  const server = new KhyMcpServer(makeTools(bridge)).start();

  const shutdown = () => { server.stop(); bridge.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('close', shutdown);
}

module.exports = { KhyMcpServer, SERVER_INFO };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[khy-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
