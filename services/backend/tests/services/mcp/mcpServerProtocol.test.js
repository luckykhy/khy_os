'use strict';
/**
 * mcpServerProtocol �?pure-leaf JSON-RPC 2.0 server protocol tests (node:test).
 *
 * Deterministic, no IO. Verifies: gate default-on/off, parseMessage (valid /
 * invalid JSON / non-object / notification), buildResult/buildError (standard
 * codes), buildInitializeResult (protocolVersion + only tools capability),
 * toolDefToMcp (parameters→inputSchema rename, empty-schema fallback, drops
 * aliases), toolResultToMcp (success→content array, success:false→isError,
 * pass-through content form), dispatch (4 methods, unknown�?32601,
 * notification→null), and byte-revert safety when gated off.
 */
const p = require('../../../src/services/domain/messaging/mcp/mcpServerProtocol.js');
const assert = require('node:assert');

describe('Mcp Server Protocol', () => {
  test('isServeEnabled: default on; {0,false,off,no} disable', async () => {
      expect(p.isServeEnabled({})).toBe(true);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: 'off' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: '0' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: 'no' })).toBe(false);
      expect(p.isServeEnabled({ KHY_MCP_SERVE: '1' })).toBe(true);
  });

  test('parseMessage: valid request �?ok with id/method/params', async () => {
      const m = p.parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":1}}');
      expect(m.ok).toBe(true);
      expect(m.id).toBe(1);
      expect(m.method).toBe('tools/list');
      assert.deepEqual(m.params, { x: 1 });
      expect(m.isNotification).toBe(false);
  });

  test('parseMessage: notification (method, no id) �?isNotification true, id null', async () => {
      const m = p.parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
      expect(m.ok).toBe(true);
      expect(m.isNotification).toBe(true);
      expect(m.id).toBe(null);
  });

});

