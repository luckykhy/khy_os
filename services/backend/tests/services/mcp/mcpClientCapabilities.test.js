'use strict';

/**
 * MCP 客户端能力声明 + 服务端请求响应(node:test)。
 *
 * 锁住两个相互关联的缺陷:
 *   M2 — initialize 时把 **ServerCapabilities**(tools/resources/prompts) 当
 *        ClientCapabilities 上报:既属无效字段,又让服务端误判本客户端不支持
 *        roots/sampling,从而主动关闭服务端发起的交互。
 *   M3 — `_handleMessage` 只处理响应与两个 notification,服务端发起的请求被静默
 *        丢弃 —— 服务端只能等到自己的超时,表现为"对面卡住"。
 *
 * 二者必须一起修:声明了能力却不响应,比不声明更糟。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../../../src/services/domain/messaging/mcp/index.js');

const tick = () => new Promise((r) => setTimeout(r, 20));

/** 造一个不触网的 client:拦截 _writeRaw 收集回包。 */
function makeClient() {
  const client = new mcp.MCPClient('unit-test', { type: 'stdio' });
  const written = [];
  client._writeRaw = (str) => {
    written.push(JSON.parse(str));
  };
  client._refreshTools = () => {};
  client._refreshResources = () => {};
  return { client, written };
}

// ── M2:能力声明 ─────────────────────────────────────────────────────────────

test('CLIENT_CAPABILITIES 只含客户端能力,不含服务端能力字段', () => {
  assert.deepEqual(mcp.CLIENT_CAPABILITIES, { roots: {} });
  assert.equal(mcp.CLIENT_CAPABILITIES.tools, undefined);
  assert.equal(mcp.CLIENT_CAPABILITIES.resources, undefined);
  assert.equal(mcp.CLIENT_CAPABILITIES.prompts, undefined);
});

test('initialize 上报 CLIENT_CAPABILITIES 且带 protocolVersion(HTTP 传输)', async () => {
  const sent = [];
  const client = new mcp.MCPClient('unit-test', { type: 'http', url: 'http://example.invalid' });
  client._sendRequestHttp = async (method, params) => {
    sent.push({ method, params });
    return { capabilities: {}, serverInfo: {} };
  };
  client._writeRaw = () => {};
  client._loadServerInventory = async () => {};

  await client._connectHttp();

  const init = sent.find((s) => s.method === 'initialize');
  assert.ok(init, '应发出 initialize');
  assert.deepEqual(init.params.capabilities, { roots: {} });
  assert.equal(init.params.capabilities.tools, undefined);
  assert.equal(typeof init.params.protocolVersion, 'string');
});

// ── M3:服务端请求响应 ───────────────────────────────────────────────────────

test('收到 roots/list 请求 → 回响应且含 roots 数组', async () => {
  const { client, written } = makeClient();
  client._handleMessage({ jsonrpc: '2.0', id: 7, method: 'roots/list' });
  await tick();

  assert.equal(written.length, 1);
  assert.equal(written[0].jsonrpc, '2.0');
  assert.equal(written[0].id, 7);
  assert.ok(Array.isArray(written[0].result.roots));
  assert.equal(written[0].error, undefined);
});

test('收到 ping 请求 → 回空结果', async () => {
  const { client, written } = makeClient();
  client._handleMessage({ jsonrpc: '2.0', id: 11, method: 'ping' });
  await tick();

  assert.equal(written.length, 1);
  assert.deepEqual(written[0].result, {});
});

test('收到未支持的请求(sampling)→ 回 -32601,而不是静默丢弃', async () => {
  const { client, written } = makeClient();
  client._handleMessage({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} });
  await tick();

  assert.equal(written.length, 1, '必须回包,否则服务端会挂起等超时');
  assert.equal(written[0].id, 9);
  assert.equal(written[0].error.code, -32601);
  assert.match(written[0].error.message, /sampling/);
});

test('通知(无 id)仍然不回包', async () => {
  const { client, written } = makeClient();
  client._handleMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await tick();
  assert.equal(written.length, 0);
});

test('响应(id 命中 pending)仍按原路径 resolve,不被请求分支抢走', async () => {
  const { client, written } = makeClient();
  const pending = new Promise((resolve, reject) => {
    client._pendingRequests.set(42, { resolve, reject, method: 'tools/list' });
  });
  client._handleMessage({ jsonrpc: '2.0', id: 42, result: { tools: [] } });

  assert.deepEqual(await pending, { tools: [] });
  assert.equal(written.length, 0, '响应不应再被回写出去');
});

test('错误响应(id 命中 pending)reject 并带出服务端消息', async () => {
  const { client } = makeClient();
  const pending = new Promise((resolve, reject) => {
    client._pendingRequests.set(43, { resolve, reject, method: 'tools/list' });
  });
  client._handleMessage({ jsonrpc: '2.0', id: 43, error: { code: -32601, message: 'nope' } });
  await assert.rejects(pending, /nope/);
});
