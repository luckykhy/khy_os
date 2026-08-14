'use strict';

/**
 * toolMetricsAggregator — in-memory per-tool execution metrics (C2).
 *
 * Contract under test:
 *   - record()/getSummary() aggregate count / successRate / avgMs /
 *     totalResultChars per tool, keeping NO per-call detail.
 *   - record() never throws, even on malformed entries.
 *   - isMetricsEnabled(): KHY_TOOL_METRICS default on; 0/false/off/no → off.
 *   - emitSummary() goes through the existing diagnostics channel with a
 *     规则合规 message (动作+目标+进度), never a bare "processing...".
 */
describe('toolMetricsAggregator', () => {
  let aggregator;

  beforeEach(() => {
    jest.resetModules();
    aggregator = require('../src/services/toolMetricsAggregator');
    aggregator.reset();
  });

  afterEach(() => {
    aggregator.reset();
    jest.resetModules();
  });

  test('record + getSummary aggregate per tool (count/successRate/avgMs/totalResultChars)', () => {
    aggregator.record({ toolName: 'alpha', success: true, elapsedMs: 100, resultSizeChars: 500 });
    aggregator.record({ toolName: 'alpha', success: false, elapsedMs: 300, resultSizeChars: 200, errorClass: 'ETIMEOUT' });
    aggregator.record({ toolName: 'beta', success: true, elapsedMs: 50, resultSizeChars: 10 });

    const summary = aggregator.getSummary();
    expect(summary.toolCount).toBe(2);
    expect(summary.totalCalls).toBe(3);
    expect(summary.overallSuccessRate).toBeCloseTo(2 / 3);

    const alpha = summary.tools.find(t => t.toolName === 'alpha');
    expect(alpha.count).toBe(2);
    expect(alpha.successRate).toBeCloseTo(0.5);
    expect(alpha.avgMs).toBe(200);
    expect(alpha.totalResultChars).toBe(700);
    expect(alpha.errorClasses).toEqual({ ETIMEOUT: 1 });

    const beta = summary.tools.find(t => t.toolName === 'beta');
    expect(beta.count).toBe(1);
    expect(beta.successRate).toBe(1);
  });

  test('record never throws on malformed entries', () => {
    expect(() => aggregator.record(null)).not.toThrow();
    expect(() => aggregator.record({})).not.toThrow();
    expect(() => aggregator.record({ toolName: '' })).not.toThrow();
    expect(() => aggregator.record({ toolName: 'x', elapsedMs: 'NaN?', resultSizeChars: {} })).not.toThrow();
    // Only the well-formed-name entry got in
    expect(aggregator.getSummary().totalCalls).toBe(1);
  });

  test('isMetricsEnabled: default on; 0/false/off/no disable', () => {
    expect(aggregator.isMetricsEnabled({})).toBe(true);
    expect(aggregator.isMetricsEnabled({ KHY_TOOL_METRICS: '1' })).toBe(true);
    expect(aggregator.isMetricsEnabled({ KHY_TOOL_METRICS: 'on' })).toBe(true);
    for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      expect(aggregator.isMetricsEnabled({ KHY_TOOL_METRICS: off })).toBe(false);
    }
  });

  test('emitSummary emits a diagnostics event with 动作+目标+进度 message', () => {
    aggregator.record({ toolName: 'gamma', success: true, elapsedMs: 10, resultSizeChars: 5 });
    const event = aggregator.emitSummary();
    expect(event).not.toBeNull();
    expect(event.type).toBe('tool_metrics_summary');
    expect(event.data.message).toMatch(/^工具计量汇总 \(\d+ tools, \d+ calls, \d+% success\)$/);
    expect(event.data.totalCalls).toBe(1);
  });

  test('emitSummary with zero records returns null (no noise event)', () => {
    expect(aggregator.emitSummary()).toBeNull();
  });
});
