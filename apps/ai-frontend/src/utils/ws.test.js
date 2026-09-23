import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * ws.js — 锁 WebSocket 端点推导的单一真源（repo 规则 1：禁止硬编码 host:port）。
 *   base = request.defaults.baseURL（VITE_AI_API_BASE_URL）设置时用它，否则页面 origin；
 *   https → wss，其余 → ws；路径归一为裸路径（query/fragment 不外泄）。
 * 用 vi.mock 打桩 @/api/request，不发任何真实请求。
 */

const defaultsMock = { baseURL: '' };

vi.mock('@/api/request', () => ({
  default: {
    defaults: defaultsMock,
  },
}));

const { resolveWsUrl } = await import('./ws');

afterEach(() => {
  delete globalThis.window;
  defaultsMock.baseURL = '';
});

describe('无 window（Node 环境/SSR）→ 返回裸路径', () => {
  it('默认路径 /ws', () => {
    expect(resolveWsUrl()).toBe('/ws');
  });

  it('自定义路径归一（去前导多余斜杠、补前导 /）', () => {
    expect(resolveWsUrl('ws/agent')).toBe('/ws/agent');
    expect(resolveWsUrl('//double//slash')).toBe('/double//slash');
    expect(resolveWsUrl(null)).toBe('/ws');
  });
});

describe('有 window（浏览器）→ 协议跟随页面/基础地址', () => {
  it('http origin → ws://', () => {
    globalThis.window = { location: { origin: 'http://host.example' } };
    expect(resolveWsUrl()).toBe('ws://host.example/ws');
  });

  it('https origin → wss://', () => {
    globalThis.window = { location: { origin: 'https://host.example' } };
    expect(resolveWsUrl('/ws/cross-platform')).toBe('wss://host.example/ws/cross-platform');
  });

  it('baseURL 优先于页面 origin（部署代理形态），尾斜杠被剥掉', () => {
    globalThis.window = { location: { origin: 'http://host.example' } };
    defaultsMock.baseURL = 'https://api.example.com/';
    expect(resolveWsUrl('/ws')).toBe('wss://api.example.com/ws');
  });

  it('页面 URL 的 query/fragment 不外泄到 WS 目标（origin 本身即无）', () => {
    globalThis.window = { location: { origin: 'https://host.example' } };
    const url = resolveWsUrl('/ws');
    expect(url).toBe('wss://host.example/ws');
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
  });
});
