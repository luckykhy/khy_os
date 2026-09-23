'use strict';
/**
 * routeLatencyStore — per-adapter EWMA 延迟存储单元测试。
 *
 * 注入临时 KHY_DATA_HOME(隔离持久化文件),验证 EWMA 递推、非法样本忽略、
 * getStats 形状(含 ageMs)、_reset。store 做 fs IO 故非纯叶子。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// 隔离数据家:必须在 require store 之前设好(store/dataHome 惰性缓存会读它)。
// jest.taskStoreIsolation.setup.js 已把每套件钉到一次性临时数据家,这里再显式
// 建一个本套件专属目录并覆盖,使 route_latency.json 完全受本套件掌控。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'route-latency-store-'));
process.env.KHY_DATA_HOME = TMP;
const store = require('../../../src/services/gateway/routeLatencyStore.js');

afterAll(() => {
  store._reset();
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Route Latency Store', () => {
  beforeEach(() => {
    store._reset();
  });

  test('首样本:ewmaMs 直接置为该值,samples=1', () => {
    store.record('adapter:api', 2000);
    const s = store.getStats('adapter:api');
    expect(s.ewmaMs).toBe(2000);
    expect(s.samples).toBe(1);
    expect(s.ageMs >= 0 && s.ageMs < 5000).toBeTruthy();
  });

  test('EWMA 递推:α=0.3 默认下第二样本 = 0.3*x + 0.7*ewma', () => {
    const prev = process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA;
    delete process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA; // 用默认 0.3
    store.record('adapter:relay', 1000);
    store.record('adapter:relay', 5000);
    const s = store.getStats('adapter:relay');
    // 0.3*5000 + 0.7*1000 = 1500 + 700 = 2200
    expect(Math.round(s.ewmaMs)).toBe(2200);
    expect(s.samples).toBe(2);
    if (prev !== undefined) {
      process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA = prev;
    }
  });

  test('非法 latency(0/负/NaN/非数)→ 忽略,不污染 EWMA、不增 samples', () => {
    store.record('adapter:x', 3000);
    store.record('adapter:x', 0);
    store.record('adapter:x', -100);
    store.record('adapter:x', NaN);
    store.record('adapter:x', 'slow');
    const s = store.getStats('adapter:x');
    expect(s.ewmaMs).toBe(3000);
    expect(s.samples).toBe(1);
  });

  test('key 大小写归一(adapter:API === adapter:api)', () => {
    store.record('adapter:API', 1234);
    const s = store.getStats('adapter:api');
    expect(s.ewmaMs).toBe(1234);
  });

  test('未知 adapter → { ewmaMs:null, samples:0, ageMs:Infinity }', () => {
    const s = store.getStats('adapter:never-seen');
    expect(s.ewmaMs).toBe(null);
    expect(s.samples).toBe(0);
    expect(s.ageMs).toBe(Infinity);
  });

  test('持久化:record 写盘,重读 state 仍在(同进程内 authoritative)', () => {
    store.record('adapter:persist', 4200);
    const report = store.getReport();
    expect(report.adapters['adapter:persist']).toBeTruthy();
    expect(report.adapters['adapter:persist'].ewmaMs).toBe(4200);
  });

  test('_reset → 清空', () => {
    store.record('adapter:tmp', 999);
    store._reset();
    const s = store.getStats('adapter:tmp');
    expect(s.samples).toBe(0);
  });

  test('绝不抛:异常输入', () => {
    expect(() => store.record()).not.toThrow();
    expect(() => store.record(null, null)).not.toThrow();
    expect(() => store.getStats()).not.toThrow();
  });
});
