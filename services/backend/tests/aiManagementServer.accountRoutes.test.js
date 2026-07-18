'use strict';

/**
 * aiManagementServer.accountRoutes.test.js — 守护 account-pool 路由可达性。
 *
 * 病灶（web UI 账号池工具栏报错根因）：前端经 useAccountPool.js / useGateway.js 调用
 *   - POST /api/ai-gateway/accounts/batch-delete
 *   - POST /api/ai-gateway/accounts/:provider/use/:id
 *   - POST /api/ai-gateway/accounts/:provider/import
 *   - POST /api/ai-gateway/accounts/:id/unban
 * 但守护进程手写的 handleAiGatewayNamespace 分发器原本只识别 GET/POST /accounts、
 * scheduling、circuit-breaker，以及 /accounts/:id(纯数字) 的 PUT/DELETE/enable/disable。
 * 上述四个路径要么是非数字静态段（batch-delete），要么是更深的子路径（use/import/unban），
 * 全部命中末尾的 sendError(404)。这些处理器只存在于闲置的 ai-backend 路由器(/api/ai-gateway-admin)，
 * 前端从未把请求发到那里，于是四个端点恒 404。
 *
 * 修复：在 handleAiGatewayNamespace 内补这四条 daemon-native 路由，全部经同一
 * getAccountPool() 单例操作（与 GET /accounts 读取的同一存储），保持单前缀一致。
 *
 * 本测试用真实 http server 驱动 handleAiGatewayNamespace，并注入一个假 pool 记录调用，
 * 断言四个路径都「可达且打到正确 pool 方法」(200)，而非回退到 404。零真实凭证、零 DB。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable } = require('stream');

const { __test__ } = require('../src/services/aiManagementServer');

/** Build a fake account pool that records the method calls the routes make. */
function makeFakePool() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); return Promise.resolve({ ok: true }); };
  return {
    calls,
    init: rec('init'),
    getAllAccounts: () => Promise.resolve([]),
    removeAccounts: rec('removeAccounts'),
    removeAllAccounts: rec('removeAllAccounts'),
    useAccount: rec('useAccount'),
    importProviderTokens: rec('importProviderTokens'),
    updateAccount: rec('updateAccount'),
  };
}

/**
 * Fire one request through handleAiGatewayNamespace on an ephemeral http server.
 * `body`, when present, is JSON-serialized into the request stream so parseBody
 * (used by batch-delete) sees it.
 */
function dispatch(method, path, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      Promise.resolve(__test__.handleAiGatewayNamespace(req, res, u.pathname, u.searchParams))
        .catch((err) => { if (!res.headersSent) { res.statusCode = 500; res.end(String(err)); } });
    }).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      const payload = body == null ? null : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => srv.close(() => resolve({ code: res.statusCode, body: data })));
        },
      );
      req.on('error', (err) => srv.close(() => reject(err)));
      if (payload) Readable.from([payload]).pipe(req);
      else req.end();
    });
  });
}

test('batch-delete by ids → 200，打到 pool.removeAccounts（非 404）', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/batch-delete', { ids: [1, 2] });
    assert.strictEqual(code, 200);
    const call = pool.calls.find((c) => c.name === 'removeAccounts');
    assert.ok(call, 'removeAccounts 应被调用');
    assert.deepStrictEqual(call.args[0], [1, 2]);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test('batch-delete all:true → 200，打到 pool.removeAllAccounts', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/batch-delete', { all: true, provider: 'kiro' });
    assert.strictEqual(code, 200);
    assert.ok(pool.calls.some((c) => c.name === 'removeAllAccounts'), 'removeAllAccounts 应被调用');
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test('batch-delete 空 ids → 400（参数校验，仍非 404）', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/batch-delete', {});
    assert.strictEqual(code, 400);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test('provider/use/:id → 200，打到 pool.useAccount(provider, id)', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/kiro/use/5');
    assert.strictEqual(code, 200);
    const call = pool.calls.find((c) => c.name === 'useAccount');
    assert.ok(call, 'useAccount 应被调用');
    assert.deepStrictEqual(call.args, ['kiro', '5']);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test('provider/import → 200，打到 pool.importProviderTokens(provider)', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/cursor/import');
    assert.strictEqual(code, 200);
    const call = pool.calls.find((c) => c.name === 'importProviderTokens');
    assert.ok(call, 'importProviderTokens 应被调用');
    assert.deepStrictEqual(call.args, ['cursor']);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test(':id/unban → 200，打到 pool.updateAccount(id, {status:available})', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/7/unban');
    assert.strictEqual(code, 200);
    const call = pool.calls.find((c) => c.name === 'updateAccount');
    assert.ok(call, 'updateAccount 应被调用');
    assert.deepStrictEqual(call.args, ['7', { status: 'available' }]);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});

test('回归：未知 account 子路径仍 404（兜底未被破坏）', async () => {
  const pool = makeFakePool();
  __test__._setAccountPoolForTest(pool);
  try {
    const { code } = await dispatch('POST', '/api/ai-gateway/accounts/kiro/bogus-action');
    assert.strictEqual(code, 404);
  } finally {
    __test__._setAccountPoolForTest(null);
  }
});
