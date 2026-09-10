'use strict';
/**
 * aiManagementServer.commandsRoute.test.js �?守护「功能索引」页可达性回归�?
 *
 * 病灶(截图 /admin/ai-gateway/features 报「Not found / 功能索引暂时加载不出来�?:
 *   FeatureCatalog.vue �?GET /api/commands 取功能索�?�?TUI `/features` 同一 SSOT),
 *   但守护进�?aiManagementServer 的手�?routeRequest 分发�?*没有 /api/commands 分支** �?
 *   未命中直�?sendError(404)。路由器 src/routes/commands.js 早已存在,只是从未被这�?
 *   khychat 守护进程挂载(它原本只活在闲置�?monolith server.js �?�?
 *
 * 修复:经惰�?Express 子应用把 commands 路由器接�?routeRequest(�?marketplace/plugins
 *   同款),分发前缀 /api/commands。该路由器公开只读、fail-soft(绝不 500)�?
 *
 * 全程零真实网�?�?DB:commandCatalog.buildCommandCatalog 纯内存构建�?
 */
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

describe('Ai Management Server commands Route', () => {
  test('commands 子应用可�?GET /api/commands �?200 + 功能索引目录(绝非 404)', async () => {
      const app = __test__.getCommandsApp();
      const { status, json } = await get(app, '/api/commands');
      expect(status).not.toBe(404, '/api/commands 不应 404(路由器未接入即此�?');
      expect(status).toBe(200, '公开只读端点�?200');
      expect(json && json.success === true).toBeTruthy();
      expect(Array.isArray(json.data.categories)).toBe();
      expect(json.data.total > 0).toBeTruthy();
  });

  test('commands 子应�??q 服务端过滤命中命令名', async () => {
      const app = __test__.getCommandsApp();
      const { status, json } = await get(app, '/api/commands?q=features');
      expect(status).toBe(200);
      expect(json.success === true).toBeTruthy();
      // 过滤�?total �?�?全量,且命中项确实含关键词(大小写不敏感)�?
      const hit = json.data.categories.some((c) =>
        c.commands.some((cmd) => JSON.stringify(cmd).toLowerCase().includes('features')));
      expect(hit).toBeTruthy();
  });

  test('commands 惰�?getter 幂等:同一缓存实例', async () => {
      expect(__test__.getCommandsApp()).toBe(__test__.getCommandsApp());
  });

});

