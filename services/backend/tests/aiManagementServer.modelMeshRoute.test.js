'use strict';
/**
 * aiManagementServer.modelMeshRoute.test.js �?守护「节点间模型转发」HTTP 路由可达性回归�? *
 * 覆盖 /api/mesh 三个契约�?
 *   1) 鉴权:�?x-khy-mesh-token / 令牌不匹�?�?401(timing-safe,绝不泄露)�? *   2) 能力声明:带正确令�?GET /api/mesh/capabilities �?200 + 本机能力
 *      (�?KHY_MESH_MODELS / KHY_MESH_CAPABILITIES / KHY_MESH_NODE_ID 读取)�? *   3) _meshHop 注入:带正确令�?POST /api/mesh/generate �?收到请求的网关路�? *      必须携带 _meshHop >= 1(语义护栏:接收节点不得再把请求转发出去,防环)�? *
 * 全程零真实网�?零外部模�?gateway.generate 以桩替身,只记录收到的 options,
 * 断言 _meshHop 存在即返�?不触碰真�?18 适配器级�?。令牌从 env 注入,
 * 测试结束恢复,避免污染其它测试�? */
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

describe('Ai Management Server model Mesh Route', () => {
  test('mesh 子应�?缺令�?�?401(鉴权拒在路由�?不发任何能力/路由信息)', async () => {
      const app = __test__.getModelMeshApp();
      const { status } = await request(app, 'GET', '/api/mesh/capabilities');
      expect(status).toBe(401, '�?x-khy-mesh-token 必须 401');
  });

  test('mesh 子应�?令牌不匹�?�?401', async () => {
      const app = __test__.getModelMeshApp();
      const { status } = await request(app, 'GET', '/api/mesh/capabilities', undefined, {
        'x-khy-mesh-token': 'wrong-token',
      });
      expect(status).toBe(401, '令牌不匹配必�?401');
  });

  test('mesh 子应�?GET /api/mesh/capabilities �?200 + 本机能力声明', async () => {
      const app = __test__.getModelMeshApp();
      const { status, json } = await request(app, 'GET', '/api/mesh/capabilities', undefined, {
        'x-khy-mesh-token': TEST_TOKEN,
      });
      expect(status).toBe(200, '鉴权通过�?200,绝非 404');
      expect(json.success).toBe(true);
      expect(json.id).toBe('mesh-node-under-test');
      expect(json.models).toEqual(['gpt-5', 'claude-opus-5']);
      expect(json.capabilities).toEqual(['vision', 'persistent-memory']);
      expect(json.updatedAt).toBeTruthy();
  });

  test('mesh 子应�?POST /api/mesh/generate 注入 _meshHop(防环护栏)', async () => {
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
      expect(status).toBe(200, '桩生成成功应 200(而非 502)');
      expect(receivedOptions).toBeTruthy();
      expect(receivedOptions.prompt).toBe('你好');
      // 关键断言:接收节点必须携带 _meshHop >= 1,否则会把请求再转发出去形成环�?      expect(Number(receivedOptions.options._meshHop) >= 1).toBeTruthy();
      expect(receivedOptions.options.model).toBe('gpt-5', '透传 options.model');
      expect(receivedOptions.options.temperature).toBe(0.3, '透传 options.temperature');
      expect(json.success).toBe(true);
      expect(json.text).toBe('stub-reply:你好');
  });

  test('mesh 子应�?�?prompt �?400', async () => {
      const app = __test__.getModelMeshApp();
      const { status, json } = await request(app, 'POST', '/api/mesh/generate', { prompt: '   ' }, {
        'x-khy-mesh-token': TEST_TOKEN,
      });
      expect(status).toBe(400, '�?prompt 必须 400');
      expect(json.success).toBe(false);
  });

  test('mesh 惰�?getter 幂等:同一缓存实例', async () => {
      expect(__test__.getModelMeshApp()).toBe(__test__.getModelMeshApp());
  });

});

