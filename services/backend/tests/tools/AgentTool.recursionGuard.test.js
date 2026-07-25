'use strict';

/**
 * Tests for the subagent recursion guard — depth-aware "layered delegation".
 *
 * Design (the teacher's rule): the tree may grow to 3 layers total — main
 * (depth 0) + 2 nested sub-agents (depth 1, depth 2). A sub-agent BELOW the
 * ceiling keeps the Agent/Task spawn tool so it can farm out its own chunk one
 * more layer; a sub-agent AT/OVER the ceiling is a pure leaf executor and loses
 * the spawn tool so the tree cannot grow past the cap. Enforced on two layers:
 *   1. Tool denylist — depth-aware: spawn tool stripped only at/over the ceiling.
 *   2. Depth ceiling — execute() refuses to spawn when the parent context is
 *      already at the nesting limit (defense-in-depth backstop).
 */

const assert = require('assert');

const agentToolModule = require('../../src/tools/AgentTool');
const { AgentTool, AGENT_TOOL_NAMES } = agentToolModule;

describe('AgentTool.buildSubagentDenylist — depth-aware spawn-tool exclusion', () => {
  test('a child BELOW the ceiling keeps the spawn tool (may recurse one layer)', () => {
    // childDepth 1 < ceiling 2 → Agent/Task retained.
    const deny = AgentTool.buildSubagentDenylist(null, 1, 2);
    for (const name of AGENT_TOOL_NAMES) {
      assert.ok(!deny.includes(name), `expected denylist to RETAIN ${name} below ceiling`);
    }
  });

  test('a child AT the ceiling loses every spawn-tool name', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 2, 2);
    for (const name of AGENT_TOOL_NAMES) {
      assert.ok(deny.includes(name), `expected denylist to strip ${name} at ceiling`);
    }
    assert.ok(deny.includes('Agent'));
    assert.ok(deny.includes('Task'));
  });

  test('a child OVER the ceiling also loses the spawn tool', () => {
    const deny = AgentTool.buildSubagentDenylist(null, 3, 2);
    assert.ok(deny.includes('Agent'));
  });

  test('omitted childDepth defaults to stripping the spawn tool (safe default)', () => {
    const deny = AgentTool.buildSubagentDenylist(null);
    assert.ok(deny.includes('Agent'));
    assert.ok(deny.includes('Task'));
  });

  test('maxDepth defaults to _maxSubagentDepth() (2) when omitted', () => {
    // childDepth 1, default ceiling 2 → retained.
    assert.ok(!AgentTool.buildSubagentDenylist(null, 1).includes('Agent'));
    // childDepth 2, default ceiling 2 → stripped.
    assert.ok(AgentTool.buildSubagentDenylist(null, 2).includes('Agent'));
  });

  test('always unions the agent definition own denylist, without duplicates', () => {
    // Below ceiling: own denylist kept, no spawn tool.
    const below = AgentTool.buildSubagentDenylist({ disallowedTools: ['Write', 'Agent'] }, 1, 2);
    assert.ok(below.includes('Write'));
    assert.strictEqual(below.filter((n) => n === 'Agent').length, 1, 'no duplicate Agent below ceiling');
    // At ceiling: own denylist kept AND spawn tool unioned, still de-duplicated.
    const at = AgentTool.buildSubagentDenylist({ disallowedTools: ['Write', 'Agent'] }, 2, 2);
    assert.ok(at.includes('Write'));
    assert.strictEqual(at.filter((n) => n === 'Agent').length, 1, 'no duplicate Agent at ceiling');
  });

  test('a general-purpose agent (no own denylist) loses the spawn tool at the ceiling', () => {
    const deny = AgentTool.buildSubagentDenylist({ disallowedTools: undefined }, 2, 2);
    assert.ok(deny.includes('Agent'));
  });
});

describe('AgentTool depth ceiling', () => {
  afterEach(() => { delete process.env.KHY_MAX_SUBAGENT_DEPTH; });

  test('parentDepthOf reads AgentContext depth, defaulting to 0', () => {
    assert.strictEqual(AgentTool.parentDepthOf(undefined), 0);
    assert.strictEqual(AgentTool.parentDepthOf({}), 0);
    assert.strictEqual(AgentTool.parentDepthOf({ _agentContext: { depth: 3 } }), 3);
  });

  test('isDepthExceeded honors the default ceiling (2)', () => {
    assert.strictEqual(AgentTool.isDepthExceeded({ _agentContext: { depth: 1 } }), false);
    assert.strictEqual(AgentTool.isDepthExceeded({ _agentContext: { depth: 2 } }), true);
    assert.strictEqual(AgentTool.isDepthExceeded({ _agentContext: { depth: 5 } }), true);
  });

  test('isDepthExceeded honors KHY_MAX_SUBAGENT_DEPTH override', () => {
    process.env.KHY_MAX_SUBAGENT_DEPTH = '0';
    // Ceiling 0 → even a top-level spawn (depth 0) is refused.
    assert.strictEqual(AgentTool.isDepthExceeded({ _agentContext: { depth: 0 } }), true);
    process.env.KHY_MAX_SUBAGENT_DEPTH = '4';
    assert.strictEqual(AgentTool.isDepthExceeded({ _agentContext: { depth: 3 } }), false);
  });

  test('the denylist ceiling tracks KHY_MAX_SUBAGENT_DEPTH (single source)', () => {
    process.env.KHY_MAX_SUBAGENT_DEPTH = '1';
    // ceiling 1 → a depth-1 child is now AT the ceiling and loses the spawn tool.
    assert.ok(AgentTool.buildSubagentDenylist(null, 1).includes('Agent'));
    process.env.KHY_MAX_SUBAGENT_DEPTH = '3';
    // ceiling 3 → a depth-2 child is below it and keeps the spawn tool.
    assert.ok(!AgentTool.buildSubagentDenylist(null, 2).includes('Agent'));
  });

  test('execute() refuses to spawn at/over the ceiling without running a loop', async () => {
    const res = await agentToolModule.execute(
      { prompt: 'do something', subagent_type: 'general-purpose' },
      { _agentContext: { depth: 2 } }
    );
    assert.strictEqual(res.success, false);
    assert.ok(/nesting limit/i.test(res.error), `unexpected error: ${res.error}`);
  });
});
