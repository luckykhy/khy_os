'use strict';

// mcpServerStatus 叶子契约测试(node:test)。
// 覆盖:门控开关、ConnectionState → 标签映射、disabled 优先、failed 带原因(裁剪)、
// pending reconnecting (n/m)、无连接记录由 connected 兜底、门控关 legacy 布尔、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const { mcpServerStatusEnabled, resolveMcpServerState } = require('../../src/services/mcp/mcpServerStatus');

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(mcpServerStatusEnabled({}), true);
  assert.strictEqual(mcpServerStatusEnabled({ KHY_MCP_SERVER_STATUS: '' }), true);
  assert.strictEqual(mcpServerStatusEnabled({ KHY_MCP_SERVER_STATUS: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(mcpServerStatusEnabled({ KHY_MCP_SERVER_STATUS: off }), false, JSON.stringify(off));
  }
});

test('ConnectionState → 显示标签映射', () => {
  assert.strictEqual(resolveMcpServerState({ type: 'connected', connected: true }, {}).state, 'connected');
  assert.strictEqual(resolveMcpServerState({ type: 'connecting' }, {}).state, 'connecting');
  assert.strictEqual(resolveMcpServerState({ type: 'pending' }, {}).state, 'reconnecting');
  assert.strictEqual(resolveMcpServerState({ type: 'failed' }, {}).state, 'failed');
  assert.strictEqual(resolveMcpServerState({ type: 'disabled' }, {}).state, 'disabled');
});

test('disabled 优先于任何连接态', () => {
  const r = resolveMcpServerState({ disabled: true, type: 'connected', connected: true }, {});
  assert.deepStrictEqual(r, { state: 'disabled', detail: '' });
});

test('failed → 附带 _lastError 原因', () => {
  const r = resolveMcpServerState({ type: 'failed', error: 'ECONNREFUSED 127.0.0.1:8080' }, {});
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(r.detail, 'ECONNREFUSED 127.0.0.1:8080');
});

test('failed → 超长原因裁剪到 60 带省略号', () => {
  const long = 'x'.repeat(200);
  const r = resolveMcpServerState({ type: 'failed', error: long }, {});
  assert.strictEqual(r.detail.length, 60);
  assert.ok(r.detail.endsWith('…'));
});

test('failed 无 error → detail 空', () => {
  assert.strictEqual(resolveMcpServerState({ type: 'failed' }, {}).detail, '');
});

test('pending → reconnecting (n/m) 尝试计数', () => {
  const r = resolveMcpServerState({ type: 'pending', reconnectAttempt: 2, maxReconnectAttempts: 5 }, {});
  assert.strictEqual(r.state, 'reconnecting');
  assert.strictEqual(r.detail, '2/5');
  // 计数缺失 → 无 detail
  assert.strictEqual(resolveMcpServerState({ type: 'pending' }, {}).detail, '');
});

test('无连接记录(type 缺失)→ 由 connected 布尔兜底', () => {
  assert.strictEqual(resolveMcpServerState({ connected: true }, {}).state, 'connected');
  assert.strictEqual(resolveMcpServerState({ connected: false }, {}).state, 'pending');
  assert.strictEqual(resolveMcpServerState({}, {}).state, 'pending');
});

test('未知 type 字符串 → 由 connected 布尔兜底(不臆造标签)', () => {
  assert.strictEqual(resolveMcpServerState({ type: 'needs-auth', connected: false }, {}).state, 'pending');
});

test('门控关 → legacy 布尔口径(逐字节回退 Connected 列)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      resolveMcpServerState({ type: 'failed', error: 'boom', connected: false }, { KHY_MCP_SERVER_STATUS: off }),
      { state: 'no', detail: '' }, off,
    );
    assert.deepStrictEqual(
      resolveMcpServerState({ type: 'connected', connected: true }, { KHY_MCP_SERVER_STATUS: off }),
      { state: 'yes', detail: '' }, off,
    );
  }
});

test('坏输入 → 绝不抛', () => {
  assert.doesNotThrow(() => resolveMcpServerState(null, {}));
  assert.doesNotThrow(() => resolveMcpServerState(undefined, {}));
  assert.doesNotThrow(() => resolveMcpServerState('nope', {}));
  assert.doesNotThrow(() => resolveMcpServerState({ type: 123, error: 456 }, {}));
  // null 输入门控开 → connected 兜底 false → pending
  assert.strictEqual(resolveMcpServerState(null, {}).state, 'pending');
});
