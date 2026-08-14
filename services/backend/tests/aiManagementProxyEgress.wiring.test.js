'use strict';

/**
 * aiManagementProxyEgress 测试(node:test·全离线)。
 *   node --test services/backend/tests/aiManagementProxyEgress.wiring.test.js
 *
 * 两层:
 *  1) 源级 wiring 断言(readFileSync + regex):宿主 routeRequest 含 /api/proxy-egress 三路 +
 *     setProxyEgressDeps 已调 + 叶子 require。
 *  2) 处理器行为(注入 fake sendJson/sendError/parseBody/authenticateRequest + fake proxyConfig):
 *     status 透传 getStatus、enable 缺 node 报 400、enable 透传 activateNode 结果、disable 调 deactivate、
 *     未认证发 401。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const leaf = require('../src/services/aiManagementProxyEgress');

const SERVER_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/aiManagementServer.js'), 'utf8',
);

// ── 1) 源级 wiring ──────────────────────────────────────────────
test('wiring: 宿主 require 了 aiManagementProxyEgress 并调 setProxyEgressDeps', () => {
  assert.match(SERVER_SRC, /require\('\.\/aiManagementProxyEgress'\)/);
  assert.match(SERVER_SRC, /setProxyEgressDeps\(\{/);
});

test('wiring: routeRequest 分派 /api/proxy-egress 三路(status/enable/disable)', () => {
  assert.match(SERVER_SRC, /pathname === '\/api\/proxy-egress'\) return handleGetProxyEgressStatus/);
  assert.match(SERVER_SRC, /pathname === '\/api\/proxy-egress\/enable'\) return handleEnableProxyEgress/);
  assert.match(SERVER_SRC, /pathname === '\/api\/proxy-egress\/disable'\) return handleDisableProxyEgress/);
});

// ── 2) 处理器行为(注入 fake 反向边 + fake proxyConfig)──────────────
function fakeRes() {
  return { _status: 0, _body: null };
}
function inject({ auth = { ok: true, user: { id: 7 } }, body = {}, proxyConfig = {} } = {}) {
  const calls = { json: [], error: [] };
  leaf.setProxyEgressDeps({
    sendJson: (res, status, payload) => { res._status = status; res._body = payload; calls.json.push({ status, payload }); },
    sendError: (res, status, msg) => { res._status = status; res._body = { error: msg }; calls.error.push({ status, msg }); },
    parseBody: async () => body,
    authenticateRequest: async () => auth,
  });
  // 覆盖懒加载单例(直接改内部 getter 返回值:通过 require 缓存注入)。
  const svc = require('../src/services/proxyConfigService');
  const restore = {};
  for (const k of Object.keys(proxyConfig)) {
    restore[k] = svc[k];
    svc[k] = proxyConfig[k];
  }
  return {
    calls,
    restoreProxy() { for (const k of Object.keys(restore)) svc[k] = restore[k]; },
  };
}

test('handleGetProxyEgressStatus: 透传 proxyConfig.getStatus', async () => {
  const ctx = inject({ proxyConfig: { getStatus: () => ({ enabled: true, activeNode: { name: 'hk' }, coreStatus: { running: false } }) } });
  try {
    const res = fakeRes();
    await leaf.handleGetProxyEgressStatus({ authContext: { ok: true, user: { id: 7 } } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.data.enabled, true);
    assert.equal(res._body.data.activeNode.name, 'hk');
  } finally {
    ctx.restoreProxy();
  }
});

test('handleEnableProxyEgress: 缺 node → 400', async () => {
  const ctx = inject({ body: {} });
  try {
    const res = fakeRes();
    await leaf.handleEnableProxyEgress({ authContext: { ok: true, user: { id: 7 } } }, res);
    assert.equal(res._status, 400);
    assert.match(res._body.error, /节点对象|body\.node/);
  } finally {
    ctx.restoreProxy();
  }
});

test('handleEnableProxyEgress: 透传 activateNode 结果(失败也 200 带结构化 reason)', async () => {
  let gotNode = null;
  const ctx = inject({
    body: { node: { name: 'hk', type: 'vmess', server: 'a', port: 443, uuid: 'u' } },
    proxyConfig: {
      activateNode: async (node) => { gotNode = node; return { success: false, reason: 'core-missing', guidance: '装 mihomo' }; },
    },
  });
  try {
    const res = fakeRes();
    await leaf.handleEnableProxyEgress({ authContext: { ok: true, user: { id: 7 } } }, res);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, false);
    assert.equal(res._body.data.reason, 'core-missing');
    assert.equal(gotNode.type, 'vmess');
  } finally {
    ctx.restoreProxy();
  }
});

test('handleDisableProxyEgress: 调 deactivate', async () => {
  let called = false;
  const ctx = inject({ proxyConfig: { deactivate: async () => { called = true; return { success: true }; } } });
  try {
    const res = fakeRes();
    await leaf.handleDisableProxyEgress({ authContext: { ok: true, user: { id: 7 } } }, res);
    assert.equal(called, true);
    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
  } finally {
    ctx.restoreProxy();
  }
});

test('resolveAuthUserId: 认证失败 → 401 返 null', async () => {
  const ctx = inject({ auth: { ok: false, error: 'no token' } });
  try {
    const res = fakeRes();
    const id = await leaf.resolveAuthUserId({}, res);
    assert.equal(id, null);
    assert.equal(res._status, 401);
  } finally {
    ctx.restoreProxy();
  }
});
