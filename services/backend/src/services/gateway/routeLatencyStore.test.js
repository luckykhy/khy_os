'use strict';

/**
 * routeLatencyStore — per-adapter EWMA 延迟存储单元测试。
 *
 * 注入临时 KHY_DATA_HOME(隔离持久化文件),验证 EWMA 递推、非法样本忽略、
 * getStats 形状(含 ageMs)、_reset。store 做 fs IO 故非纯叶子。
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离数据家:必须在 require store(→ dataHome 惰性缓存)之前设好。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'route-latency-store-'));
process.env.KHY_DATA_HOME = TMP;

const store = require('./routeLatencyStore');

describe('routeLatencyStore — EWMA 递推与统计', () => {
  before(() => { process.env.KHY_DATA_HOME = TMP; });
  after(() => {
    store._reset();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  beforeEach(() => { store._reset(); });

  test('首样本 → ewmaMs 直接置为该值,samples=1', () => {
    store.record('adapter:api', 2000);
    const s = store.getStats('adapter:api');
    assert.equal(s.ewmaMs, 2000);
    assert.equal(s.samples, 1);
    assert.ok(s.ageMs >= 0 && s.ageMs < 5000, `ageMs 新鲜: ${s.ageMs}`);
  });

  test('EWMA 递推:α=0.3 默认 → 第二样本 = 0.3*x + 0.7*ewma', () => {
    const prev = process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA;
    delete process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA; // 用默认 0.3
    store.record('adapter:relay', 1000);
    store.record('adapter:relay', 5000);
    const s = store.getStats('adapter:relay');
    // 0.3*5000 + 0.7*1000 = 1500 + 700 = 2200
    assert.equal(Math.round(s.ewmaMs), 2200);
    assert.equal(s.samples, 2);
    if (prev !== undefined) process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA = prev;
  });

  test('非法 latency(0/负/NaN/非数)→ 忽略,不污染 EWMA、不增 samples', () => {
    store.record('adapter:x', 3000);
    store.record('adapter:x', 0);
    store.record('adapter:x', -100);
    store.record('adapter:x', NaN);
    store.record('adapter:x', 'slow');
    const s = store.getStats('adapter:x');
    assert.equal(s.ewmaMs, 3000);
    assert.equal(s.samples, 1);
  });

  test('key 大小写归一(adapter:API === adapter:api)', () => {
    store.record('adapter:API', 1234);
    const s = store.getStats('adapter:api');
    assert.equal(s.ewmaMs, 1234);
  });

  test('未知 adapter → { ewmaMs:null, samples:0, ageMs:Infinity }', () => {
    const s = store.getStats('adapter:never-seen');
    assert.equal(s.ewmaMs, null);
    assert.equal(s.samples, 0);
    assert.equal(s.ageMs, Infinity);
  });

  test('持久化:record 写盘,重读 state 仍在(同进程内存 authoritative)', () => {
    store.record('adapter:persist', 4200);
    const report = store.getReport();
    assert.ok(report.adapters['adapter:persist']);
    assert.equal(report.adapters['adapter:persist'].ewmaMs, 4200);
  });

  test('_reset → 清空', () => {
    store.record('adapter:tmp', 999);
    store._reset();
    const s = store.getStats('adapter:tmp');
    assert.equal(s.samples, 0);
  });

  test('绝不抛:异常输入', () => {
    assert.doesNotThrow(() => store.record());
    assert.doesNotThrow(() => store.record(null, null));
    assert.doesNotThrow(() => store.getStats());
  });
});
