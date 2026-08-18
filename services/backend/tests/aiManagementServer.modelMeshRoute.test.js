'use strict';

/**
 * aiManagementServer.modelMeshRoute.test.js — 守护「节点间模型转发」HTTP 路由可达性回归。
 *
 * 覆盖 /api/mesh 三个契约点:
 *   1) 鉴权:缺 x-khy-mesh-token / 令牌不匹配 → 401(timing-safe,绝不泄露)。
 *   2) 能力声明:带正确令牌 GET /api/mesh/capabilities → 200 + 本机能力
 *      (从 KHY_MESH_MODELS / KHY_MESH_CAPABILITIES / KHY_MESH_NODE_ID 读取)。
 *   3) _meshHop 注入:带正确令牌 POST /api/mesh/generate → 收到请求的网关路径
 *      必须携带 _meshHop >= 1(语义护栏:接收节点不得再把请求转发出去,防环)。
 *
 * 全程零真实网络/零外部模型:gateway.generate 以桩替身,只记录收到的 options,
 * 断言 _meshHop 存在即返回(不触碰真实 18 适配器级联)。令牌从 env 注入,
 * 测试结束恢复,避免污染其它测试。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const server = require('../src/services/aiManagementServer');
const { __test__ } = server;

const GATEWAY_PATH = require.resolve('../src/services/gateway/aiGateway');
const TEST_TOKEN = 'mesh-route-test-token';

const savedEnv = {};
let gateway = null;
let originalGenerate = null;

test.before(async () => {
  for (const key of ['KHY_MESH_TOKEN', 'KHY_MESH_MODELS', 'KHY_MESH_CAPABILITIES', 'KHY_MESH_NODE_ID']) {
    if (process.env[key] !== undefined) savedEnv[key] = process.env[key];
  }
  process.env.KHY_MESH_TOKEN = TEST_TOKEN;
  process.env.KHY_MESH_MODELS = 'gpt-5,claude-opus-5';
  process.env.KHY_MESH_CAPABILITIES = 'vision,persistent-memory';
  process.env.KHY_MESH_NODE_ID = 'mesh-node-under-test';

  gateway = require(GATEWAY_PATH);
  originalGenerate = gateway.generate;
  gateway.generate = async (prompt, options = {}) => ({ success: true, text: 'stub', options });
});

test.after(() => {
  if (gateway && originalGenerate) gateway.generate = originalGenerate;
  for (const key of ['KHY_MESH_TOKEN', 'KHY_MESH_MODELS', 'KHY_MESH_CAPABILITIES', 'KHY_MESH_NODE_ID']) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

/** Fire one request through an app on an ephemeral port; resolve {status, json}. */
function request(app, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const opts = {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      };
      const req = http.request(opts, (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          srv.close(() => {
            let json = null;
            try { json = JSON.parse(raw); } catch { /* leave null */ }
            resolve({ status: res.statusCode, json });
          });
        });
      });
      req.on('error', (err) => srv.close(() => reject(err)));
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test('mesh 子应用:缺令牌 → 401(鉴权拒在路由层,不发任何能力/路由信息)', async () => {
  const app = __test__.getModelMeshApp();
  const { status } = await request(app, 'GET', '/api/mesh/capabilities');
  assert.strictEqual(status, 401, '缺 x-khy-mesh-token 必须 401');
});

test('mesh 子应用:令牌不匹配 → 401', async () => {
  const app = __test__.getModelMeshApp();
  const { status } = await request(app, 'GET', '/api/mesh/capabilities', undefined, {
    'x-khy-mesh-token': 'wrong-token',
  });
  assert.strictEqual(status, 401, '令牌不匹配必须 401');
});

test('mesh 子应用:GET /api/mesh/capabilities → 200 + 本机能力声明', async () => {
  const app = __test__.getModelMeshApp();
  const { status, json } = await request(app, 'GET', '/api/mesh/capabilities', undefined, {
    'x-khy-mesh-token': TEST_TOKEN,
  });
  assert.strictEqual(status, 200, '鉴权通过应 200,绝非 404');
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.id, 'mesh-node-under-test');
  assert.deepStrictEqual(json.models, ['gpt-5', 'claude-opus-5']);
  assert.deepStrictEqual(json.capabilities, ['vision', 'persistent-memory']);
  assert.ok(json.updatedAt, 'updatedAt 存在');
});

test('mesh 子应用:POST /api/mesh/generate 注入 _meshHop(防环护栏)', async () => {
  const app = __test__.getModelMeshApp();
  let receivedOptions = null;
  gateway.generate = async (prompt, options = {}) => {
    receivedOptions = { prompt, options };
    return { success: true, text: `stub-reply:${prompt}` };
  };
  const body = { prompt: '你好', options: { model: 'gpt-5', temperature: 0.3 } };
  const { status, json } = await request(app, 'POST', '/api/mesh/generate', body, {
    'x-khy-mesh-token': TEST_TOKEN,
  });
  assert.strictEqual(status, 200, '桩生成成功应 200(而非 502)');
  assert.ok(receivedOptions, 'gateway.generate 已被调用');
  assert.strictEqual(receivedOptions.prompt, '你好');
  // 关键断言:接收节点必须携带 _meshHop >= 1,否则会把请求再转发出去形成环。
  assert.ok(Number(receivedOptions.options._meshHop) >= 1, '_meshHop >= 1 必须被注入');
  assert.strictEqual(receivedOptions.options.model, 'gpt-5', '透传 options.model');
  assert.strictEqual(receivedOptions.options.temperature, 0.3, '透传 options.temperature');
  assert.strictEqual(json.success, true);
  assert.strictEqual(json.text, 'stub-reply:你好');
});

test('mesh 子应用:空 prompt → 400', async () => {
  const app = __test__.getModelMeshApp();
  const { status, json } = await request(app, 'POST', '/api/mesh/generate', { prompt: '   ' }, {
    'x-khy-mesh-token': TEST_TOKEN,
  });
  assert.strictEqual(status, 400, '空 prompt 必须 400');
  assert.strictEqual(json.success, false);
});

test('mesh 惰性 getter 幂等:同一缓存实例', () => {
  assert.strictEqual(__test__.getModelMeshApp(), __test__.getModelMeshApp());
});
