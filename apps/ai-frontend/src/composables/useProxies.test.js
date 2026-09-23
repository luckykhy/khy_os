import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useProxies（代理管理：订阅组 + 出站桥）行为测试。
 * 锁 /api/proxy-subscriptions/* 与 /api/proxy-egress 的 URL 组装、
 * unwrap 回填、忙态翻转，以及出站失败被记录到共享 loadError
 * （描述文案遵守「问题 + 原因 + 修复建议」红线，不许含糊的「加载失败」）。
 * request 用 vi.mock 打桩，不发真实请求。
 */

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    delete: (...a) => del(...a),
  },
}));

const { useProxies } = await import('@/composables/useProxies');

const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
});

describe('订阅组 CRUD', () => {
  it('listGroups：subscriptions 数组 / 裸数组 / 非数组 三种载荷的收敛规则', async () => {
    get.mockResolvedValue(envelope({ subscriptions: [{ id: 'g1' }] }));
    const svc = useProxies();
    let out = await svc.listGroups();
    expect(out).toEqual([{ id: 'g1' }]);
    expect(get).toHaveBeenCalledWith('/api/proxy-subscriptions');
    expect(svc.loading.value).toBe(false);

    get.mockResolvedValueOnce(envelope([{ id: 'g2' }]));
    out = await svc.listGroups();
    expect(out).toEqual([{ id: 'g2' }]);

    get.mockResolvedValueOnce(envelope({ weird: 1 }));
    out = await svc.listGroups();
    expect(out).toEqual([]);
  });

  it('addSubscription：name 缺省不带 name 字段；回刷列表并返回新组', async () => {
    post.mockResolvedValueOnce(envelope({ id: 'g9' }));
    get.mockResolvedValue(envelope({ subscriptions: [] }));
    const svc = useProxies();
    await svc.addSubscription('sub://x');
    expect(post).toHaveBeenCalledWith('/api/proxy-subscriptions', {
      url: 'sub://x',
      name: undefined,
    });
    post.mockClear();
    await svc.addSubscription('sub://x', '我的组');
    expect(post).toHaveBeenCalledWith('/api/proxy-subscriptions', {
      url: 'sub://x',
      name: '我的组',
    });
  });

  it('addByContent 走同一端点但带 content（免 SSRF 面的文本导入）', async () => {
    post.mockResolvedValueOnce(envelope({ id: 'g10' }));
    get.mockResolvedValue(envelope({ subscriptions: [] }));
    const svc = useProxies();
    await svc.addByContent('raw-node-line');
    expect(post).toHaveBeenCalledWith('/api/proxy-subscriptions', {
      content: 'raw-node-line',
      name: undefined,
    });
  });

  it('refreshGroup / removeGroup 端点形状', async () => {
    post.mockResolvedValueOnce(envelope({ refreshed: true }));
    get.mockResolvedValue(envelope({ subscriptions: [] }));
    const svc = useProxies();
    await svc.refreshGroup('g1');
    expect(post).toHaveBeenCalledWith('/api/proxy-subscriptions/g1/refresh', {});
    await svc.removeGroup('g1');
    expect(del).toHaveBeenCalledWith('/api/proxy-subscriptions/g1');
  });

  it('getGroup 透传 unwrap（含节点明细）', async () => {
    get.mockResolvedValueOnce(envelope({ id: 'g1', nodes: [{ n: 1 }] }));
    const svc = useProxies();
    await expect(svc.getGroup('g1')).resolves.toEqual({ id: 'g1', nodes: [{ n: 1 }] });
  });
});

describe('出站桥（proxy-egress）', () => {
  it('fetchEgressStatus 成功回填 egressStatus 并清空 loadError', async () => {
    get.mockResolvedValue(envelope({ enabled: true, activeNode: 'n1' }));
    const svc = useProxies();
    svc.loadError.value = '旧的错误文案';
    const out = await svc.fetchEgressStatus();
    expect(out).toEqual({ enabled: true, activeNode: 'n1' });
    expect(svc.egressStatus.value).toEqual({ enabled: true, activeNode: 'n1' });
    expect(svc.loadError.value).toBe('');
  });

  it('fetchEgressStatus 失败 → 返回 null，loadError 记「出站状态加载失败：…，请确认 ai-backend 服务已启动后重试」', async () => {
    get.mockRejectedValueOnce(
      Object.assign(new Error('network down'), { response: { status: 500 } })
    );
    const svc = useProxies();
    await expect(svc.fetchEgressStatus()).resolves.toBeNull();
    expect(svc.egressStatus.value).toBeNull();
    // 锁红线：文案必须含 动作主体(出站状态) + 原因(服务端错误 500) + 修复建议
    expect(svc.loadError.value).toBe(
      '出站状态加载失败：服务端错误 (500)，请确认 ai-backend 服务已启动后重试'
    );
  });

  it('enableNode：POST /enable 带整节点；mixedPort 可选', async () => {
    post.mockResolvedValue(envelope({ success: true, egressMode: 'mixed' }));
    get.mockResolvedValue(envelope({ enabled: true }));
    const svc = useProxies();
    await svc.enableNode({ name: 'n1', url: 'u' });
    expect(post).toHaveBeenCalledWith('/api/proxy-egress/enable', {
      node: { name: 'n1', url: 'u' },
    });
    await svc.enableNode({ name: 'n2' }, 7890);
    expect(post).toHaveBeenCalledWith('/api/proxy-egress/enable', {
      node: { name: 'n2' },
      mixedPort: 7890,
    });
  });

  it('disableEgress POST /disable 后回刷出站状态', async () => {
    post.mockResolvedValueOnce(envelope({ success: true }));
    get.mockResolvedValue(envelope({ enabled: false }));
    const svc = useProxies();
    const out = await svc.disableEgress();
    expect(post).toHaveBeenCalledWith('/api/proxy-egress/disable', {});
    expect(out).toEqual({ success: true });
    expect(svc.egressStatus.value).toEqual({ enabled: false });
  });
});
