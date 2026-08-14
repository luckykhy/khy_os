'use strict';

/**
 * B2: tool-level `maxResultSizeChars` must flow from the tool definition into
 * maybePersistLargeResult({ maxChars }) at the executeTool() funnel:
 *   - a tool declaring maxResultSizeChars=1000 with a 1500-char result gets
 *     its content truncated to a preview + persisted temp file path;
 *   - a tool WITHOUT the declaration keeps a 1500-char result intact
 *     (global 50K default → untouched, byte-identical legacy behavior).
 *
 * C2: executeTool() records per-call metrics into toolMetricsAggregator,
 * gated by KHY_TOOL_METRICS (default on; =0 → zero recording).
 */
const fs = require('fs');

describe('toolCalling tool-level maxResultSizeChars + execution metrics', () => {
  const prevDangerous = process.env.KHYQUANT_DANGEROUS;
  const prevGateway = process.env.KHY_SYSCALL_GATEWAY;
  const prevMetrics = process.env.KHY_TOOL_METRICS;
  let toolCalling;
  let registry;
  let aggregator;
  const persistedPaths = [];

  const BIG = 'x'.repeat(1500);

  beforeEach(() => {
    jest.resetModules();
    process.env.KHYQUANT_DANGEROUS = 'true';
    process.env.KHY_SYSCALL_GATEWAY = 'off';
    delete process.env.KHY_TOOL_METRICS;

    registry = require('../src/tools');
    registry.register({
      name: 'mock_capped_result_tool',
      description: 'mock tool with a per-tool result size cap',
      risk: 'low',
      inputSchema: {},
      isReadOnly: () => true,
      maxResultSizeChars: 1000,
      execute: async () => ({ success: true, content: BIG }),
    });
    registry.register({
      name: 'mock_uncapped_result_tool',
      description: 'mock tool without a per-tool result size cap',
      risk: 'low',
      inputSchema: {},
      isReadOnly: () => true,
      execute: async () => ({ success: true, content: BIG }),
    });

    toolCalling = require('../src/services/toolCalling');
    toolCalling.enableDangerousMode();
    toolCalling.setPreflightContext(
      new Set(['mock_capped_result_tool', 'mock_uncapped_result_tool'])
    );
    aggregator = require('../src/services/toolMetricsAggregator');
    aggregator.reset();
  });

  afterEach(() => {
    if (toolCalling && typeof toolCalling.clearPreflightContext === 'function') {
      toolCalling.clearPreflightContext();
    }
    if (aggregator) aggregator.reset();
    for (const p of persistedPaths.splice(0)) {
      try { fs.unlinkSync(p); } catch { /* best-effort temp cleanup */ }
    }
    if (prevDangerous === undefined) delete process.env.KHYQUANT_DANGEROUS;
    else process.env.KHYQUANT_DANGEROUS = prevDangerous;
    if (prevGateway === undefined) delete process.env.KHY_SYSCALL_GATEWAY;
    else process.env.KHY_SYSCALL_GATEWAY = prevGateway;
    if (prevMetrics === undefined) delete process.env.KHY_TOOL_METRICS;
    else process.env.KHY_TOOL_METRICS = prevMetrics;
    jest.resetModules();
  });

  test('declared maxResultSizeChars=1000 → 1500-char result truncated + persisted', async () => {
    const result = await toolCalling.executeTool('mock_capped_result_tool', {});
    expect(result.success).toBe(true);
    expect(result._persistedPath).toBeTruthy();
    persistedPaths.push(result._persistedPath);
    expect(result.content).toMatch(/chars truncated/);
    expect(result.content).toMatch(/Full output saved to:/);
    expect(result.content).not.toBe(BIG);
    // The full original payload survives in the persisted file
    expect(fs.readFileSync(result._persistedPath, 'utf-8')).toBe(BIG);
  });

  test('no declaration → 1500-char result stays intact (global 50K default)', async () => {
    const result = await toolCalling.executeTool('mock_uncapped_result_tool', {});
    expect(result.success).toBe(true);
    expect(result._persistedPath).toBeUndefined();
    expect(result.content).toBe(BIG);
  });

  test('metrics: executeTool records into aggregator (KHY_TOOL_METRICS default on)', async () => {
    await toolCalling.executeTool('mock_uncapped_result_tool', {});
    const summary = aggregator.getSummary();
    const entry = summary.tools.find(t => t.toolName === 'mock_uncapped_result_tool');
    expect(entry).toBeTruthy();
    expect(entry.count).toBe(1);
    expect(entry.successRate).toBe(1);
    expect(entry.totalResultChars).toBe(1500);
  });

  test('metrics: KHY_TOOL_METRICS=0 → nothing recorded', async () => {
    process.env.KHY_TOOL_METRICS = '0';
    await toolCalling.executeTool('mock_uncapped_result_tool', {});
    expect(aggregator.getSummary().totalCalls).toBe(0);
  });
});
