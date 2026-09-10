'use strict';
/**
 * routeLatencyPenalty �?纯叶子单元测试�? *
 * 验证:延迟感知软罚分只在健康集内部破平局(硬顶 ceiling-1、绝�?blocked),
 * 冷启�?陈旧不误�?门关逐字节回退(罚分�?0),异常输入绝不抛�? */
const {
  isRouteLatencyAwareEnabled,
  classifyLatency,
  latencyPenalty,
  buildLatencyReason,
} = require('./routeLatencyPenalty');
const ON = {}; // 默认开(flagRegistry default-on)
const OFF = { KHY_ROUTE_LATENCY_AWARE: 'off' };
describe('isRouteLatencyAwareEnabled', () => {
});
describe('classifyLatency �?五档边界(默认阈�?fast<1500 slow<4000 verySlow<9000)', () => {
  const S = (ewmaMs, samples = 10, ageMs = 0) => ({ ewmaMs, samples, ageMs });
});
describe('latencyPenalty �?有界罚分,健康�?普通零罚分', () => {
});
describe('buildLatencyReason �?reasons 条目形状', () => {
});

describe('Route Latency Penalty', () => {
  test('默认(�?env)�?开', () => {
        expect(isRouteLatencyAwareEnabled({})).toBe(true);
  });

  test('显式�?off/0/false/no)', () => {
        expect(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'off' })).toBe(false);
        expect(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: '0' })).toBe(false);
        expect(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'false' })).toBe(false);
        expect(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'no' })).toBe(false);
  });

  test('fast:低于 1500ms', () => {
        expect(classifyLatency(S(800), ON)).toBe('fast');
        expect(classifyLatency(S(1499), ON)).toBe('fast');
  });

  test('typical:1500�?999ms', () => {
        expect(classifyLatency(S(1500), ON)).toBe('typical');
        expect(classifyLatency(S(3999), ON)).toBe('typical');
  });

  test('slow:4000�?999ms', () => {
        expect(classifyLatency(S(4000), ON)).toBe('slow');
        expect(classifyLatency(S(8999), ON)).toBe('slow');
  });

  test('very_slow:�?000ms', () => {
        expect(classifyLatency(S(9000), ON)).toBe('very_slow');
        expect(classifyLatency(S(30000), ON)).toBe('very_slow');
  });

  test('样本不足(samples < 3)�?insufficient_data(不判�?', () => {
        expect(classifyLatency(S(9000).toBe(2), ON), 'insufficient_data');
        expect(classifyLatency(S(9000).toBe(0), ON), 'insufficient_data');
  });

  test('陈旧(ageMs �?STALE_MS 30min)�?insufficient_data', () => {
        expect(classifyLatency(S(9000, 10, 1800001), ON)).toBe('insufficient_data');
        // 恰好在窗�?�?正常判档
        expect(classifyLatency(S(9000, 10, 1800000), ON)).toBe('very_slow');
  });

  test('无效 ewma(0/�?NaN)�?insufficient_data', () => {
        expect(classifyLatency(S(0), ON)).toBe('insufficient_data');
        expect(classifyLatency(S(-5), ON)).toBe('insufficient_data');
        expect(classifyLatency(S(NaN), ON)).toBe('insufficient_data');
  });

  test('fast / typical / insufficient �?0', () => {
        expect(latencyPenalty({ ewmaMs: 800, samples: 10 }, ON)).toBe(0);
        expect(latencyPenalty({ ewmaMs: 3000, samples: 10 }, ON)).toBe(0);
        expect(latencyPenalty({ ewmaMs: 9000, samples: 1 }, ON)).toBe(0);
  });

  test('slow �?默认 12', () => {
        expect(latencyPenalty({ ewmaMs: 5000, samples: 10 }, ON)).toBe(12);
  });

  test('very_slow �?默认 22', () => {
        expect(latencyPenalty({ ewmaMs: 12000, samples: 10 }, ON)).toBe(22);
  });

  test('硬顶 ceiling-1:very_slow(22) �?ceiling=10 时夹�?9', () => {
        expect(latencyPenalty({ ewmaMs: 12000, samples: 10, ceiling: 10 }, ON)).toBe(9);
  });

  test('硬顶保证:健康 ceiling=40 �?very_slow(22) < 40(不越健康�?', () => {
        const p = latencyPenalty({ ewmaMs: 12000, samples: 10, ceiling: 40 }, ON);
        expect(p < 40).toBeTruthy();
        expect(p).toBe(22);
  });

  test('门关 �?�?0(逐字节回退)', () => {
        expect(latencyPenalty({ ewmaMs: 12000, samples: 10 }, OFF)).toBe(0);
  });

  test('绝不�?异常/空输�?�?0', () => {
        expect(() => latencyPenalty().not.toThrow());
        expect(latencyPenalty(null, ON)).toBe(0);
        expect(latencyPenalty({}, ON)).toBe(0);
  });

  test('slow �?{ code, penalty, text } �?text 含延�?, () => {
        const r = buildLatencyReason({ ewmaMs: 5000, samples: 10 }, { ceiling: 40, env: ON });
        expect(r.code).toBe('slow_latency');
        expect(r.penalty).toBe(12);
        expect(/5\.0s|5000ms/.test(r.text)).toBeTruthy();
        expect(r.text.includes('降权')).toBeTruthy();
  });

  test('fast �?null(�?push)', () => {
        expect(buildLatencyReason({ ewmaMs: 800, samples: 10 }, { ceiling: 40, env: ON })).toBe(null);
  });

  test('门关 �?null', () => {
        assert.equal(
          buildLatencyReason({ ewmaMs: 12000, samples: 10 }, { ceiling: 40, env: OFF }),
          null
        );
  });

  test('绝不�?, () => {
        expect(() => buildLatencyReason().not.toThrow());
        expect(buildLatencyReason(null)).toBe(null);
  });

});

