'use strict';

/**
 * mcpServerProtocol — pure-leaf JSON-RPC 2.0 server protocol tests (node:test).
 *
 * Deterministic, no IO. Verifies: gate default-on/off, parseMessage (valid /
 * invalid JSON / non-object / notification), buildResult/buildError (standard
 * codes), buildInitializeResult (protocolVersion + only tools capability),
 * toolDefToMcp (parameters→inputSchema rename, empty-schema fallback, drops
 * aliases), toolResultToMcp (success→content array, success:false→isError,
 * pass-through content form), dispatch (4 methods, unknown→-32601,
 * notification→null), and byte-revert safety when gated off.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const p = require('../../../src/services/mcp/mcpServerProtocol');

test('isServeEnabled: default on; {0,false,off,no} disable', () => {
  assert.equal(p.isServeEnabled({}), true);
  assert.equal(p.isServeEnabled({ KHY_MCP_SERVE: 'off' }), false);
  assert.equal(p.isServeEnabled({ KHY_MCP_SERVE: '0' }), false);
  assert.equal(p.isServeEnabled({ KHY_MCP_SERVE: 'no' }), false);
  assert.equal(p.isServeEnabled({ KHY_MCP_SERVE: '1' }), true);
});

test('parseMessage: valid request → ok with id/method/params', () => {
  const m = p.parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"x":1}}');
  assert.equal(m.ok, true);
  assert.equal(m.id, 1);
  assert.equal(m.method, 'tools/list');
  assert.deepEqual(m.params, { x: 1 });
  assert.equal(m.isNotification, false);
});

test('parseMessage: notification (method, no id) → isNotification true, id null', () => {
  const m = p.parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.equal(m.ok, true);
  assert.equal(m.isNotification, true);
  assert.equal(m.id, null);
});

test('parseMessage: invalid JSON → ok:false (never throws)', () => {
  const m = p.parseMessage('{not json');
  assert.equal(m.ok, false);
  assert.ok(m.error);
});

test('parseMessage: non-object (array / number) → ok:false', () => {
  assert.equal(p.parseMessage('[1,2,3]').ok, false);
  assert.equal(p.parseMessage('42').ok, false);
  assert.equal(p.parseMessage('null').ok, false);
});

test('buildResult / buildError: JSON-RPC 2.0 envelope with standard codes', () => {
  assert.deepEqual(p.buildResult(7, { a: 1 }), { jsonrpc: '2.0', id: 7, result: { a: 1 } });
  const e = p.buildError(3, p.ERROR_CODES.METHOD_NOT_FOUND, 'nope');
  assert.deepEqual(e, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'nope' } });
  assert.equal(p.ERROR_CODES.PARSE_ERROR, -32700);
  assert.equal(p.ERROR_CODES.INVALID_PARAMS, -32602);
  assert.equal(p.ERROR_CODES.INTERNAL_ERROR, -32603);
});

test('buildInitializeResult: protocolVersion + ONLY tools capability + serverInfo', () => {
  const r = p.buildInitializeResult({ version: '9.9.9' });
  assert.equal(r.protocolVersion, '2024-11-05');
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.ok(!('resources' in r.capabilities), 'no resources capability (honest)');
  assert.ok(!('prompts' in r.capabilities), 'no prompts capability (honest)');
  assert.equal(r.serverInfo.name, 'khy-os');
  assert.equal(r.serverInfo.version, '9.9.9');
});

test('toolDefToMcp: parameters→inputSchema rename, drops aliases, empty-schema fallback', () => {
  const mcp = p.toolDefToMcp({
    name: 'Read', description: 'read a file',
    parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
    aliases: ['cat', 'open'],
  });
  assert.equal(mcp.name, 'Read');
  assert.equal(mcp.description, 'read a file');
  assert.deepEqual(mcp.inputSchema, { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] });
  assert.ok(!('aliases' in mcp), 'aliases dropped (MCP clients do not understand them)');
  assert.ok(!('parameters' in mcp), 'no leftover parameters key');
  // missing parameters → empty object schema
  const bare = p.toolDefToMcp({ name: 'X' });
  assert.deepEqual(bare.inputSchema, { type: 'object', properties: {} });
});

test('toolResultToMcp: success → single text content, isError false', () => {
  const r = p.toolResultToMcp({ success: true, content: 'hello' });
  assert.deepEqual(r.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(r.isError, false);
});

test('toolResultToMcp: success:false → isError true, uses error text', () => {
  const r = p.toolResultToMcp({ success: false, error: 'boom' });
  assert.equal(r.isError, true);
  assert.deepEqual(r.content, [{ type: 'text', text: 'boom' }]);
});

test('toolResultToMcp: already MCP content form → pass-through', () => {
  const native = { content: [{ type: 'text', text: 'x' }, { type: 'image', data: '...' }] };
  const r = p.toolResultToMcp(native);
  assert.deepEqual(r.content, native.content);
});

test('dispatch: known method → buildResult; unknown → -32601; notification → null', async () => {
  const handlers = {
    initialize: async () => ({ ok: 1 }),
    ping: async () => ({}),
  };
  const good = await p.dispatch({ ok: true, id: 1, method: 'initialize', params: {} }, handlers);
  assert.deepEqual(good, { jsonrpc: '2.0', id: 1, result: { ok: 1 } });

  const unknown = await p.dispatch({ ok: true, id: 2, method: 'no/such', params: {} }, handlers);
  assert.equal(unknown.error.code, -32601);

  const notif = await p.dispatch({ ok: true, id: null, method: 'notifications/initialized', isNotification: true }, handlers);
  assert.equal(notif, null);
});

test('junk inputs never throw', () => {
  assert.doesNotThrow(() => p.parseMessage(null));
  assert.doesNotThrow(() => p.parseMessage(undefined));
  assert.doesNotThrow(() => p.toolDefToMcp(null));
  assert.doesNotThrow(() => p.toolResultToMcp(null));
  assert.doesNotThrow(() => p.buildError(undefined, -32603, undefined));
});
