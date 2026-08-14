'use strict';

/**
 * aiManagementServer.proxySubAndVendor.test.js — 守护 khychat pip 安装后两处可达性回归。
 *
 * 病灶(浏览器控制台报错根因):
 *   1) GET /api/proxy-subscriptions → 404：该路由器原本只挂在闲置的 monolith
 *      server.js(:533,authMiddleware 前置),守护进程 aiManagementServer 的手写
 *      routeRequest 分发器没有这一族分支 → 未命中 /api/* 直落 sendError(404)。
 *   2) GET /vendor/khyos-muya.{css,js} → 401:muya WYSIWYG bundle 是 public 静态资源
 *      (Vite 把 public/vendor/* 原样拷进 dist/vendor/*),但 tryHandleFrontendStatic
 *      只识别 /assets/*,/vendor/* 落穿到鉴权闸 → 401。
 *
 * 修复:
 *   1) 经惰性 Express 子应用把 proxySubscription 路由器接入 routeRequest(与
 *      marketplace/plugins 同款),并在挂载点前置 authenticateToken(镜像 monolith),
 *      使 req.user.id 可用。未鉴权探测应 401(可达且受鉴权),绝非 404(不可达)。
 *   2) tryHandleFrontendStatic 新增 /vendor/ 前置分支(鉴权前),命中即服务、未命中返
 *      404(而非落穿成误导性的 401)。
 *
 * 全程零真实网络/零 DB:authenticateToken 无 token 立即 401,先于任何数据访问。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = require('../src/services/aiManagementServer');
const { __test__ } = server;

/** Fire one unauthenticated GET through an Express app on an ephemeral port. */
function probe(app, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      http
        .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
          res.resume();
          srv.close(() => resolve(res.statusCode));
        })
        .on('error', (err) => srv.close(() => reject(err)));
    });
  });
}

function mockRes() {
  return {
    statusCode: 0,
    headers: null,
    body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

// --- Fix #2: /api/proxy-subscriptions reachable on the daemon ---

test('proxy-subscriptions 子应用可达:未鉴权 → 401,绝非 404(接线在位)', async () => {
  const app = __test__.getProxySubscriptionApp();
  for (const p of ['/api/proxy-subscriptions', '/api/proxy-subscriptions/groups']) {
    const code = await probe(app, p);
    assert.notStrictEqual(code, 404, `${p} 不应 404(路由器未接入)`);
    assert.strictEqual(code, 401, `${p} 应被鉴权拦为 401`);
  }
});

test('proxy-subscriptions 惰性 getter 幂等:同一缓存实例', () => {
  assert.strictEqual(__test__.getProxySubscriptionApp(), __test__.getProxySubscriptionApp());
});

// --- Fix #3: /vendor/* served pre-auth (muya bundle) ---

test('vendor 静态:命中的 /vendor/* 资源在鉴权前即被服务(200),不落穿成 401', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vendor-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    const css = '.muya{color:#123}';
    fs.writeFileSync(path.join(dir, 'vendor', 'khyos-muya.css'), css, 'utf8');

    const cfg = server.configureFrontendStatic({ distDir: dir, entryPath: '/admin/ai-gateway' });
    assert.strictEqual(cfg.enabled, true);

    const req = { method: 'GET' };
    const res = mockRes();
    const handled = __test__.tryHandleFrontendStatic(req, res, '/vendor/khyos-muya.css');

    assert.strictEqual(handled, true, '/vendor/* 必须由静态分支接管(不落穿到鉴权)');
    assert.strictEqual(res.statusCode, 200, '命中资源应 200');
    assert.strictEqual(String(res.body), css, '返回原始文件内容');
    assert.ok(/css/.test(res.headers['Content-Type']), 'Content-Type 应为 css');
  } finally {
    server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor 静态:未命中的 /vendor/* → 404(不落穿成误导性 401)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vendor-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    server.configureFrontendStatic({ distDir: dir, entryPath: '/admin/ai-gateway' });

    const res = mockRes();
    const handled = __test__.tryHandleFrontendStatic({ method: 'GET' }, res, '/vendor/nope.js');

    assert.strictEqual(handled, true, '未命中也由静态分支接管,绝不落穿到鉴权');
    assert.strictEqual(res.statusCode, 404, '未命中资源应 404,而非 401');
  } finally {
    server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor 静态:路径穿越被限域拒绝 → 404(不越出 distDir)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vendor-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    // A secret sibling OUTSIDE distDir that traversal must never reach.
    const secret = path.join(dir, '..', `khy-secret-${process.pid}.txt`);
    fs.writeFileSync(secret, 'TOP SECRET', 'utf8');
    server.configureFrontendStatic({ distDir: dir, entryPath: '/admin/ai-gateway' });

    const res = mockRes();
    const handled = __test__.tryHandleFrontendStatic(
      { method: 'GET' }, res, `/vendor/../../${path.basename(secret)}`);

    assert.strictEqual(handled, true);
    assert.strictEqual(res.statusCode, 404, '穿越必须被拒(限域),绝不外泄');
    assert.notStrictEqual(String(res.body || ''), 'TOP SECRET');
    fs.rmSync(secret, { force: true });
  } finally {
    server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor 静态:未配置静态目录时不接管(返回 false 走原有分发)', () => {
  server.configureFrontendStatic({ distDir: '', entryPath: '/admin/ai-gateway' });
  const handled = __test__.tryHandleFrontendStatic({ method: 'GET' }, mockRes(), '/vendor/khyos-muya.js');
  assert.strictEqual(handled, false, '无静态目录时 /vendor/* 不应被接管');
});
