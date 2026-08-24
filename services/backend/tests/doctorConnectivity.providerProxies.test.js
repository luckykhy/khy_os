'use strict';

/**
 * doctorConnectivity.providerProxies.test.js — BUG-005 follow-up.
 *
 * `khy doctor`'s proxy check only probed the *shared* proxy, so a provider that
 * declared its own `proxy` in custom_providers.json was never health-checked.
 * A stopped local proxy client therefore stayed invisible to doctor until every
 * model call failed with ECONNREFUSED. checkProviderProxies() closes that gap.
 */

const net = require('net');

// Reserve a port then release it, so nothing is listening on it. Ephemeral
// ports keep the test free of hard-coded literals and immune to whatever the
// developer happens to be running locally.
function deadPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function livePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// Load the handler with the provider registry stubbed to `providers`.
function loadWithProviders(providers) {
  let mod;
  jest.isolateModules(() => {
    jest.doMock('../src/services/customProviderRegistry', () => ({
      listProviders: () => providers,
    }));
    mod = require('../src/cli/handlers/doctorConnectivity');
  });
  return mod;
}

describe('BUG-005 后续：doctor 体检 per-provider 代理', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('无 provider 配置独立代理时跳过', async () => {
    const { checkProviderProxies } = loadWithProviders([
      { poolKey: 'openai' },
      { poolKey: 'api', proxy: '   ' },
    ]);
    const r = await checkProviderProxies();
    expect(r.ok).toBe(true);
    expect(r.level).toBe('info');
    expect(r.detail).toMatch(/已跳过/);
  });

  test('代理未监听时报警，并点名端点与受影响 provider', async () => {
    const port = await deadPort();
    const { checkProviderProxies } = loadWithProviders([
      { poolKey: 'openai', proxy: `http://127.0.0.1:${port}` },
      { poolKey: 'api', proxy: `http://127.0.0.1:${port}` },
    ]);
    const r = await checkProviderProxies();
    expect(r.ok).toBe(false);
    expect(r.level).toBe('warn');
    expect(r.detail).toContain(`127.0.0.1:${port}`);
    // 共用同一端点的 provider 合并为一条，且都被点名。
    expect(r.detail).toContain('openai');
    expect(r.detail).toContain('api');
    expect(r.detail).toMatch(/未监听/);
    expect(r.detail).toMatch(/回退直连/);
  });

  test('代理在监听时判定可达', async () => {
    const { srv, port } = await livePort();
    try {
      const { checkProviderProxies } = loadWithProviders([
        { poolKey: 'openai', proxy: `http://127.0.0.1:${port}` },
      ]);
      const r = await checkProviderProxies();
      expect(r.ok).toBe(true);
      expect(r.level).toBe('info');
      expect(r.detail).toMatch(/全部可达/);
      expect(r.detail).toContain(`127.0.0.1:${port}`);
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });

  test('代理地址无法解析时报警而不是探测猜测地址', async () => {
    const { checkProviderProxies } = loadWithProviders([{ poolKey: 'api', proxy: 'not a url' }]);
    const r = await checkProviderProxies();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/无法解析/);
    expect(r.detail).toContain('api');
  });

  test('代理 URL 内嵌的账号密码绝不出现在体检报告里', async () => {
    const port = await deadPort();
    const { checkProviderProxies } = loadWithProviders([
      { poolKey: 'openai', proxy: `http://alice:s3cr3t@127.0.0.1:${port}` },
    ]);
    const r = await checkProviderProxies();
    expect(r.detail).toContain(`127.0.0.1:${port}`);
    expect(r.detail).not.toContain('s3cr3t');
    expect(r.detail).not.toContain('alice');
  });

  test('注册表读取失败时 fail-soft 返回告警而不抛出', async () => {
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../src/services/customProviderRegistry', () => ({
        listProviders: () => {
          throw new Error('registry corrupt');
        },
      }));
      mod = require('../src/cli/handlers/doctorConnectivity');
    });
    const r = await mod.checkProviderProxies();
    expect(r.ok).toBe(false);
    expect(r.level).toBe('warn');
    expect(r.detail).toMatch(/registry corrupt/);
  });
});
