import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeGet, safeSet, safeRemove, TOKEN_KEY, REFRESH_TOKEN_KEY } from './safeStorage';

/**
 * safeStorage — 锁「守卫式」localStorage 包装的 try/catch 语义：
 * 读失败回 null、写/删失败静默吞掉。绝不改变调用点原有行为。
 * Node 环境没有真实 localStorage，用内存 stub 注入。
 */

function makeMemoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    _dump: () => Object.fromEntries(store),
  };
}

function makeBrokenStorage() {
  return {
    getItem: () => {
      throw new Error('SecurityError: storage access denied');
    },
    setItem: () => {
      throw new Error('SecurityError: storage access denied');
    },
    removeItem: () => {
      throw new Error('SecurityError: storage access denied');
    },
  };
}

afterEach(() => {
  delete globalThis.localStorage;
});

describe('TOKEN_KEY / REFRESH_TOKEN_KEY 常量', () => {
  it('登录 token 键名必须保持字面量 "token"（收敛别名，不许漂移）', () => {
    expect(TOKEN_KEY).toBe('token');
    expect(REFRESH_TOKEN_KEY).toBe('refresh_token');
  });
});

describe('健康 localStorage 下的读写语义', () => {
  it('safeGet 命中返回原值，未命中返回 null', () => {
    globalThis.localStorage = makeMemoryStorage();
    expect(safeGet('nope')).toBeNull();
    globalThis.localStorage.setItem('k', 'v');
    expect(safeGet('k')).toBe('v');
  });

  it('safeSet 落盘（stringify 后的值），safeRemove 清除', () => {
    globalThis.localStorage = makeMemoryStorage();
    safeSet('auth', 'abc');
    expect(globalThis.localStorage._dump().auth).toBe('abc');
    safeRemove('auth');
    expect(safeGet('auth')).toBeNull();
  });
});

describe('故障 localStorage 下的守卫语义（核心不变式）', () => {
  it('safeGet 抛错 → 回 null（不向调用方冒泡）', () => {
    globalThis.localStorage = makeBrokenStorage();
    expect(safeGet('token')).toBeNull();
  });

  it('safeSet 抛错 → 静默吞掉，不抛', () => {
    globalThis.localStorage = makeBrokenStorage();
    expect(() => safeSet('token', 'x')).not.toThrow();
  });

  it('safeRemove 抛错 → 静默吞掉，不抛', () => {
    globalThis.localStorage = makeBrokenStorage();
    expect(() => safeRemove('token')).not.toThrow();
  });

  it('localStorage 完全缺失（undefined 属性访问抛 ReferenceError 的等价物）→ 全部守卫住', () => {
    // 模拟引用即抛错的宿主：属性 getter 抛错，等价于私有模式下 storage 不可用。
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('localStorage unavailable');
      },
      configurable: true,
    });
    expect(safeGet('x')).toBeNull();
    expect(() => safeSet('x', '1')).not.toThrow();
    expect(() => safeRemove('x')).not.toThrow();
    vi.restoreAllMocks();
  });
});
