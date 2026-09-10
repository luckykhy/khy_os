'use strict';

/**
 * Tests for the subagent recursion guard â€?depth-aware "layered delegation".
 *
 * Design (the teacher's rule): the tree may grow to 3 layers total â€?main
 * (depth 0) + 2 nested sub-agents (depth 1, depth 2). A sub-agent BELOW the
 * ceiling keeps the Agent/Task spawn tool so it can farm out its own chunk one
 * more layer; a sub-agent AT/OVER the ceiling is a pure leaf executor and loses
 * the spawn tool so the tree cannot grow past the cap. Enforced on two layers:
 *   1. Tool denylist â€?depth-aware: spawn tool stripped only at/over the ceiling.
 *   2. Depth ceiling â€?execute() refuses to spawn when the parent context is
 *      already at the nesting limit (defense-in-depth backstop).
 */

const assert = require('assert');

const agentToolModule = require('../../src/tools/AgentTool');
const { AgentTool, AGENT_TOOL_NAMES } = agentToolModule;

describe('AgentTool.buildSubagentDenylist â€?depth-aware spawn-tool exclusion', () => {
  test('a child BELOW the ceiling keeps the spawn tool (may recurse one layer)', () => {
    // childDepth 1 < ceiling 2 â†?Agent/Task retained.
    const deny = AgentTool.buildSubagentDenylist(null, 1, 2);
    for (const name of AGENT_TOOL_NAMES) {
      expect(!deny).toContain(name);
    }
  });

  test('a child AT the ceiling loses every spawn-tool name', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 2, 2);
    for (const name of AGENT_TOOL_NAMES) {
      expect(deny).toContain(name);
    }
    expect(deny).toContain('Agent');
    expect(deny).toContain('Task');
  });

  test('a child OVER the ceiling also loses the spawn tool', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 3, 2);
    expect(deny).toContain('Agent');
  });

  test('omitted childDepth defaults to stripping the spawn tool (safe default)', () => {
    const deny = AgentTool.buildSubagentDenylist(null);
    expect(deny).toContain('Agent');
    expect(deny).toContain('Task');
  });

  test('maxDepth defaults to _maxSubagentDepth() (2) when omitted', () => {
    // childDepth 1, default ceiling 2 â†?retained.
    expect(!AgentTool.buildSubagentDenylist(null, 1)).toContain('Agent');
    // childDepth 2, default ceiling 2 â†?stripped.
    expect(AgentTool.buildSubagentDenylist(null, 2)).toContain('Agent');
  });

  test('always unions the agent definition own denylist, without duplicates', () => {
    // Below ceiling: own denylist kept, no spawn tool.
    const below = AgentTool.buildSubagentDenylist({ disallowedTools: ['Write', 'Agent'] }, 1, 2);
    expect(below).toContain('Write');
    expect(below.filter((n) => n === 'Agent').length).toBe(1);
    // At ceiling: own denylist kept AND spawn tool unioned, still de-duplicated.
    const at = AgentTool.buildSubagentDenylist({ disallowedTools: ['Write', 'Agent'] }, 2, 2);
    expect(at).toContain('Write');
    expect(at.filter((n) => n === 'Agent').length).toBe(1);
  });

  test('a general-purpose agent (no own denylist) loses the spawn tool at the ceiling', () => {
    const deny = AgentTool.buildSubagentDenylist({ disallowedTools: undefined }, 2, 2);
    expect(deny).toContain('Agent');
  });
});

describe('AgentTool depth ceiling', () => {
  afterEach(() => { delete process.env.KHY_MAX_SUBAGENT_DEPTH; });

  test('parentDepthOf reads AgentContext depth, defaulting to 0', () => {
    expect(AgentTool.parentDepthOf(undefined)).toBe(0);
    expect(AgentTool.parentDepthOf({})).toBe(0);
    expect(AgentTool.parentDepthOf({ _agentContext: { depth: 3 } })).toBe(3);
  });

  test('isDepthExceeded honors the default ceiling (2)', () => {
    expect(AgentTool.isDepthExceeded({ _agentContext: { depth: 1 } })).toBe(false);
    expect(AgentTool.isDepthExceeded({ _agentContext: { depth: 2 } })).toBe(true);
    expect(AgentTool.isDepthExceeded({ _agentContext: { depth: 5 } })).toBe(true);
  });

  test('isDepthExceeded honors KHY_MAX_SUBAGENT_DEPTH override', () => {
    process.env.KHY_MAX_SUBAGENT_DEPTH = '0';
    // Ceiling 0 â†?even a top-level spawn (depth 0) is refused.
    expect(AgentTool.isDepthExceeded({ _agentContext: { depth: 0 } })).toBe(true);
    process.env.KHY_MAX_SUBAGENT_DEPTH = '4';
    expect(AgentTool.isDepthExceeded({ _agentContext: { depth: 3 } })).toBe(false);
  });

  test('the denylist ceiling tracks KHY_MAX_SUBAGENT_DEPTH (single source)', () => {
    process.env.KHY_MAX_SUBAGENT_DEPTH = '1';
    // ceiling 1 â†?a depth-1 child is now AT the ceiling and loses the spawn tool.
    expect(AgentTool.buildSubagentDenylist(null, 1)).toContain('Agent');
    process.env.KHY_MAX_SUBAGENT_DEPTH = '3';
    // ceiling 3 â†?a depth-2 child is below it and keeps the spawn tool.
    expect(!AgentTool.buildSubagentDenylist(null, 2)).toContain('Agent');
  });

  test('execute() refuses to spawn at/over the ceiling without running a loop', async () => {
    const res = await agentToolModule.execute(
      { prompt: 'do something', subagent_type: 'general-purpose' },
      { _agentContext: { depth: 2 } }
    );
    expect(res.success).toBe(false);
    expect(/nesting limit/i.test(res.error)).toBeTruthy();
  });
});

