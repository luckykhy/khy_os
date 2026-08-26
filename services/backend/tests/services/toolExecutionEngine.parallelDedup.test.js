'use strict';

/**
 * toolExecutionEngine.parallelDedup.test.js — structured tool_use calls can
 * bypass parser-level duplicate collapse, so exact duplicates in one parallel
 * batch must share a single representative execution.
 */

const mockExecuteTool = jest.fn();

jest.mock('../../src/services/toolCalling', () => ({
  executeTool: mockExecuteTool,
}));

const { ToolExecutionEngine } = require('../../src/services/toolExecutionEngine');

const call = (id, name = 'read_file', params = { path: 'same.txt' }) => ({
  name,
  params,
  _toolUseId: id,
});

function createEngine(onToolResult = null) {
  return new ToolExecutionEngine({
    onToolResult,
    traceSessionId: 'parallel-dedup-test',
  });
}

describe('ToolExecutionEngine parallel batch deduplication', () => {
  beforeEach(() => {
    mockExecuteTool.mockReset();
  });

  test('executes exact duplicate calls once while returning one result per tool use', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, content: 'shared result' });
    const onToolResult = jest.fn();
    const results = await createEngine(onToolResult).executeBatch([
      call('tool-1'),
      call('tool-2'),
      call('tool-3'),
    ]);

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.map((result) => result._toolUseId)).toEqual(['tool-1', 'tool-2', 'tool-3']);
    expect(results[0].result._deduped).toBeUndefined();
    expect(results.slice(1).every((result) => result.result._deduped)).toBe(true);
    expect(results.slice(1).every((result) => result.elapsed === 0)).toBe(true);
    expect(onToolResult).toHaveBeenCalledTimes(3);
  });

  test('reuses the representative failure without retrying duplicates', async () => {
    mockExecuteTool.mockResolvedValue({ success: false, error: 'temporary failure' });

    const results = await createEngine().executeBatch([call('tool-1'), call('tool-2')]);

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(results[0].result).toMatchObject({ success: false, error: 'temporary failure' });
    expect(results[1].result).toMatchObject({
      success: false,
      error: 'temporary failure',
      _deduped: true,
    });
  });

  test('does not merge calls with different exact identities', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, content: 'result' });

    const results = await createEngine().executeBatch([
      call('tool-1', 'read_file', { path: 'first.txt' }),
      call('tool-2', 'read_file', { path: 'second.txt' }),
      call('tool-3', 'grep', { pattern: 'needle' }),
    ]);

    expect(mockExecuteTool).toHaveBeenCalledTimes(3);
    expect(results.every((result) => !result.result._deduped)).toBe(true);
  });
});
