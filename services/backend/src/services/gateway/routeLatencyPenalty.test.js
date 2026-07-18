'use strict';

/**
 * routeLatencyPenalty — 纯叶子单元测试。
 *
 * 验证:延迟感知软罚分只在健康集内部破平局(硬顶 ceiling-1、绝不 blocked),
 * 冷启动/陈旧不误伤,门关逐字节回退(罚分恒 0),异常输入绝不抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isRouteLatencyAwareEnabled,
  classifyLatency,
  latencyPenalty,
  buildLatencyReason,
} = require('./routeLatencyPenalty');

const ON = {}; // 默认开(flagRegistry default-on)
const OFF = { KHY_ROUTE_LATENCY_AWARE: 'off' };

describe('isRouteLatencyAwareEnabled', () => {
  test('默认(无 env)→ 开', () => {
    assert.equal(isRouteLatencyAwareEnabled({}), true);
  });
  test('显式关(off/0/false/no)', () => {
    assert.equal(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'off' }), false);
    assert.equal(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: '0' }), false);
    assert.equal(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'false' }), false);
    assert.equal(isRouteLatencyAwareEnabled({ KHY_ROUTE_LATENCY_AWARE: 'no' }), false);
  });
});

describe('classifyLatency — 五档边界(默认阈值 fast<1500 slow<4000 verySlow<9000)', () => {
  const S = (ewmaMs, samples = 10, ageMs = 0) => ({ ewmaMs, samples, ageMs });
  test('fast:低于 1500ms', () => {
    assert.equal(classifyLatency(S(800), ON), 'fast');
    assert.equal(classifyLatency(S(1499), ON), 'fast');
  });
  test('typical:1500–3999ms', () => {
    assert.equal(classifyLatency(S(1500), ON), 'typical');
    assert.equal(classifyLatency(S(3999), ON), 'typical');
  });
  test('slow:4000–8999ms', () => {
    assert.equal(classifyLatency(S(4000), ON), 'slow');
    assert.equal(classifyLatency(S(8999), ON), 'slow');
  });
  test('very_slow:≥9000ms', () => {
    assert.equal(classifyLatency(S(9000), ON), 'very_slow');
    assert.equal(classifyLatency(S(30000), ON), 'very_slow');
  });
  test('样本不足(samples < 3)→ insufficient_data(不判罚)', () => {
    assert.equal(classifyLatency(S(9000, 2), ON), 'insufficient_data');
    assert.equal(classifyLatency(S(9000, 0), ON), 'insufficient_data');
  });
  test('陈旧(ageMs 超 STALE_MS 30min)→ insufficient_data', () => {
    assert.equal(classifyLatency(S(9000, 10, 1800001), ON), 'insufficient_data');
    // 恰好在窗内 → 正常判档
    assert.equal(classifyLatency(S(9000, 10, 1800000), ON), 'very_slow');
  });
  test('无效 ewma(0/负/NaN)→ insufficient_data', () => {
    assert.equal(classifyLatency(S(0), ON), 'insufficient_data');
    assert.equal(classifyLatency(S(-5), ON), 'insufficient_data');
    assert.equal(classifyLatency(S(NaN), ON), 'insufficient_data');
  });
});

describe('latencyPenalty — 有界罚分,健康快/普通零罚分', () => {
  test('fast / typical / insufficient → 0', () => {
    assert.equal(latencyPenalty({ ewmaMs: 800, samples: 10 }, ON), 0);
    assert.equal(latencyPenalty({ ewmaMs: 3000, samples: 10 }, ON), 0);
    assert.equal(latencyPenalty({ ewmaMs: 9000, samples: 1 }, ON), 0);
  });
  test('slow → 默认 12', () => {
    assert.equal(latencyPenalty({ ewmaMs: 5000, samples: 10 }, ON), 12);
  });
  test('very_slow → 默认 22', () => {
    assert.equal(latencyPenalty({ ewmaMs: 12000, samples: 10 }, ON), 22);
  });
  test('硬顶 ceiling-1:very_slow(22) 在 ceiling=10 时夹到 9', () => {
    assert.equal(latencyPenalty({ ewmaMs: 12000, samples: 10, ceiling: 10 }, ON), 9);
  });
  test('硬顶保证:健康 ceiling=40 下 very_slow(22) < 40(不越健康集)', () => {
    const p = latencyPenalty({ ewmaMs: 12000, samples: 10, ceiling: 40 }, ON);
    assert.ok(p < 40, `延迟单笔罚分必须 < ceiling: ${p}`);
    assert.equal(p, 22);
  });
  test('门关 → 恒 0(逐字节回退)', () => {
    assert.equal(latencyPenalty({ ewmaMs: 12000, samples: 10 }, OFF), 0);
  });
  test('绝不抛:异常/空输入 → 0', () => {
    assert.doesNotThrow(() => latencyPenalty());
    assert.equal(latencyPenalty(null, ON), 0);
    assert.equal(latencyPenalty({}, ON), 0);
  });
});

describe('buildLatencyReason — reasons 条目形状', () => {
  test('slow → { code, penalty, text } 且 text 含延迟', () => {
    const r = buildLatencyReason({ ewmaMs: 5000, samples: 10 }, { ceiling: 40, env: ON });
    assert.equal(r.code, 'slow_latency');
    assert.equal(r.penalty, 12);
    assert.ok(/5\.0s|5000ms/.test(r.text), r.text);
    assert.ok(r.text.includes('降权'), r.text);
  });
  test('fast → null(不 push)', () => {
    assert.equal(buildLatencyReason({ ewmaMs: 800, samples: 10 }, { ceiling: 40, env: ON }), null);
  });
  test('门关 → null', () => {
    assert.equal(buildLatencyReason({ ewmaMs: 12000, samples: 10 }, { ceiling: 40, env: OFF }), null);
  });
  test('绝不抛', () => {
    assert.doesNotThrow(() => buildLatencyReason());
    assert.equal(buildLatencyReason(null), null);
  });
});
