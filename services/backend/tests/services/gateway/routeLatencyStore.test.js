'use strict';
/**
 * routeLatencyStore �?per-adapter EWMA 延迟存储单元测试�? *
 * 注入临时 KHY_DATA_HOME(隔离持久化文�?,验证 EWMA 递推、非法样本忽略�? * getStats 形状(�?ageMs)、_reset。store �?fs IO 故非纯叶子�? */
const fs = require('fs');
const os = require('os');
const path = require('path');
// 隔离数据�?必须�?require store(�?dataHome 惰性缓�?之前设好�?const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'route-latency-store-'));
process.env.KHY_DATA_HOME = TMP;
const store = require('./routeLatencyStore');
describe('routeLatencyStore �?EWMA 递推与统�?, () => {
  before(() => {
    process.env.KHY_DATA_HOME = TMP;
  });
  after(() => {
    store._reset();
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  beforeEach(() => {
    store._reset();
  });
});

describe('Route Latency Store', () => {
  test('首样�?�?ewmaMs 直接置为该�?samples=1', () => {
        store.record('adapter:api', 2000);
        const s = store.getStats('adapter:api');
        expect(s.ewmaMs).toBe(2000);
        expect(s.samples).toBe(1);
        expect(s.ageMs >= 0 && s.ageMs < 5000).toBeTruthy();
  });

  test('EWMA 递推:α=0.3 默认 �?第二样本 = 0.3*x + 0.7*ewma', () => {
        const prev = process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA;
        delete process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA; // 用默�?0.3
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

  test('非法 latency(0/�?NaN/非数)�?忽略,不污�?EWMA、不�?samples', () => {
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

  test('未知 adapter �?{ ewmaMs:null, samples:0, ageMs:Infinity }', () => {
        const s = store.getStats('adapter:never-seen');
        expect(s.ewmaMs).toBe(null);
        expect(s.samples).toBe(0);
        expect(s.ageMs).toBe(Infinity);
  });

  test('持久�?record 写盘,重读 state 仍在(同进程内�?authoritative)', () => {
        store.record('adapter:persist', 4200);
        const report = store.getReport();
        expect(report.adapters['adapter:persist']).toBeTruthy();
        expect(report.adapters['adapter:persist'].ewmaMs).toBe(4200);
  });

  test('_reset �?清空', () => {
        store.record('adapter:tmp', 999);
        store._reset();
        const s = store.getStats('adapter:tmp');
        expect(s.samples).toBe(0);
  });

  test('绝不�?异常输入', () => {
        expect(() => store.record().not.toThrow());
        expect(() => store.record(null, null).not.toThrow());
        expect(() => store.getStats().not.toThrow());
  });

});

