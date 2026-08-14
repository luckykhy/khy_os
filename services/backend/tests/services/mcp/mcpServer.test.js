'use strict';

/**
 * mcpServer — engine wiring tests via injected fake registry (node:test).
 *
 * Drives createServerCore with a fake registry (getEnabled → 2 stub tools,
 * execute records args). Verifies the full request→response contract without
 * starting a process or touching the real tool registry:
 *   - initialize → protocolVersion + serverInfo
 *   - tools/list → 2 tools with {name, inputSchema} (parameters renamed)
 *   - tools/call → goes through registry.execute (permission-gated dispatcher),
 *     result mapped to MCP CallToolResult
 *   - tools/call on a non-exposed tool → -32602
 *   - bad JSON → -32700
 *   - handler throwing → -32603 (never crashes)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createServerCore } = require('../../../src/services/mcp/mcpServer');

function stubTool(name) {
  return {
    name,
    risk: 'safe',
    isReadOnly: () => true,
    isDestructive: () => false,
    toFunctionDef: () => ({
      name,
      description: `stub ${name}`,
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      aliases: ['x'],
    }),
  };
}

function fakeRegistry() {
  const calls = [];
  const tools = new Map([['Alpha', stubTool('Alpha')], ['Beta', stubTool('Beta')]]);
  return {
    calls,
    loadTools() { /* no-op */ },
    getEnabled() { return tools; },
    async execute(name, params, ctx) {
      calls.push({ name, params, ctx });
      return { success: true, content: `ran ${name}` };
    },
  };
}

test('initialize → protocolVersion + serverInfo', async () => {
  const core = createServerCore({ version: '1.2.3', registry: fakeRegistry(), env: {} });
  const resp = await core.handleMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
  assert.equal(resp.id, 1);
  assert.equal(resp.result.protocolVersion, '2024-11-05');
  assert.equal(resp.result.serverInfo.version, '1.2.3');
  assert.deepEqual(resp.result.capabilities, { tools: {} });
});

test('tools/list → 2 tools with inputSchema (parameters renamed, aliases dropped)', async () => {
  const core = createServerCore({ version: '1.0.0', registry: fakeRegistry(), env: {} });
  const resp = await core.handleMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
  assert.equal(resp.result.tools.length, 2);
  const alpha = resp.result.tools.find((t) => t.name === 'Alpha');
  assert.ok(alpha.inputSchema && alpha.inputSchema.properties.q);
  assert.ok(!('parameters' in alpha));
  assert.ok(!('aliases' in alpha));
});

test('tools/call → registry.execute called (permission-gated), result → CallToolResult', async () => {
  const reg = fakeRegistry();
  const core = createServerCore({ version: '1.0.0', registry: reg, env: {} });
  const resp = await core.handleMessage(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Alpha","arguments":{"q":"hi"}}}');
  assert.equal(reg.calls.length, 1);
  assert.equal(reg.calls[0].name, 'Alpha');
  assert.deepEqual(reg.calls[0].params, { q: 'hi' });
  assert.deepEqual(resp.result.content, [{ type: 'text', text: 'ran Alpha' }]);
  assert.equal(resp.result.isError, false);
});

test('tools/call on a non-exposed tool → -32602 (not exposed), execute NOT called', async () => {
  const reg = fakeRegistry();
  const core = createServerCore({ version: '1.0.0', registry: reg, env: {} });
  const resp = await core.handleMessage(
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"Ghost","arguments":{}}}');
  assert.equal(resp.error.code, -32602);
  assert.equal(reg.calls.length, 0);
});

test('bad JSON → -32700 parse error (never crashes)', async () => {
  const core = createServerCore({ version: '1.0.0', registry: fakeRegistry(), env: {} });
  const resp = await core.handleMessage('{not json');
  assert.equal(resp.error.code, -32700);
});

test('registry.execute throwing → -32603 internal error (server survives)', async () => {
  const reg = fakeRegistry();
  reg.execute = async () => { throw new Error('kaboom'); };
  const core = createServerCore({ version: '1.0.0', registry: reg, env: {} });
  const resp = await core.handleMessage(
    '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"Alpha","arguments":{}}}');
  assert.equal(resp.error.code, -32603);
  assert.match(resp.error.message, /kaboom/);
});

test('notification (no id) → null (no response)', async () => {
  const core = createServerCore({ version: '1.0.0', registry: fakeRegistry(), env: {} });
  const resp = await core.handleMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.equal(resp, null);
});

test('readonly expose mode gates tools/list via env', async () => {
  // Beta stub is readonly=true in this fixture, so readonly keeps both — assert
  // that resolveExposeMode is honoured by using a registry whose second tool is a writer.
  const calls = [];
  const writer = {
    name: 'Writer', risk: 'high', isReadOnly: () => false, isDestructive: () => true,
    toFunctionDef: () => ({ name: 'Writer', description: 'w', parameters: { type: 'object', properties: {} } }),
  };
  const reg = {
    calls,
    loadTools() {},
    getEnabled() { return new Map([['Alpha', stubTool('Alpha')], ['Writer', writer]]); },
    async execute() { return { success: true, content: 'x' }; },
  };
  const core = createServerCore({ version: '1.0.0', registry: reg, env: { KHY_MCP_SERVE_EXPOSE: 'readonly' } });
  const resp = await core.handleMessage('{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{}}');
  const names = resp.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['Alpha'], 'writer excluded in readonly mode');
});
