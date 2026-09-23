import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useMarketplace（插件市场 + 已装插件）行为测试。
 * 锁 /api/marketplace/* 与 /api/plugins/* 的 URL 组装、unwrap 回填、
 * 忙态/加载态翻转，以及 install 的 authConfig 条件携带规则。
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

const { useMarketplace } = await import('@/composables/useMarketplace');

const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('目录浏览', () => {
  it('listCatalog 透传筛选参数，空载荷收敛为 []', async () => {
    get.mockResolvedValueOnce(envelope([{ p: 1 }]));
    const svc = useMarketplace();
    const out = await svc.listCatalog({ q: 'x' });
    expect(get).toHaveBeenCalledWith('/api/marketplace', { params: { q: 'x' } });
    expect(out).toEqual([{ p: 1 }]);
    expect(svc.loading.value).toBe(false);

    get.mockResolvedValueOnce(envelope(null));
    await svc.listCatalog();
    expect(svc.catalog.value).toEqual([]);
  });

  it('fetchCategories / getDetail 端点形状', async () => {
    get.mockResolvedValueOnce(envelope([{ c: 1 }]));
    const svc = useMarketplace();
    await svc.fetchCategories();
    expect(get).toHaveBeenCalledWith('/api/marketplace/categories');
    expect(svc.categories.value).toEqual([{ c: 1 }]);

    get.mockResolvedValueOnce(envelope({ detail: 1 }));
    await expect(svc.getDetail('m1')).resolves.toEqual({ detail: 1 });
    expect(get).toHaveBeenCalledWith('/api/marketplace/m1');
  });

  it('install：带 authConfig 才携带；uninstallFromCatalog 空对象提交', async () => {
    post.mockResolvedValue(envelope({ ok: 1 }));
    const svc = useMarketplace();
    await svc.install('m1');
    expect(post).toHaveBeenCalledWith('/api/marketplace/m1/install', {});
    await svc.install('m1', { key: 'k' });
    expect(post).toHaveBeenCalledWith('/api/marketplace/m1/install', {
      authConfig: { key: 'k' },
    });
    await svc.uninstallFromCatalog('m1');
    expect(post).toHaveBeenCalledWith('/api/marketplace/m1/uninstall', {});
  });
});

describe('已装插件管理', () => {
  it('importPlugin / setEnabled / setAuth / uninstall 都回刷已装列表', async () => {
    post.mockResolvedValue(envelope({}));
    patch.mockResolvedValue(envelope({}));
    put.mockResolvedValue(envelope({}));
    del.mockResolvedValue(envelope(null));
    get.mockResolvedValue(envelope([]));
    const svc = useMarketplace();

    await svc.importPlugin({ source: 'raw' });
    expect(post).toHaveBeenCalledWith('/api/plugins/import', { source: 'raw' });

    await svc.setEnabled('i1', false);
    expect(patch).toHaveBeenCalledWith('/api/plugins/i1', { enabled: false });

    await svc.setAuth('i1', { token: 't' });
    expect(put).toHaveBeenCalledWith('/api/plugins/i1/auth', {
      authConfig: { token: 't' },
    });

    await svc.uninstall('i1');
    expect(del).toHaveBeenCalledWith('/api/plugins/i1');
    // 每次写操作后都回刷（GET /api/plugins 至少 4 次）
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('testInvoke：args 缺省收敛为 {}（工具调用形状固定）', async () => {
    post.mockResolvedValueOnce(envelope({ result: 'ok' }));
    const svc = useMarketplace();
    await svc.testInvoke('i1', 'op1');
    expect(post).toHaveBeenCalledWith('/api/plugins/i1/test', {
      operationId: 'op1',
      args: {},
    });
  });

  it('listPluginTools 返回可调用工具名列表（workflow toolCall 选择器消费）', async () => {
    get.mockResolvedValueOnce(
      envelope(['plugin__alpha__op', 'plugin__beta__op'])
    );
    const svc = useMarketplace();
    await expect(svc.listPluginTools()).resolves.toEqual([
      'plugin__alpha__op',
      'plugin__beta__op',
    ]);
    expect(get).toHaveBeenCalledWith('/api/plugins/tools');
  });
});
