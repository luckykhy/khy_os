'use strict';

/**
 * agentTreeBridge — the ink bridge's pure wiring for the parallel sub-agent tree.
 *
 * The fan-out tree lives ON the agent tool row (`_agentTree`), attached by
 * useQueryBridge.reduceAgentTree as the orchestrator's per-child lifecycle events
 * arrive. ToolLines renders it in place of the single agent(...) line. These
 * assertions pin the reducer's invariants without mounting React:
 *   - the tree attaches to the RIGHT tool (by id) in both tools[] and timeline,
 *   - other tool fields (notably the resolved `result`) are preserved,
 *   - the agent-family classifier (which gates the onAgentProgress return) is
 *     the shared single source.
 */
const {
  reduceAgentTree,
  isAgentFamilyTool,
} = require('../../src/cli/tui/hooks/useQueryBridge');

function baseState() {
  const agentTool = { id: 'tool-A', name: 'agent', input: { prompt: 'do X' } };
  const readTool = { id: 'tool-B', name: 'Read', input: { file: 'x.js' }, result: { text: 'ok' } };
  return {
    tools: [agentTool, readTool],
    timeline: [
      { type: 'text', text: 'plan' },
      { type: 'tool', tool: agentTool },
      { type: 'tool', tool: readTool },
    ],
  };
}

describe('reduceAgentTree', () => {
  test('attaches _agentTree to the matching tool id in BOTH tools[] and timeline', () => {
    const s = baseState();
    const agents = [{ id: '1', name: '子任务A', status: 'running' }];
    const out = reduceAgentTree(s, { toolId: 'tool-A', agents });

    const flat = out.tools.find((t) => t.id === 'tool-A');
    expect(flat._agentTree).toEqual(agents);
    const seg = out.timeline.find((e) => e.type === 'tool' && e.tool.id === 'tool-A');
    expect(seg.tool._agentTree).toEqual(agents);
  });

  test('does not touch a different tool (id mismatch leaves it tree-less)', () => {
    const out = reduceAgentTree(baseState(), { toolId: 'tool-A', agents: [{ id: '1' }] });
    const other = out.tools.find((t) => t.id === 'tool-B');
    expect(other._agentTree).toBeUndefined();
    expect(other.result).toEqual({ text: 'ok' }); // unrelated row untouched
  });

  test('preserves the agent row\'s own resolved result when attaching the tree', () => {
    const s = baseState();
    s.tools[0].result = { success: true, text: 'aggregated' };
    s.timeline[1].tool.result = { success: true, text: 'aggregated' };
    const out = reduceAgentTree(s, { toolId: 'tool-A', agents: [{ id: '1', status: 'completed' }] });
    const flat = out.tools.find((t) => t.id === 'tool-A');
    expect(flat.result).toEqual({ success: true, text: 'aggregated' });
    expect(flat._agentTree).toHaveLength(1);
  });

  test('refreshing the tree replaces the prior agents array (latest state wins)', () => {
    let s = baseState();
    s = reduceAgentTree(s, { toolId: 'tool-A', agents: [{ id: '1', status: 'running' }] });
    s = reduceAgentTree(s, { toolId: 'tool-A', agents: [{ id: '1', status: 'completed' }, { id: '2', status: 'running' }] });
    const flat = s.tools.find((t) => t.id === 'tool-A');
    expect(flat._agentTree).toHaveLength(2);
    expect(flat._agentTree[0].status).toBe('completed');
  });

  test('null-safe: a null state passes through unchanged', () => {
    expect(reduceAgentTree(null, { toolId: 'x', agents: [] })).toBeNull();
  });

  test('returns a new object (no in-place mutation of the input state)', () => {
    const s = baseState();
    const out = reduceAgentTree(s, { toolId: 'tool-A', agents: [{ id: '1' }] });
    expect(out).not.toBe(s);
    expect(s.tools[0]._agentTree).toBeUndefined(); // original untouched
  });
});

describe('isAgentFamilyTool (re-exported single source)', () => {
  test('gates which tool calls hand the loop an onAgentProgress sink', () => {
    expect(isAgentFamilyTool('agent')).toBe(true);
    expect(isAgentFamilyTool('sub_agent')).toBe(true);
    expect(isAgentFamilyTool('Read')).toBe(false);
  });
});
