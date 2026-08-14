'use strict';

/**
 * aiManagementServer.commandsRoute.test.js — 守护「功能索引」页可达性回归。
 *
 * 病灶(截图 /admin/ai-gateway/features 报「Not found / 功能索引暂时加载不出来」):
 *   FeatureCatalog.vue 发 GET /api/commands 取功能索引(与 TUI `/features` 同一 SSOT),
 *   但守护进程 aiManagementServer 的手写 routeRequest 分发器**没有 /api/commands 分支** →
 *   未命中直落 sendError(404)。路由器 src/routes/commands.js 早已存在,只是从未被这个
 *   khychat 守护进程挂载(它原本只活在闲置的 monolith server.js 上)。
 *
 * 修复:经惰性 Express 子应用把 commands 路由器接入 routeRequest(与 marketplace/plugins
 *   同款),分发前缀 /api/commands。该路由器公开只读、fail-soft(绝不 500)。
 *
 * 全程零真实网络/零 DB:commandCatalog.buildCommandCatalog 纯内存构建。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const server = require('../src/services/aiManagementServer');
const { __test__ } = server;

/** Fire one GET through an Express app on an ephemeral port; resolve {status, json}. */
function get(app, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      http
        .get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            srv.close(() => {
              let json = null;
              try { json = JSON.parse(body); } catch { /* leave null */ }
              resolve({ status: res.statusCode, json });
            });
          });
        })
        .on('error', (err) => srv.close(() => reject(err)));
    });
  });
}

test('commands 子应用可达:GET /api/commands → 200 + 功能索引目录(绝非 404)', async () => {
  const app = __test__.getCommandsApp();
  const { status, json } = await get(app, '/api/commands');
  assert.notStrictEqual(status, 404, '/api/commands 不应 404(路由器未接入即此症)');
  assert.strictEqual(status, 200, '公开只读端点应 200');
  assert.ok(json && json.success === true, 'success:true');
  assert.ok(Array.isArray(json.data.categories), 'data.categories 为数组');
  assert.ok(json.data.total > 0, '目录应含至少一条命令');
});

test('commands 子应用:?q 服务端过滤命中命令名', async () => {
  const app = __test__.getCommandsApp();
  const { status, json } = await get(app, '/api/commands?q=features');
  assert.strictEqual(status, 200);
  assert.ok(json.success === true);
  // 过滤后 total 应 ≤ 全量,且命中项确实含关键词(大小写不敏感)。
  const hit = json.data.categories.some((c) =>
    c.commands.some((cmd) => JSON.stringify(cmd).toLowerCase().includes('features')));
  assert.ok(hit, 'q=features 应有命中项');
});

test('commands 惰性 getter 幂等:同一缓存实例', () => {
  assert.strictEqual(__test__.getCommandsApp(), __test__.getCommandsApp());
});
