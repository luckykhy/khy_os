import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useUserGateway（普通用户租户域网关）行为测试。
 * 与 useGateway（管理端）共享展示卡片但绝不共享端点：本 composable 只走
 * /api/user-gateway/*。锁 URL 组装、unwrap 回填、failure 面（surfaceError
 * 的去重合并语义）与 detect/save 后的自动探测（detection）回填。
 * request 用 vi.mock 打桩，不发真实请求。
 */

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: (...a) => put(...a),
    patch: (...a) => patch(...a),
    delete: (...a) => del(...a),
  },
}));

const { useUserGateway } = await import('@/composables/useUserGateway');

const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('relay config', () => {
  it('fetchRelayConfig GET /model-config 回填 relayConfig；失败静默', async () => {
    get.mockResolvedValueOnce(envelope({ baseUrl: 'https://relay.example' }));
    const svc = useUserGateway();
    await svc.fetchRelayConfig();
    expect(get).toHaveBeenCalledWith('/api/user-gateway/model-config');
    expect(svc.relayConfig.value).toEqual({ baseUrl: 'https://relay.example' });

    get.mockRejectedValueOnce(new Error('down'));
    await expect(svc.fetchRelayConfig()).resolves.toBeUndefined();
  });

  it('saveRelayConfig：PUT 落盘 + saving 翻转 + 非 benign 探测错误进 detectionSummary.errors', async () => {
    put.mockResolvedValueOnce({
      data: {
        success: true,
        data: { baseUrl: 'https://relay.example' },
        detection: { provider: 'acme', error: 'ECONNREFUSED', benign: false },
      },
    });
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    const out = await svc.saveRelayConfig({ baseUrl: 'https://relay.example' });
    expect(put).toHaveBeenCalledWith('/api/user-gateway/model-config', {
      baseUrl: 'https://relay.example',
    });
    expect(out).toEqual({ baseUrl: 'https://relay.example' });
    expect(svc.saving.value).toBe(false);
    expect(svc.detectionSummary.value).toEqual({
      upstream: { provider: 'acme', error: 'ECONNREFUSED', benign: false },
      errors: [{ source: 'upstream', provider: 'acme', error: 'ECONNREFUSED' }],
    });
  });

  it('saveRelayConfig：benign 探测（上游没有 /models）不进 errors，UI 保持安静', async () => {
    put.mockResolvedValueOnce({
      data: {
        success: true,
        data: { baseUrl: 'https://relay.example' },
        detection: { provider: 'acme', error: '404 no /models', benign: true },
      },
    });
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    await svc.saveRelayConfig({ baseUrl: 'https://relay.example' });
    expect(svc.detectionSummary.value.errors).toEqual([]);
  });

  it('saveRelayConfig 抛错时 saving 也复位（finally）', async () => {
    put.mockRejectedValueOnce(new Error('500'));
    const svc = useUserGateway();
    await expect(svc.saveRelayConfig({})).rejects.toThrow('500');
    expect(svc.saving.value).toBe(false);
  });
});

describe('providers（自定义供应商 + key 池）', () => {
  it('fetchProviders 失败 → providers 清零 + surfaceError 面到 detectionSummary（带错误文案）', async () => {
    get.mockImplementation((url) =>
      url === '/api/user-gateway/catalog'
        ? Promise.resolve(envelope({}))
        : Promise.reject(Object.assign(new Error('boom'), { response: { data: { message: 'DB down' } } }))
    );
    const svc = useUserGateway();
    await svc.fetchProviders();
    expect(svc.providers.value).toEqual([]);
    expect(svc.detectionSummary.value.errors).toEqual([
      { source: 'providers', error: 'DB down' },
    ]);
  });

  it('surfaceError 按 source 去重合并（后到的不覆盖同 source 旧记录，异 source 保留）', async () => {
    get.mockImplementation((url) =>
      url === '/api/user-gateway/catalog'
        ? Promise.resolve(envelope({}))
        : Promise.reject(new Error('providers down'))
    );
    const svc = useUserGateway();
    await svc.fetchProviders();
    // 同 source 再失败一次 → errors 仍只有一条 providers
    await svc.fetchProviders();
    expect(svc.detectionSummary.value.errors).toHaveLength(1);
    expect(svc.detectionSummary.value.errors[0]).toEqual({
      source: 'providers',
      error: 'providers down',
    });
  });

  it('addProvider：POST + 自动探测回填 + 目录回刷；detection 为 benign 时不报错误', async () => {
    post.mockResolvedValueOnce({
      data: {
        success: true,
        data: { id: 'c1' },
        detection: { provider: 'acme', benign: true },
      },
    });
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    await expect(svc.addProvider({ provider: 'acme', key: 'sk' })).resolves.toEqual({
      id: 'c1',
    });
    expect(post).toHaveBeenCalledWith('/api/user-gateway/custom-providers', {
      provider: 'acme',
      key: 'sk',
    });
    expect(svc.detectionSummary.value.errors).toEqual([]);
  });

  it('removeProvider（按名）URL 编码 provider 名', async () => {
    del.mockResolvedValueOnce(envelope(null));
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    await svc.removeProvider('acme/x');
    expect(del).toHaveBeenCalledWith(
      '/api/user-gateway/providers/by-name/acme%2Fx'
    );
  });

  it('replaceProviderKey / updateProvider 走 PUT 同一资源', async () => {
    put.mockResolvedValue(envelope({ id: 'c1' }));
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    await svc.replaceProviderKey('c1', 'sk-new');
    expect(put).toHaveBeenCalledWith('/api/user-gateway/custom-providers/c1', {
      key: 'sk-new',
    });
    await svc.updateProvider('c1', { baseUrl: 'https://x', key: '' });
    expect(put).toHaveBeenCalledWith('/api/user-gateway/custom-providers/c1', {
      baseUrl: 'https://x',
      key: '',
    });
  });

  it('testProviderConfig：unwrap 出 null 时收敛成可诊断的失败结果（不返回 null）', async () => {
    post.mockResolvedValueOnce(envelope(null));
    const svc = useUserGateway();
    await expect(svc.testProviderConfig({ baseUrl: 'https://x' })).resolves.toEqual({
      ok: false,
      count: 0,
      models: [],
      error: '测试失败',
    });
    expect(post).toHaveBeenCalledWith('/api/user-gateway/providers/test', {
      baseUrl: 'https://x',
    });
  });
});

describe('detectModels（手动「检测/刷新」）', () => {
  it('成功：回填目录 + detectionSummary，detecting 复位', async () => {
    post.mockResolvedValueOnce(envelope({ edges: [{ e: 1 }], sources: { local: 1 } }));
    const svc = useUserGateway();
    const payload = await svc.detectModels();
    expect(payload.edges).toEqual([{ e: 1 }]);
    expect(svc.catalogEdges.value).toEqual([{ e: 1 }]);
    expect(svc.catalogSources.value).toEqual({ local: 1 });
    expect(svc.detectionSummary.value).toEqual({ local: 1 });
    expect(svc.detecting.value).toBe(false);
    expect(post).toHaveBeenCalledWith('/api/user-gateway/detect', {});
  });

  it('失败：错误面到 detectionSummary.errors（source=request）并 rethrow，detecting 仍复位', async () => {
    post.mockRejectedValueOnce(new Error('detect failed'));
    const svc = useUserGateway();
    await expect(svc.detectModels()).rejects.toThrow('detect failed');
    expect(svc.detecting.value).toBe(false);
    expect(svc.detectionSummary.value).toEqual({
      errors: [{ source: 'request', error: 'detect failed' }],
    });
  });
});

describe('CC 访问（endpoint + channel tokens）', () => {
  it('fetchCcTokens 非数组收敛为 []；issueCcToken 带 label 提交并回刷', async () => {
    get.mockResolvedValueOnce(envelope(null));
    const svc = useUserGateway();
    await svc.fetchCcTokens();
    expect(svc.ccTokens.value).toEqual([]);

    post.mockResolvedValueOnce(envelope({ id: 't1', key: 'plain' }));
    get.mockResolvedValue(envelope([]));
    const row = await svc.issueCcToken('agent');
    expect(post).toHaveBeenCalledWith('/api/user-gateway/cc/tokens', { label: 'agent' });
    expect(row).toEqual({ id: 't1', key: 'plain' });
  });

  it('revokeCcToken DELETE /cc/tokens/{id} 并回刷', async () => {
    del.mockResolvedValueOnce(envelope(null));
    get.mockResolvedValue(envelope([]));
    const svc = useUserGateway();
    await svc.revokeCcToken('t1');
    expect(del).toHaveBeenCalledWith('/api/user-gateway/cc/tokens/t1');
  });
});

describe('我的模型（CRUD，PATCH 更新）', () => {
  it('fetchModels：provider 走 query；空/非数组收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope([{ m: 1 }]));
    const svc = useUserGateway();
    await svc.fetchModels('acme');
    expect(get).toHaveBeenCalledWith('/api/user-gateway/models?provider=acme');
    expect(svc.models.value).toEqual([{ m: 1 }]);

    get.mockResolvedValueOnce(envelope(null));
    await svc.fetchModels();
    expect(svc.models.value).toEqual([]);
  });

  it('addModel POST / models；updateModel PATCH /models/{id}；removeModel DELETE', async () => {
    post.mockResolvedValueOnce(envelope({ id: 'm1' }));
    patch.mockResolvedValueOnce(envelope({ id: 'm1' }));
    del.mockResolvedValueOnce(envelope(null));
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();

    await svc.addModel({ provider: 'acme', model: 'gpt' });
    expect(post).toHaveBeenCalledWith('/api/user-gateway/models', {
      provider: 'acme',
      model: 'gpt',
    });
    await svc.updateModel('m1', { capability: 'chat' });
    expect(patch).toHaveBeenCalledWith('/api/user-gateway/models/m1', {
      capability: 'chat',
    });
    await svc.removeModel('m1');
    expect(del).toHaveBeenCalledWith('/api/user-gateway/models/m1');
  });
});

describe('fetchAll（8 项并发）', () => {
  it('命中全部端点并翻转 loading', async () => {
    get.mockResolvedValue(envelope({}));
    const svc = useUserGateway();
    await svc.fetchAll();
    const urls = get.mock.calls.map((c) => c[0]).sort();
    for (const expected of [
      '/api/user-gateway/model-config',
      '/api/user-gateway/custom-providers',
      '/api/user-gateway/catalog',
      '/api/user-gateway/cc/endpoint',
      '/api/user-gateway/cc/tokens',
      '/api/user-gateway/provider-presets',
      '/api/user-gateway/models',
      '/api/user-gateway/image-config',
    ]) {
      expect(urls).toContain(expected);
    }
    expect(urls).toHaveLength(8);
    expect(svc.loading.value).toBe(false);
  });
});
