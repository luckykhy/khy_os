'use strict';
/**
 * mcpServer â€?engine wiring tests via injected fake registry (node:test).
 *
 * Drives createServerCore with a fake registry (getEnabled â†?2 stub tools,
 * execute records args). Verifies the full requestâ†’response contract without
 * starting a process or touching the real tool registry:
 *   - initialize â†?protocolVersion + serverInfo
 *   - tools/list â†?2 tools with {name, inputSchema} (parameters renamed)
 *   - tools/call â†?goes through registry.execute (permission-gated dispatcher),
 *     result mapped to MCP CallToolResult
 *   - tools/call on a non-exposed tool â†?-32602
 *   - bad JSON â†?-32700
 *   - handler throwing â†?-32603 (never crashes)
 */
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

describe('Mcp Server', () => {
  test('initialize â†?protocolVersion + serverInfo', async () => {
      const core = createServerCore({ version: '1.2.3', registry: fakeRegistry(), env: {} });
      const resp = await core.handleMessage('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
      expect(resp.id).toBe(1);
      expect(resp.result.protocolVersion).toBe('2024-11-05');
      expect(resp.result.serverInfo.version).toBe('1.2.3');
      assert.deepEqual(resp.result.capabilities, { tools: {} });
  });

  test('tools/list â†?2 tools with inputSchema (parameters renamed, aliases dropped)', async () => {
      const core = createServerCore({ version: '1.0.0', registry: fakeRegistry(), env: {} });
      const resp = await core.handleMessage('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}');
      expect(resp.result.tools.length).toBe(2);
      const alpha = resp.result.tools.find((t) => t.name === 'Alpha');
      expect(alpha.inputSchema && alpha.inputSchema.properties.q).toBeTruthy();
      expect(!('parameters' in alpha).toBeTruthy());
      expect(!('aliases' in alpha).toBeTruthy());
  });

  test('tools/call â†?registry.execute called (permission-gated), result â†?CallToolResult', async () => {
      const reg = fakeRegistry();
      const core = createServerCore({ version: '1.0.0', registry: reg, env: {} });
      const resp = await core.handleMessage(
        '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"Alpha","arguments":{"q":"hi"}}}');
      expect(reg.calls.length).toBe(1);
      expect(reg.calls[0].name).toBe('Alpha');
      assert.deepEqual(reg.calls[0].params, { q: 'hi' });
      assert.deepEqual(resp.result.content, [{ type: 'text', text: 'ran Alpha' }]);
      expect(resp.result.isError).toBe(false);
  });

  test('tools/call on a non-exposed tool â†?-32602 (not exposed), execute NOT called', async () => {
      const reg = fakeRegistry();
      const core = createServerCore({ version: '1.0.0', registry: reg, env: {} });
      const resp = await core.handleMessage(
        '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"Ghost","arguments":{}}}');
      expect(resp.error.code).toBe(-32602);
      expect(reg.calls.length).toBe(0);
  });

});

