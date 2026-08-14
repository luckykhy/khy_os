#!/usr/bin/env node
/* agentbus_dualagent_test.js — end-to-end verification of stage A7b: both the
 * built-in KHY agent (in-process) and an external agent (over MCP) connect to
 * the same OS through the same KhyBridge (requirement 1).
 *
 * Phase 1 — built-in agent (khy-agent.js, in-process):
 *   start KhyAgent on COM2; it serves the decision plane with the default brain.
 *   Driving the shell on COM1 proves the brain answers both planes:
 *     - `ai use model claude-opus` -> brain returns SET -> config persisted
 *     - `agentask delete everything` -> brain returns DENY (destructive)
 *     - `agentask may I proceed?`   -> brain returns ALLOW
 *   and the agent's in-process tool calls (khy_list / khy_get_config) drive the
 *   control plane directly.
 *
 * Phase 2 — external agent over MCP (khy-mcp.js, spawned as a subprocess):
 *   after the built-in agent detaches, spawn the MCP server pointed at the same
 *   COM2 socket and speak real MCP JSON-RPC over its stdio (exactly what Claude
 *   Code does): initialize, tools/list, tools/call. The external agent writes
 *   and reads files and sees the very config the built-in agent persisted —
 *   same OS, same bridge, no duplicated protocol.
 *
 * Needs a disk (config persistence): QEMU gets a fresh -hda image. COM1 is a
 * unix socket (drive the shell, kept drained); COM2 is the agent channel.
 *
 * Usage:  node kernel/tools/agentbus_dualagent_test.js
 * Exit:   0 = all checks pass, non-zero = failure.
 */
'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { KhyAgent } = require('../bridge');

const KERNEL_DIR = path.resolve(__dirname, '..');
const ISO = path.join(KERNEL_DIR, 'build', 'khy-os-kernel.iso');
const DISK = path.join(KERNEL_DIR, 'build', 'khy-a7b-disk.img');
const MCP = path.join(KERNEL_DIR, 'bridge', 'khy-mcp.js');
const COM1_SOCK = '/tmp/khy-agent-a7b-com1.sock';
const COM2_SOCK = '/tmp/khy-agent-a7b-com2.sock';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rm(p) { try { fs.unlinkSync(p); } catch (_e) { /* ignore */ } }

class Com1 {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (c) => { this.buf = Buffer.concat([this.buf, c]); });
  }
  text() { return this.buf.toString('utf8'); }
  send(line) { this.sock.write(line); }
  async waitFor(needle, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.text().includes(needle)) return true;
      await sleep(50);
    }
    return false;
  }
}

/* Minimal MCP client: newline-delimited JSON-RPC over the server's stdio. */
class McpClient {
  constructor(child) {
    this.child = child;
    this.id = 0;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let m;
      try { m = JSON.parse(t); } catch (_e) { return; }
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
    });
  }
  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  request(method, params, timeoutMs = 6000) {
    const id = ++this.id;
    const p = new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} timed out`)); }
      }, timeoutMs);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return p;
  }
  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} });
    return r;
  }
}
const toolText = (r) => (r && r.content && r.content[0] ? r.content[0].text : '');

let passes = 0;
let fails = 0;
function check(ok, msg) {
  if (ok) { passes++; console.log(`[PASS] ${msg}`); }
  else { fails++; console.log(`[FAIL] ${msg}`); }
}

async function main() {
  if (!fs.existsSync(ISO)) {
    console.log(`[FAIL] ISO not found: ${ISO} (run \`make\` first)`);
    return 2;
  }
  rm(COM1_SOCK); rm(COM2_SOCK);
  rm(DISK);
  fs.writeFileSync(DISK, Buffer.alloc(16 * 1024 * 1024));

  const qemu = spawn('qemu-system-x86_64', [
    '-cdrom', ISO,
    '-hda', DISK,
    '-serial', `unix:${COM1_SOCK},server,nowait`,
    '-serial', `unix:${COM2_SOCK},server,nowait`,
    '-display', 'none', '-no-reboot',
  ], { stdio: 'ignore' });

  let agent = null;
  let com1sock = null;
  let mcpChild = null;
  try {
    const deadline = Date.now() + 15000;
    while (!(fs.existsSync(COM1_SOCK) && fs.existsSync(COM2_SOCK))) {
      if (Date.now() > deadline || qemu.exitCode !== null) {
        console.log('[FAIL] serial sockets never appeared / QEMU exited');
        return 3;
      }
      await sleep(100);
    }

    com1sock = net.createConnection(COM1_SOCK);
    await new Promise((res, rej) => { com1sock.once('connect', res); com1sock.once('error', rej); });
    const com1 = new Com1(com1sock);
    await com1.waitFor('khy>', 9000);

    // ── Phase 1: built-in agent, in-process ─────────────────────────────────
    agent = await new KhyAgent({ socketPath: COM2_SOCK, requestTimeoutMs: 6000 }).start();
    check(true, 'built-in KhyAgent started and attached to COM2');

    com1.send('ai use model claude-opus\n');
    const set1 = await com1.waitFor('[ai] set model = claude-opus', 8000);
    check(set1, 'built-in agent (NL brain): ai use model -> shell set model = claude-opus');

    com1.send('agentask delete everything\n');
    const denied = await com1.waitFor('decision: DENY', 8000);
    check(denied, 'built-in agent (generic brain): destructive request -> decision: DENY');

    com1.send('agentask may I proceed?\n');
    const allowed = await com1.waitFor('decision: ALLOW', 8000);
    check(allowed, 'built-in agent (generic brain): benign request -> decision: ALLOW');

    // In-process tool calls (same surface the external agent uses over MCP).
    const root = await agent.call('khy_list', { path: '/' });
    check(Array.isArray(root) && root.some((e) => e.name === 'bin'),
      `built-in agent in-process khy_list('/') -> ${root.length} entries`);
    const cfgInProc = await agent.call('khy_get_config', {});
    check(cfgInProc.model === 'claude-opus',
      `built-in agent in-process khy_get_config -> model=${cfgInProc.model}`);

    // Detach the built-in agent so the external one can take the channel.
    agent.stop();
    agent = null;
    await sleep(500);

    // ── Phase 2: external agent over MCP (subprocess) ───────────────────────
    mcpChild = spawn('node', [MCP, '--socket', COM2_SOCK], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    await sleep(500); // let it connect the bridge
    const mcp = new McpClient(mcpChild);

    const init = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-external-agent', version: '0.0.0' },
    });
    check(init && init.serverInfo && init.serverInfo.name === 'khy-os',
      `MCP initialize -> serverInfo.name=${init && init.serverInfo && init.serverInfo.name}`);
    mcp.notify('notifications/initialized', {});

    const list = await mcp.request('tools/list', {});
    const names = new Set((list.tools || []).map((t) => t.name));
    const want = ['khy_list', 'khy_stat', 'khy_read', 'khy_write', 'khy_ps', 'khy_get_config'];
    check(want.every((n) => names.has(n)),
      `MCP tools/list -> ${[...names].join(',')}`);

    const wr = await mcp.callTool('khy_write', { path: '/tmp/mcp.txt', data: 'written by external agent\n' });
    check(!wr.isError && /\d/.test(toolText(wr)),
      `MCP tools/call khy_write -> ${toolText(wr)} bytes`);

    const rd = await mcp.callTool('khy_read', { path: '/tmp/mcp.txt' });
    check(!rd.isError && toolText(rd) === 'written by external agent\n',
      'MCP tools/call khy_read -> round-trips the external agent\'s own write');

    // The external agent sees the config the BUILT-IN agent persisted earlier.
    const cfg = await mcp.callTool('khy_get_config', {});
    check(!cfg.isError && JSON.parse(toolText(cfg)).model === 'claude-opus',
      `MCP tools/call khy_get_config -> ${toolText(cfg)} (same OS state as built-in agent)`);

    const ps = await mcp.callTool('khy_ps', {});
    check(!ps.isError && JSON.parse(toolText(ps)).some((p) => p.name === 'agent-bridge'),
      'MCP tools/call khy_ps -> process table incl. agent-bridge (external agent drives control plane)');

    console.log(`\n${passes} passed, ${fails} failed`);
    return fails === 0 ? 0 : 1;
  } finally {
    if (agent) agent.stop();
    if (mcpChild) mcpChild.kill('SIGTERM');
    if (com1sock) com1sock.destroy();
    qemu.kill('SIGTERM');
    await sleep(300);
    if (qemu.exitCode === null) qemu.kill('SIGKILL');
    rm(COM1_SOCK); rm(COM2_SOCK);
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[FAIL] uncaught:', err);
  process.exit(1);
});
