import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * useConfigSync（四端配置同步 Web 端）接线契约测试。
 * 源级说明：vitest 跑在 node 环境，这里只锁定 REST 调用的 URL 契约 ——
 * vite 代理只转发 /api 与 /ws 前缀（apps/ai-frontend/vite.config.js），
 * 因此所有 REST 调用必须带 /api 前缀，否则请求根本到不了后端。
 * request 用 vi.mock 打桩，不发真实请求。
 */

const get = vi.fn();
const post = vi.fn();

vi.mock('@/api/request', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
  },
}));

/**
 * 后端统一响应封装形状。ai-frontend 的 request 拦截器返回完整 axios
 * response（见 src/api/request.js），故 useConfigSync 内
 * `const { data } = await request.get(...)` 解构的是 response.data。
 */
const envelope = (data) => ({ data: { success: true, data } });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  vi.resetModules();
});

const loadModule = () => import('@/composables/useConfigSync');

describe('REST 调用必须带 /api 前缀（vite 代理契约）', () => {
  it('get(key) 走 /api/config-sync/:key', async () => {
    get.mockResolvedValueOnce(envelope({ key: 'gateway.apiKey', value: 'sk-test' }));
    const { useConfigSync } = await loadModule();
    const svc = useConfigSync();
    const value = await svc.get('gateway.apiKey');
    expect(value).toBe('sk-test');
    expect(get).toHaveBeenCalledWith(
      '/api/config-sync/gateway.apiKey',
      expect.objectContaining({ timeout: 5000, __skipErrorNotify: true })
    );
  });

  it('getAll() 拉全量走 /api/config-sync', async () => {
    get.mockResolvedValueOnce(
      envelope({ 'gateway.apiKey': { value: 'sk-1' }, 'ui.theme': { value: 'dark' } })
    );
    const { useConfigSync } = await loadModule();
    const svc = useConfigSync();
    const all = await svc.getAll();
    expect(all['gateway.apiKey']).toBe('sk-1');
    expect(get).toHaveBeenCalledWith(
      '/api/config-sync',
      expect.objectContaining({ timeout: 5000, __skipErrorNotify: true })
    );
  });

  it('syncAll() 推 dirty 键走 /api/config-sync/bulk', async () => {
    get.mockResolvedValueOnce(envelope({}));
    const { useConfigSync } = await loadModule();
    const svc = useConfigSync();
    await svc.set('gateway.apiKey', 'sk-new');
    await svc.syncAll();
    expect(post).toHaveBeenCalledWith(
      '/api/config-sync/bulk',
      expect.objectContaining({ settings: { 'gateway.apiKey': 'sk-new' } }),
      expect.objectContaining({ timeout: 5000 })
    );
  });

  it('防抖推送 _pushToCloud 也走 /api/config-sync/bulk', async () => {
    vi.useFakeTimers();
    try {
      post.mockResolvedValueOnce({ data: { success: true } });
      const { useConfigSync } = await loadModule();
      const svc = useConfigSync();
      await svc.set('ui.theme', 'dark');
      // 防抖 1s：立即调用，防抖窗口内被推到云端
      await vi.advanceTimersByTimeAsync(1100);
      expect(post).toHaveBeenCalledWith(
        '/api/config-sync/bulk',
        expect.objectContaining({ settings: { 'ui.theme': 'dark' } }),
        expect.objectContaining({ timeout: 5000 })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('get 失败 fail-soft：返回 defaultValue，不抛', async () => {
    get.mockRejectedValueOnce(new Error('backend down'));
    const { useConfigSync } = await loadModule();
    const svc = useConfigSync();
    await expect(svc.get('missing.key', 'fallback')).resolves.toBe('fallback');
  });
});
