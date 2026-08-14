'use strict';

/**
 * aiManagementServer.apiRouteDispatch.test.js — 守护 marketplace / plugins 路由可达性。
 *
 * 病灶（web UI 报错根因）：前端 SPA 经 useMarketplace.js 调用 /api/marketplace*
 * 与 /api/plugins*，但守护进程 aiManagementServer 的手写 routeRequest 分发器原本
 * 没有这两族分支——它没有兜底代理，未命中的 /api/* 直接落到 sendError(404,'Not found')。
 * 这两个路由器当时只挂在闲置的 ai-backend/server.js 上，前端永远拿到 404。
 *
 * 修复：把两族路由器经惰性 Express 子应用接入 routeRequest（与 workflow/user-gateway
 * 同款模式）。本测试用守护进程导出的「真实」getter（与分发器用的同一 require 路径、
 * 同一挂载前缀）启一个临时 http server，未带凭证地探测，断言返回 401（可达且受鉴权
 * 守护）而非 404（不可达）。任何回退到 404 都说明接线断了。
 *
 * 全程零真实网络、零 DB：authenticateToken 在无 token 时立即 401，先于任何数据访问。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { __test__ } = require('../src/services/aiManagementServer');

/** Fire one unauthenticated GET through an Express app on an ephemeral port. */
function probe(app, path) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          res.resume();
          srv.close(() => resolve(res.statusCode));
        })
        .on('error', (err) => srv.close(() => reject(err)));
    });
  });
}

test('marketplace 子应用可达：未鉴权请求 → 401，绝非 404（接线在位）', async () => {
  const app = __test__.getMarketplaceApp();
  for (const p of ['/api/marketplace', '/api/marketplace/featured']) {
    const code = await probe(app, p);
    assert.notStrictEqual(code, 404, `${p} 不应 404（路由器未接入）`);
    assert.strictEqual(code, 401, `${p} 应被鉴权拦为 401`);
  }
});

test('plugins 子应用可达：未鉴权请求 → 401，绝非 404（接线在位）', async () => {
  const app = __test__.getPluginsApp();
  for (const p of ['/api/plugins', '/api/plugins/installed']) {
    const code = await probe(app, p);
    assert.notStrictEqual(code, 404, `${p} 不应 404（路由器未接入）`);
    assert.strictEqual(code, 401, `${p} 应被鉴权拦为 401`);
  }
});

test('惰性 getter 幂等：重复调用返回同一缓存子应用实例', () => {
  assert.strictEqual(__test__.getMarketplaceApp(), __test__.getMarketplaceApp());
  assert.strictEqual(__test__.getPluginsApp(), __test__.getPluginsApp());
});
