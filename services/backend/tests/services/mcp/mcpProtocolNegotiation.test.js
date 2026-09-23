'use strict';

/**
 * MCP 协议版本协商 + 按能力调用(node:test)。
 *
 * M1 — 版本 `2024-11-05` 曾在 `mcpServerProtocol.js` 与 `mcp/index.js` **两处独立
 *      硬编码**,且 server 的 `buildInitializeResult` 完全不读 `params.protocolVersion`
 *      —— 等于没有协商,新版客户端按规范应断开。
 * M4 — `_loadServerInventory` 无条件并发请求 tools/resources/prompts 三个 list,
 *      不检查服务端声明的能力(规范禁止调用未声明的接口)。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../../../src/services/domain/messaging/mcp/index.js');
const protocol = require('../../../src/services/domain/messaging/mcp/mcpServerProtocol.js');
const { createServerCore } = require('../../../src/services/domain/messaging/mcp/mcpServer.js');

// ── M1:单一真源 ─────────────────────────────────────────────────────────────

test('client 与 server 使用同一 PROTOCOL_VERSION(消除双份硬编码)', () => {
  assert.equal(mcp.PROTOCOL_VERSION, protocol.PROTOCOL_VERSION);
  assert.equal(protocol.SUPPORTED_PROTOCOL_VERSIONS.includes(protocol.PROTOCOL_VERSION), true);
});

// ── M1:server 侧协商 ────────────────────────────────────────────────────────

test('negotiateProtocolVersion: 支持则回显,不支持则回自己支持的版本', () => {
  assert.equal(protocol.negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(protocol.negotiateProtocolVersion('2025-06-18'), protocol.PROTOCOL_VERSION);
  assert.equal(protocol.negotiateProtocolVersion(''), protocol.PROTOCOL_VERSION);
  assert.equal(protocol.negotiateProtocolVersion(undefined), protocol.PROTOCOL_VERSION);
  assert.equal(protocol.negotiateProtocolVersion(' 2024-11-05 '), '2024-11-05');
});

test('server initialize 端到端:回包里的 protocolVersion 参与协商', async () => {
  const fakeRegistry = {
    loadTools() {},
    getEnabled: () => new Map(),
    execute: async () => ({ success: true }),
  };
  const core = createServerCore({ version: '9.9.9', registry: fakeRegistry });

  const ok = await core.handleMessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })
  );
  assert.equal(ok.result.protocolVersion, '2024-11-05');
  assert.equal(ok.result.serverInfo.version, '9.9.9');
  // 诚实:只声明已实现的 tools
  assert.deepEqual(ok.result.capabilities, { tools: {} });

  const newer = await core.handleMessage(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
  );
  assert.equal(newer.result.protocolVersion, protocol.PROTOCOL_VERSION);
});

// ── M1:client 侧版本校验 ────────────────────────────────────────────────────

test('_checkProtocolVersion: 一致 → true 且记录版本', () => {
  const client = new mcp.MCPClient('t', { type: 'stdio' });
  assert.equal(client._checkProtocolVersion({ protocolVersion: '2024-11-05' }), true);
  assert.equal(client.protocolVersion, '2024-11-05');
});

test('_checkProtocolVersion: 不一致 → false 并 emit,不再静默', () => {
  const client = new mcp.MCPClient('t', { type: 'stdio' });
  const events = [];
  client.on('protocolVersionMismatch', (e) => events.push(e));

  assert.equal(client._checkProtocolVersion({ protocolVersion: '2025-06-18' }), false);
  assert.equal(client.protocolVersion, '2025-06-18');
  assert.equal(events.length, 1);
  assert.equal(events[0].server, '2025-06-18');
  assert.match(client._lastError, /protocol version mismatch/);
});

test('_checkProtocolVersion: 服务端未给版本 → 视为一致(容错)', () => {
  const client = new mcp.MCPClient('t', { type: 'stdio' });
  assert.equal(client._checkProtocolVersion({}), true);
  assert.equal(client.protocolVersion, mcp.PROTOCOL_VERSION);
});

// ── M4:按能力调用 ───────────────────────────────────────────────────────────

test('_loadServerInventory: 服务端只声明 tools → 不请求 resources/prompts', async () => {
  const client = new mcp.MCPClient('t', { type: 'stdio' });
  const sent = [];
  client._sendRequest = async (method) => {
    sent.push(method);
    return {};
  };
  client.capabilities = { tools: {} };
  await client._loadServerInventory();

  assert.deepEqual(sent, ['tools/list']);
  assert.deepEqual(client._resources, []);
  assert.deepEqual(client._prompts, []);
});

test('_loadServerInventory: 服务端声明了三项 → 三个 list 都请求', async () => {
  const client = new mcp.MCPClient('t', { type: 'stdio' });
  const sent = [];
  client._sendRequest = async (method) => {
    sent.push(method);
    return {};
  };
  client.capabilities = { tools: {}, resources: {}, prompts: {} };
  await client._loadServerInventory();

  assert.deepEqual(sent, ['tools/list', 'resources/list', 'prompts/list']);
});
