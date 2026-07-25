'use strict';

/**
 * routeLatencyAware.e2e.test.js — 延迟感知路由端到端接线验证。
 *
 * 直接驱动 aiGateway 单例的 `_assessDefaultRouteCandidate`,经 require-cache 注入一个假的
 * routeLatencyStore(返回受控延迟统计),验证:
 *   - 两通道都健康、A 快 B 慢 → B 多一笔 slow_latency 软罚分 → B.score > A.score;
 *   - 该软罚分**不足以**把 B 踢出健康集(B.totalPenalty < healthyPenaltyCeiling,healthyDefault 仍真、blocked 仍假);
 *   - 门关 KHY_ROUTE_LATENCY_AWARE=off → 两通道 score 相等(逐字节回退今天);
 *   - store 空(冷启动 samples<3)→ 无延迟罚分。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const STORE_PATH = require.resolve('./routeLatencyStore');

// 假 store:按 adapterKey 返回预置统计。
let _fakeStats = {};
function _installFakeStore() {
  require.cache[STORE_PATH] = {
    id: STORE_PATH,
    filename: STORE_PATH,
    loaded: true,
    exports: {
      record() {},
      getStats(adapterKey) {
        const k = String(adapterKey || '').toLowerCase();
        return _fakeStats[k] || { ewmaMs: null, samples: 0, ageMs: Infinity };
      },
      getReport() { return { adapters: {} }; },
      _reset() {},
    },
  };
}
function _restoreStore() {
  delete require.cache[STORE_PATH];
}

// 造一个「健康」候选 entry:enabled + available + 一个最小 adapter stub。
function _entry(key) {
  return {
    key,
    enabled: true,
    available: true,
    adapter: {
      getStatus() { return { name: key, available: true }; },
    },
  };
}

const gateway = require('./aiGateway');

describe('延迟感知路由 E2E', () => {
  const savedFlag = process.env.KHY_ROUTE_LATENCY_AWARE;

  beforeEach(() => {
    _fakeStats = {};
    _installFakeStore();
  });
  afterEach(() => {
    _restoreStore();
    if (savedFlag === undefined) delete process.env.KHY_ROUTE_LATENCY_AWARE;
    else process.env.KHY_ROUTE_LATENCY_AWARE = savedFlag;
  });

  test('A 快 B 慢 → B 多 slow_latency 罚分,B.score > A.score', () => {
    delete process.env.KHY_ROUTE_LATENCY_AWARE; // 默认开
    _fakeStats = {
      'adapter:fastone': { ewmaMs: 700, samples: 20, ageMs: 1000 }, // fast → 0
      'adapter:slowone': { ewmaMs: 12000, samples: 20, ageMs: 1000 }, // very_slow → 罚分
    };
    const a = gateway._assessDefaultRouteCandidate(_entry('fastone'));
    const b = gateway._assessDefaultRouteCandidate(_entry('slowone'));

    const aHasLat = a.reasons.some((r) => r.code === 'slow_latency');
    const bHasLat = b.reasons.some((r) => r.code === 'slow_latency');
    assert.equal(aHasLat, false, '快通道无延迟罚分');
    assert.equal(bHasLat, true, '慢通道有延迟罚分');
    // basePriority 相同(同为未知 adapter)前提下,B 因延迟罚分 score 更高(更差)。
    assert.equal(a.basePriority, b.basePriority, '前提:两者 basePriority 相同');
    assert.ok(b.score > a.score, `慢通道 score 应更高: a=${a.score} b=${b.score}`);
  });

  test('延迟罚分不足以把慢通道踢出健康集(仍 healthyDefault、未 blocked)', () => {
    delete process.env.KHY_ROUTE_LATENCY_AWARE;
    _fakeStats = {
      'adapter:slowbutok': { ewmaMs: 15000, samples: 30, ageMs: 500 },
    };
    const b = gateway._assessDefaultRouteCandidate(_entry('slowbutok'));
    assert.equal(b.blocked, false, '慢≠不可用,绝不 blocked');
    assert.equal(b.healthyDefault, true, '单笔延迟罚分不越健康集');
    // 延迟罚分 < healthyPenaltyCeiling(默认 40)
    const latReason = b.reasons.find((r) => r.code === 'slow_latency');
    assert.ok(latReason, '有延迟罚分');
    assert.ok(latReason.penalty < 40, `罚分硬顶在 ceiling 之下: ${latReason.penalty}`);
  });

  test('门关 KHY_ROUTE_LATENCY_AWARE=off → 慢通道无延迟罚分(逐字节回退)', () => {
    process.env.KHY_ROUTE_LATENCY_AWARE = 'off';
    _fakeStats = {
      'adapter:slowoff': { ewmaMs: 20000, samples: 30, ageMs: 500 },
    };
    const b = gateway._assessDefaultRouteCandidate(_entry('slowoff'));
    const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
    assert.equal(hasLat, false, '门关 → 无延迟罚分');
  });

  test('冷启动(samples<3)→ 无延迟罚分', () => {
    delete process.env.KHY_ROUTE_LATENCY_AWARE;
    _fakeStats = {
      'adapter:cold': { ewmaMs: 20000, samples: 2, ageMs: 500 },
    };
    const b = gateway._assessDefaultRouteCandidate(_entry('cold'));
    const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
    assert.equal(hasLat, false, '样本不足 → 不判罚');
  });

  test('陈旧统计(ageMs 超 STALE_MS)→ 无延迟罚分', () => {
    delete process.env.KHY_ROUTE_LATENCY_AWARE;
    _fakeStats = {
      'adapter:stale': { ewmaMs: 20000, samples: 30, ageMs: 3600000 }, // 1h > 30min
    };
    const b = gateway._assessDefaultRouteCandidate(_entry('stale'));
    const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
    assert.equal(hasLat, false, '陈旧 → 不判罚(通道可能已恢复)');
  });
});
