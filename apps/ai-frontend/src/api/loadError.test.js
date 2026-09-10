import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useLoadError, describeLoadError, loadInto } from './loadError.js';

// These tests pin the shape the views render. The contract being enforced is
// repo rule 2.2: 问题 + 识别码 + 修复建议. "加载失败" alone is not accepted.
vi.mock('./notify.js', () => ({
  deriveErrorMessage: (err, opts) => {
    if (err?.userMessage) return err.userMessage;
    return opts?.fallback || '';
  },
}));

function httpError(status, message) {
  const err = new Error(message || `HTTP ${status}`);
  err.response = { status, data: { message } };
  return err;
}

describe('describeLoadError', () => {
  it('leads with the subject, not with "加载失败"', () => {
    const msg = describeLoadError(httpError(404), '用量日志');
    expect(msg).toMatch(/^用量日志加载失败/);
  });

  it('404 says the endpoint is missing, which is the actual cause', () => {
    const msg = describeLoadError(httpError(404), '模型定价');
    expect(msg).toContain('后端没有这个接口');
    expect(msg).toContain('请稍后重试');
  });

  it('401 points at re-login, 403 at permissions', () => {
    expect(describeLoadError(httpError(401), 'A')).toContain('登录已失效');
    expect(describeLoadError(httpError(403), 'A')).toContain('没有权限');
  });

  it('429 is a rate limit, not a generic 4xx', () => {
    expect(describeLoadError(httpError(429), 'A')).toContain('请求过于频繁');
  });

  it('carries the status code for 5xx', () => {
    expect(describeLoadError(httpError(502), 'A')).toContain('502');
  });

  it('falls back to the interceptor text when there is no status', () => {
    const msg = describeLoadError({ userMessage: '某渠道连接超时' }, 'A');
    expect(msg).toContain('某渠道连接超时');
  });

  it('accepts a custom fix action', () => {
    expect(describeLoadError(httpError(404), 'A', '请升级前端')).toContain('请升级前端');
  });

  it('never returns a bare "加载失败"', () => {
    expect(describeLoadError(httpError(404), '用量日志')).toMatch(/：.+，.+/);
  });
});

describe('useLoadError', () => {
  it('starts empty and stays a ref', () => {
    const err = useLoadError();
    expect(err.value).toBe('');
    err.value = 'x';
    expect(err.value).toBe('x');
  });
});

describe('loadInto', () => {
  it('clears the error on success and returns the payload', async () => {
    const loadError = ref('stale');
    const out = await loadInto('X', loadError, async () => ({ ok: 1 }));
    expect(out).toEqual({ ok: 1 });
    expect(loadError.value).toBe('');
  });

  it('records the failure and resolves instead of throwing', async () => {
    const loadError = ref('');
    const out = await loadInto('用量日志', loadError, async () => {
      throw httpError(404);
    });
    expect(out).toBeUndefined();
    expect(loadError.value).toContain('用量日志加载失败');
    expect(loadError.value).toContain('后端没有这个接口');
  });

  it('does not treat an explicit null as a failure', async () => {
    const loadError = ref('');
    const out = await loadInto('X', loadError, async () => null);
    expect(out).toBeNull();
    expect(loadError.value).toBe('');
  });
});
