'use strict';
/**
 * routeLatencyAware.e2e.test.js �?延迟感知路由端到端接线验证�? *
 * 直接驱动 aiGateway 单例�?`_assessDefaultRouteCandidate`,�?require-cache 注入一个假�? * routeLatencyStore(返回受控延迟统计),验证:
 *   - 两通道都健康、A �?B �?�?B 多一�?slow_latency 软罚�?�?B.score > A.score;
 *   - 该软罚分**不足�?*�?B 踢出健康�?B.totalPenalty < healthyPenaltyCeiling,healthyDefault 仍真、blocked 仍假);
 *   - 门关 KHY_ROUTE_LATENCY_AWARE=off �?两通道 score 相等(逐字节回退今天);
 *   - store �?冷启�?samples<3)�?无延迟罚分�? */
const path = require('path');
const STORE_PATH = require.resolve('./routeLatencyStore');
// �?store:�?adapterKey 返回预置统计�?let _fakeStats = {};
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
      getReport() {
        return { adapters: {} };
      },
      _reset() {},
    },
  };
}
function _restoreStore() {
  delete require.cache[STORE_PATH];
}
// 造一个「健康」候�?entry:enabled + available + 一个最�?adapter stub�?function _entry(key) {
  return {
    key,
    enabled: true,
    available: true,
    adapter: {
      getStatus() {
        return { name: key, available: true };
      },
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
    if (savedFlag === undefined) {
      delete process.env.KHY_ROUTE_LATENCY_AWARE;
    } else {
      process.env.KHY_ROUTE_LATENCY_AWARE = savedFlag;
    }
  });
});

describe('Route Latency Aware e2e', () => {
  test('A �?B �?�?B �?slow_latency 罚分,B.score > A.score', () => {
        delete process.env.KHY_ROUTE_LATENCY_AWARE; // 默认开
        _fakeStats = {
          'adapter:fastone': { ewmaMs: 700, samples: 20, ageMs: 1000 }, // fast �?0
          'adapter:slowone': { ewmaMs: 12000, samples: 20, ageMs: 1000 }, // very_slow �?罚分
        };
        const a = gateway._assessDefaultRouteCandidate(_entry('fastone'));
        const b = gateway._assessDefaultRouteCandidate(_entry('slowone'));
    
        const aHasLat = a.reasons.some((r) => r.code === 'slow_latency');
        const bHasLat = b.reasons.some((r) => r.code === 'slow_latency');
        expect(aHasLat).toBe(false);
        expect(bHasLat).toBe(true);
        // basePriority 相同(同为未知 adapter)前提�?B 因延迟罚�?score 更高(更差)�?        expect(a.basePriority).toBe(b.basePriority);
        expect(b.score > a.score).toBeTruthy();
  });

  test('延迟罚分不足以把慢通道踢出健康�?�?healthyDefault、未 blocked)', () => {
        delete process.env.KHY_ROUTE_LATENCY_AWARE;
        _fakeStats = {
          'adapter:slowbutok': { ewmaMs: 15000, samples: 30, ageMs: 500 },
        };
        const b = gateway._assessDefaultRouteCandidate(_entry('slowbutok'));
        expect(b.blocked).toBe(false);
        expect(b.healthyDefault).toBe(true);
        // 延迟罚分 < healthyPenaltyCeiling(默认 40)
        const latReason = b.reasons.find((r) => r.code === 'slow_latency');
        expect(latReason).toBeTruthy();
        expect(latReason.penalty < 40).toBeTruthy();
  });

  test('门关 KHY_ROUTE_LATENCY_AWARE=off �?慢通道无延迟罚�?逐字节回退)', () => {
        process.env.KHY_ROUTE_LATENCY_AWARE = 'off';
        _fakeStats = {
          'adapter:slowoff': { ewmaMs: 20000, samples: 30, ageMs: 500 },
        };
        const b = gateway._assessDefaultRouteCandidate(_entry('slowoff'));
        const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
        expect(hasLat).toBe(false);
  });

  test('冷启�?samples<3)�?无延迟罚�?, () => {
        delete process.env.KHY_ROUTE_LATENCY_AWARE;
        _fakeStats = {
          'adapter:cold': { ewmaMs: 20000, samples: 2, ageMs: 500 },
        };
        const b = gateway._assessDefaultRouteCandidate(_entry('cold'));
        const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
        expect(hasLat).toBe(false);
  });

  test('陈旧统计(ageMs �?STALE_MS)�?无延迟罚�?, () => {
        delete process.env.KHY_ROUTE_LATENCY_AWARE;
        _fakeStats = {
          'adapter:stale': { ewmaMs: 20000, samples: 30, ageMs: 3600000 }, // 1h > 30min
        };
        const b = gateway._assessDefaultRouteCandidate(_entry('stale'));
        const hasLat = b.reasons.some((r) => r.code === 'slow_latency');
        expect(hasLat).toBe(false);
  });

});

