'use strict';

/**
 * Tests for the remote MCP transports + manager facade added to complete the
 * MCP tool system:
 *
 *   1. Streamable HTTP transport (MCP 2025 spec): initialize handshake, session
 *      id capture/echo, inventory load, JSON and SSE response handling, and
 *      OAuth bearer injection (config.token and token store).
 *   2. Legacy SSE transport (MCP 2024-11-05): GET stream + `endpoint` discovery
 *      + POST, with responses routed back through the pending-request map.
 *   3. Manager facade: callTool(server, tool), listResources/readResource,
 *      listPrompts/getPrompt, and authenticate() bridging the token store.
 *
 * Everything runs against a mocked global.fetch and a faked oauthTokenStore —
 * no subprocess, no network, no disk.
 */

const assert = require('assert');

// ── Fake OAuth token store (module mock) ─────────────────────────────────────
const mockStore = {
  _tokens: new Map(),
  store: jest.fn(async (id, set) => { mockStore._tokens.set(id, set); }),
  getToken: jest.fn(async (id) => {
    const e = mockStore._tokens.get(id);
    return e ? e.accessToken : null;
  }),
  startDeviceCodeFlow: jest.fn(async () => ({ flow: 'device', userCode: 'WXYZ' })),
  startAuthCodeFlow: jest.fn(() => ({ flow: 'authcode', authorizeUrl: 'https://idp/authorize' })),
};
jest.mock('../src/services/mcp/oauthTokenStore', () => ({
  getTokenStore: () => mockStore,
  McpOAuthTokenStore: class {},
}));

const mcp = require('../src/services/mcp');

// ── Fake Response helpers ────────────────────────────────────────────────────

function headers(map = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) };
}

function jsonResponse(obj, { sessionId } = {}) {
  const h = { 'content-type': 'application/json' };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return {
    ok: true,
    status: 200,
    headers: headers(h),
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
  };
}

function sseResponse(frames, { sessionId } = {}) {
  // frames: array of objects → serialized as `data: {json}\n\n`
  const chunks = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  const h = { 'content-type': 'text/event-stream' };
  if (sessionId) h['mcp-session-id'] = sessionId;
  return { ok: true, status: 200, headers: headers(h), body: stream };
}

// Compute a canned JSON-RPC result for a given request method.
function resultFor(method) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'remote-srv', version: '1.0' },
        instructions: 'Be helpful.',
      };
    case 'tools/list':
      return { tools: [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object' } }] };
    case 'resources/list':
      return { resources: [{ uri: 'file:///a.txt', name: 'a' }] };
    case 'prompts/list':
      return { prompts: [{ name: 'summarize', description: 'Summarize text' }] };
    case 'tools/call':
      return { content: [{ type: 'text', text: 'hit' }] };
    case 'resources/read':
      return { contents: [{ uri: 'file:///a.txt', text: 'alpha' }] };
    case 'prompts/get':
      return { messages: [{ role: 'user', content: { type: 'text', text: 'do it' } }] };
    default:
      return {};
  }
}

afterEach(async () => {
  await mcp.disconnectAll();
  mockStore._tokens.clear();
  jest.clearAllMocks();
  delete global.fetch;
});

// ── Suite A: Streamable HTTP ─────────────────────────────────────────────────

describe('MCP Streamable HTTP transport', () => {
  function installHttpFetch({ sse = false, capture } = {}) {
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (opts.method === 'DELETE') return jsonResponse({});
      if (capture) capture.push({ url, opts });
      const body = opts.body ? JSON.parse(opts.body) : {};
      // Notification (no id) → 202 ack.
      if (body.id == null) return { ok: true, status: 202, headers: headers({ 'content-length': '0' }) };
      const frame = { jsonrpc: '2.0', id: body.id, result: resultFor(body.method) };
      return sse ? sseResponse([frame], { sessionId: 'SID-1' }) : jsonResponse(frame, { sessionId: 'SID-1' });
    });
  }

  test('connects, captures session id, loads inventory (JSON responses)', async () => {
    installHttpFetch();
    const client = await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });

    assert.strictEqual(client.state, 'connected');
    assert.strictEqual(client._sessionId, 'SID-1');
    assert.strictEqual(client.serverInfo.name, 'remote-srv');
    assert.strictEqual(client.getInstructions(), 'Be helpful.');

    const tools = mcp.listMCPTools();
    assert.ok(tools.some((t) => t.name === 'mcp__remote__search'), 'tool surfaced with qualified name');
  });

  test('handles SSE-framed responses on the streamable endpoint', async () => {
    installHttpFetch({ sse: true });
    const client = await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });
    assert.strictEqual(client.state, 'connected');
    const res = await mcp.callTool('remote', 'search', { q: 'x' });
    assert.deepStrictEqual(res.content, [{ type: 'text', text: 'hit' }]);
  });

  test('echoes Mcp-Session-Id and injects bearer from config.token', async () => {
    const capture = [];
    installHttpFetch({ capture });
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp', token: 'STATIC-Tok' });

    const toolsCall = capture.find((c) => JSON.parse(c.opts.body).method === 'tools/list');
    assert.strictEqual(toolsCall.opts.headers.Authorization, 'Bearer STATIC-Tok');
    assert.strictEqual(toolsCall.opts.headers['Mcp-Session-Id'], 'SID-1', 'session id echoed after initialize');
  });

  test('injects bearer from the OAuth token store when no config.token', async () => {
    mockStore._tokens.set('remote', { accessToken: 'STORE-Tok' });
    const capture = [];
    installHttpFetch({ capture });
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });

    const initCall = capture.find((c) => JSON.parse(c.opts.body).method === 'initialize');
    assert.strictEqual(initCall.opts.headers.Authorization, 'Bearer STORE-Tok');
  });

  test('surfaces JSON-RPC errors from a tool call', async () => {
    global.fetch = jest.fn(async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.id == null) return { ok: true, status: 202, headers: headers({ 'content-length': '0' }) };
      if (body.method === 'tools/call') {
        return jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'boom' } });
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: resultFor(body.method) }, { sessionId: 'S' });
    });
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });
    await assert.rejects(() => mcp.callTool('remote', 'search', {}), /boom/);
  });
});

// ── Suite B: Legacy SSE ──────────────────────────────────────────────────────

describe('MCP legacy SSE transport', () => {
  function installSseFetch() {
    let controller = null;
    const enc = new TextEncoder();
    global.fetch = jest.fn(async (url, opts = {}) => {
      const method = opts.method || 'GET';
      if (method === 'GET') {
        const stream = new ReadableStream({
          start(c) {
            controller = c;
            // Announce the POST endpoint immediately.
            c.enqueue(enc.encode('event: endpoint\ndata: /messages?sid=1\n\n'));
          },
        });
        return { ok: true, status: 200, headers: headers({ 'content-type': 'text/event-stream' }), body: stream };
      }
      // POST: a request gets its response pushed onto the GET stream; a
      // notification is simply acked.
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.id != null && controller) {
        const frame = { jsonrpc: '2.0', id: body.id, result: resultFor(body.method) };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      return { ok: true, status: 202, headers: headers({}) };
    });
  }

  test('discovers endpoint, handshakes, and dispatches tool calls', async () => {
    installSseFetch();
    const client = await mcp.connectMCPServer('legacy', { type: 'sse', url: 'https://srv/sse' });

    assert.strictEqual(client.state, 'connected');
    assert.ok(client._postUrl.endsWith('/messages?sid=1'), 'endpoint resolved to absolute POST url');
    assert.strictEqual(client.serverInfo.name, 'remote-srv');

    const res = await mcp.callTool('legacy', 'search', { q: 'y' });
    assert.deepStrictEqual(res.content, [{ type: 'text', text: 'hit' }]);
  });
});

// ── Suite C: Manager facade ──────────────────────────────────────────────────

describe('MCP manager facade', () => {
  function installHttpFetch() {
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (opts.method === 'DELETE') return jsonResponse({});
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.id == null) return { ok: true, status: 202, headers: headers({ 'content-length': '0' }) };
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: resultFor(body.method) }, { sessionId: 'S' });
    });
  }

  test('callTool resolves both raw and qualified tool names', async () => {
    installHttpFetch();
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });
    const byRaw = await mcp.callTool('remote', 'search', {});
    const byQualified = await mcp.callTool('remote', 'mcp__remote__search', {});
    assert.ok(byRaw.content && byQualified.content);
  });

  test('listResources / readResource round-trip with server tagging', async () => {
    installHttpFetch();
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });

    const resources = mcp.listResources('remote');
    assert.strictEqual(resources.length, 1);
    assert.strictEqual(resources[0].server, 'remote');

    const read = await mcp.readResource('remote', resources[0].uri);
    assert.strictEqual(read.contents[0].text, 'alpha');
  });

  test('listPrompts / getPrompt round-trip', async () => {
    installHttpFetch();
    await mcp.connectMCPServer('remote', { type: 'http', url: 'https://srv/mcp' });

    const prompts = mcp.listPrompts();
    assert.ok(prompts.some((p) => p.name === 'summarize' && p.server === 'remote'));

    const got = await mcp.getPrompt('remote', 'summarize', { text: 'hi' });
    assert.strictEqual(got.messages[0].role, 'user');
  });

  test('unknown server raises a clear error', async () => {
    await assert.rejects(() => mcp.callTool('nope', 'x', {}), /not found/);
  });

  test('authenticate(api_key) stores a static bearer in the token store', async () => {
    const out = await mcp.authenticate('remote', { method: 'api_key', credentials: { token: 'AK-1' } });
    assert.deepStrictEqual(out, { method: 'api_key', stored: true });
    assert.strictEqual(mockStore.store.mock.calls[0][0], 'remote');
    assert.strictEqual(mockStore.store.mock.calls[0][1].accessToken, 'AK-1');
  });

  test('authenticate(device) delegates to the device-code flow', async () => {
    const out = await mcp.authenticate('remote', { method: 'device', credentials: {} });
    assert.strictEqual(out.flow, 'device');
    assert.ok(mockStore.startDeviceCodeFlow.mock.calls.length === 1);
  });

  test('authenticate default delegates to the authorization-code flow', async () => {
    const out = await mcp.authenticate('remote', {});
    assert.strictEqual(out.flow, 'authcode');
  });
});
