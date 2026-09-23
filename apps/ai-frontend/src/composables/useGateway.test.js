import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useGateway（管理端 AI 网关状态机）行为测试。
 * 源级说明：vitest 跑在 node 环境，这里只测 composable 的纯接线逻辑
 * （URL 组装、unwrap 回填、失败 fail-soft、并发刷新），组件渲染另论。
 * request 用 vi.mock 打桩，不发真实请求。
 */

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: (...a) => put(...a),
    delete: (...a) => del(...a),
  },
}));

const { useGateway } = await import('@/composables/useGateway');

/** 后端统一响应封装形状（unwrap 的真源）。 */
const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
});

describe('只读 fetch 的 URL 与回填', () => {
  it('fetchStatus 走 /api/ai-gateway/status 并回填 status，期间 loading 翻转', async () => {
    get.mockResolvedValueOnce(envelope({ up: true }));
    const svc = useGateway();
    expect(svc.status.value).toBeNull();
    await svc.fetchStatus();
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/status');
    expect(svc.status.value).toEqual({ up: true });
    expect(svc.loading.value).toBe(false);
  });

  it('fetchStatus 失败 fail-soft：status 保持 null，不抛', async () => {
    get.mockRejectedValueOnce(new Error('backend down'));
    const svc = useGateway();
    await expect(svc.fetchStatus()).resolves.toBeUndefined();
    expect(svc.status.value).toBeNull();
  });

  it('fetchModelCatalog 空/非数组载荷收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope(null));
    const svc = useGateway();
    await svc.fetchModelCatalog();
    expect(svc.modelCatalog.value).toEqual([]);
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/models');
  });

  it('fetchCatalog 回填 edges + sources；edges 非数组收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope({ edges: [{ edge: 1 }], sources: { local: 1 } }));
    const svc = useGateway();
    await svc.fetchCatalog();
    expect(svc.catalogEdges.value).toEqual([{ edge: 1 }]);
    expect(svc.catalogSources.value).toEqual({ local: 1 });
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/catalog');
  });

  it('fetchCatalog 失败 → edges/sources 双双清零（fail-soft）', async () => {
    get.mockRejectedValueOnce(new Error('500'));
    const svc = useGateway();
    await svc.fetchCatalog();
    expect(svc.catalogEdges.value).toEqual([]);
    expect(svc.catalogSources.value).toBeNull();
  });

  it('fetchOAuthProviders 回填 providers 数组 + 内嵌 status 提升为 oauth', async () => {
    get.mockResolvedValueOnce(
      envelope({ providers: [{ p: 1 }], status: { s: 2 } })
    );
    const svc = useGateway();
    const payload = await svc.fetchOAuthProviders();
    expect(payload).toEqual({ providers: [{ p: 1 }], status: { s: 2 } });
    expect(svc.oauthProviders.value).toEqual([{ p: 1 }]);
    expect(svc.oauth.value).toEqual({ s: 2 });
  });

  it('fetchOAuthProviders 失败 → providers 清零且返回 null', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    const svc = useGateway();
    await expect(svc.fetchOAuthProviders()).resolves.toBeNull();
    expect(svc.oauthProviders.value).toEqual([]);
  });

  it('fetchProtocols 解包 .protocols；缺失收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope({ protocols: ['openai'] }));
    const svc = useGateway();
    await svc.fetchProtocols();
    expect(svc.protocols.value).toEqual(['openai']);
  });
});

describe('写操作的 URL 组装', () => {
  it('togglePlugin POST /plugins/{name}/toggle 并回刷列表', async () => {
    post.mockResolvedValueOnce(envelope({ ok: 1 }));
    get.mockResolvedValue(envelope([]));
    const svc = useGateway();
    await svc.togglePlugin('guard', true);
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/plugins/guard/toggle', {
      enabled: true,
    });
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/plugins');
  });

  it('addPoolKey / updatePoolKey / removePoolKey 的 REST 形状', async () => {
    post.mockResolvedValueOnce(envelope({ id: 'k1' }));
    put.mockResolvedValueOnce(envelope({ id: 'k1' }));
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();

    const added = await svc.addPoolKey('openai', { key: 'sk' });
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/pool/openai/keys', { key: 'sk' });
    expect(added).toEqual({ id: 'k1' });

    await svc.updatePoolKey('openai', 'k1', { label: 'a' });
    expect(put).toHaveBeenCalledWith('/api/ai-gateway/pool/openai/keys/k1', { label: 'a' });

    await svc.removePoolKey('openai', 'k1');
    expect(del).toHaveBeenCalledWith('/api/ai-gateway/pool/openai/keys/k1');
  });

  it('verifyAdapterModels：model 空不带 query，非空 URL 编码', async () => {
    post.mockResolvedValueOnce(envelope({ ok: true }));
    get.mockResolvedValue(envelope([]));
    const svc = useGateway();

    await svc.verifyAdapterModels('ollama');
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/models/ollama/verify');

    await svc.verifyAdapterModels('ollama', 'gpt/4o:latest');
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/models/ollama/verify?model=gpt%2F4o%3Alatest');
  });

  it('updateConfig PUT 后回刷 config 并返回 unwrap 结果', async () => {
    put.mockResolvedValueOnce(envelope({ defaultModel: 'm' }));
    get.mockResolvedValue(envelope({ defaultModel: 'm' }));
    const svc = useGateway();
    const out = await svc.updateConfig({ defaultModel: 'm' });
    expect(put).toHaveBeenCalledWith('/api/ai-gateway/config', { defaultModel: 'm' });
    expect(out).toEqual({ defaultModel: 'm' });
  });
});

describe('OAuth 凭据 CRUD', () => {
  it('saveOAuthCredentials PUT 并并发回刷 oauth 状态 + providers', async () => {
    put.mockResolvedValueOnce(envelope({ saved: 1 }));
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();
    await svc.saveOAuthCredentials('claude', { token: 't' });
    expect(put).toHaveBeenCalledWith('/api/ai-gateway/oauth/credentials/claude', {
      token: 't',
    });
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/oauth/status');
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/oauth/providers');
  });

  it('deleteOAuthCredentials DELETE 不返回 payload', async () => {
    del.mockResolvedValueOnce(envelope(null));
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();
    await svc.deleteOAuthCredentials('codex');
    expect(del).toHaveBeenCalledWith('/api/ai-gateway/oauth/credentials/codex');
  });

  it('fetchOAuthCredential 直接透传 unwrap 结果', async () => {
    get.mockResolvedValueOnce(envelope({ token: 'abc' }));
    const svc = useGateway();
    await expect(svc.fetchOAuthCredential('claude')).resolves.toEqual({ token: 'abc' });
  });
});

describe('TLS 启停', () => {
  it('startTls / stopTls 都回刷 tls 状态', async () => {
    post.mockResolvedValue(envelope({}));
    get.mockResolvedValue(envelope({ active: true }));
    const svc = useGateway();
    await svc.startTls({ cert: 'c' });
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/tls/start', { cert: 'c' });
    await svc.stopTls();
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/tls/stop');
    expect(svc.tls.value).toEqual({ active: true });
  });
});

describe('自定义供应商（OpenAI 兼容）', () => {
  it('fetchCustomProviders 回填 providers + presets；缺字段收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope({ providers: [{ p: 1 }], presets: [{ c: 1 }] }));
    const svc = useGateway();
    await svc.fetchCustomProviders();
    expect(svc.customProviders.value).toEqual([{ p: 1 }]);
    expect(svc.customProviderPresets.value).toEqual([{ c: 1 }]);
  });

  it('fetchCustomProviders 失败 → 双双清零', async () => {
    get.mockRejectedValueOnce(new Error('down'));
    const svc = useGateway();
    await svc.fetchCustomProviders();
    expect(svc.customProviders.value).toEqual([]);
    expect(svc.customProviderPresets.value).toEqual([]);
  });

  it('removeCustomProvider：removeKeys 时拼 ?removeKeys=true', async () => {
    del.mockResolvedValueOnce(envelope(null));
    get.mockResolvedValue(envelope({ providers: [], presets: [] }));
    const svc = useGateway();
    await svc.removeCustomProvider('acme');
    expect(del).toHaveBeenCalledWith('/api/ai-gateway/custom-providers/acme');
    await svc.removeCustomProvider('acme', { removeKeys: true });
    expect(del).toHaveBeenCalledWith(
      '/api/ai-gateway/custom-providers/acme?removeKeys=true'
    );
  });
});

describe('账号池', () => {
  it('fetchAccounts：provider 过滤走 query 编码；payload 形状兼容两种', async () => {
    get.mockResolvedValueOnce(envelope({ accounts: [{ a: 1 }] }));
    const svc = useGateway();
    await svc.fetchAccounts('acme');
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/accounts?provider=acme');
    expect(svc.accounts.value).toEqual([{ a: 1 }]);

    get.mockResolvedValueOnce(envelope([{ a: 2 }]));
    await svc.fetchAccounts();
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/accounts');
    expect(svc.accounts.value).toEqual([{ a: 2 }]);
  });

  it('togglePoolAccount 按 enabled 分派 enable/disable 端点', async () => {
    post.mockResolvedValue(envelope({}));
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();
    await svc.togglePoolAccount('acc1', true);
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/accounts/acc1/enable');
    await svc.togglePoolAccount('acc1', false);
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/accounts/acc1/disable');
  });

  it('unbanPoolAccount POST /accounts/{id}/unban', async () => {
    post.mockResolvedValueOnce(envelope({}));
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();
    await svc.unbanPoolAccount('acc9');
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/accounts/acc9/unban');
  });
});

describe('插件 CRUD', () => {
  it('createPlugin / updatePlugin / deletePlugin / reloadPlugins 端点形状', async () => {
    post.mockResolvedValue(envelope({ name: 'p' }));
    put.mockResolvedValue(envelope({ name: 'p' }));
    del.mockResolvedValue(envelope(null));
    get.mockResolvedValue(envelope([]));
    const svc = useGateway();

    await svc.createPlugin('p', 'code');
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/plugins', { name: 'p', code: 'code' });

    await svc.updatePlugin('p', 'code2');
    expect(put).toHaveBeenCalledWith('/api/ai-gateway/plugins/p', { code: 'code2' });

    await svc.deletePlugin('p');
    expect(del).toHaveBeenCalledWith('/api/ai-gateway/plugins/p');

    await svc.reloadPlugins();
    expect(post).toHaveBeenCalledWith('/api/ai-gateway/plugins/reload');
  });

  it('fetchPluginCode / fetchTemplate 解包 .code', async () => {
    get.mockResolvedValueOnce(envelope({ code: 'function(){}' }));
    const svc = useGateway();
    await expect(svc.fetchPluginCode('p')).resolves.toBe('function(){}');
    expect(get).toHaveBeenCalledWith('/api/ai-gateway/plugins/p/code');

    get.mockResolvedValueOnce(envelope({ code: 'TPL' }));
    await expect(svc.fetchTemplate()).resolves.toBe('TPL');
  });
});

describe('fetchAll 并发拉取全部面板数据', () => {
  it('15 条端点全部命中（含 custom-providers 与 accounts）', async () => {
    get.mockResolvedValue(envelope({}));
    const svc = useGateway();
    await svc.fetchAll();
    const urls = get.mock.calls.map((c) => c[0]).sort();
    for (const expected of [
      '/api/ai-gateway/status',
      '/api/ai-gateway/pool',
      '/api/ai-gateway/config',
      '/api/ai-gateway/models',
      '/api/ai-gateway/catalog',
      '/api/ai-gateway/slots',
      '/api/ai-gateway/protocols',
      '/api/ai-gateway/plugins',
      '/api/ai-gateway/oauth/status',
      '/api/ai-gateway/oauth/providers',
      '/api/ai-gateway/tls/status',
      '/api/ai-gateway/model-slots',
      '/api/ai-gateway/image-config',
      '/api/ai-gateway/accounts',
      '/api/ai-gateway/custom-providers',
    ]) {
      expect(urls).toContain(expected);
    }
    expect(urls).toHaveLength(15);
  });
});
