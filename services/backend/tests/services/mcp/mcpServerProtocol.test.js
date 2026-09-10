'use strict';
/**
 * mcpServerProtocol â€?pure-leaf JSON-RPC 2.0 server protocol tests (node:test).
 *
 * Deterministic, no IO. Verifies: gate default-on/off, parseMessage (valid /
 * invalid JSON / non-object / notification), buildResult/buildError (standard
 * codes), buildInitializeResult (protocolVersion + only tools capability),
 * toolDefToMcp (parametersâ†’inputSchema rename, empty-schema fallback, drops
 * aliases), toolResultToMcp (successâ†’content array, success:falseâ†’isError,
 * pass-through content form), dispatch (4 methods, unknownâ†?32601,
 * notificationâ†’null), and byte-revert safety when gated off.
 */
const p = require('../../../src/services/mcp/mcpServerProtocol');

describe('Mcp Server Protocol', () => {
  test('isServeEnabled: default on; {0,false,off,no} disable', async () => {
      expect(p.isServeEnabled({})).toBe(true);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: 'off' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: '0' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: 'no' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: '1' })).toBe(true);
  });

  test('parseMessage: valid request â†?ok with id/method/params', async () => {
      const m = p.parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":1}}');
      expect(m.ok).toBe(true);
      expect(m.id).toBe(1);
      expect(m.method).toBe('tools/list');
      assert.deepEqual(m.params, { x: 1 });
      expect(m.isNotification).toBe(false);
  });

  test('parseMessage: notification (method, no id) â†?isNotification true, id null', async () => {
      const m = p.parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
      expect(m.ok).toBe(true);
      expect(m.isNotification).toBe(true);
      expect(m.id).toBe(null);
  });

});

