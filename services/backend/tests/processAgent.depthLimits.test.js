'use strict';

describe('ProcessAgent depth limits', () => {
  let ProcessAgent;

  beforeEach(() => {
    jest.resetModules();
    ({ ProcessAgent } = require('../src/coordinator/processAgent'));
  });

  // ── Depth stored in constructor ───────────────────────────────────

  test('constructor reads depth from parentContext', () => {
    const { AgentContext } = require('../src/services/agentContext');
    const parent = new AgentContext({ role: 'coder' });
    const child = parent.fork({ role: 'explore' });

    const agent = new ProcessAgent('task', {
      parentContext: child,
      maxSpawnDepth: 3,
    });
    expect(agent._currentDepth).toBe(1); // child.depth === 1
    expect(agent._maxDepth).toBe(3);
  });

  test('constructor defaults depth to 0 without parentContext', () => {
    const agent = new ProcessAgent('task');
    expect(agent._currentDepth).toBe(0);
    expect(agent._maxDepth).toBe(3); // default
  });

  // ── Depth guard in run() ──────────────────────────────────────────

  test('run() rejects when depth >= maxDepth', async () => {
    const agent = new ProcessAgent('deep task', {
      parentContext: { depth: 5 },
      maxSpawnDepth: 3,
    });

    await expect(agent.run()).rejects.toThrow(/depth 5 >= maxSpawnDepth 3/);
    expect(agent.state.status).toBe('error');
  });

  test('run() does not reject depth check when depth < maxDepth', async () => {
    const agent = new ProcessAgent('ok task', {
      parentContext: { depth: 1 },
      maxSpawnDepth: 3,
    });

    // run() will fail due to agentWorkerEntry/fork issues in test env,
    // but it should NOT fail on the depth check
    try {
      await agent.run();
    } catch (err) {
      // Should fail for spawn/init reasons, not depth
      expect(err.message).not.toMatch(/maxSpawnDepth/);
    }
  });

  // ── Kill cascades to children ─────────────────────────────────────

  test('kill cascades to _children set', () => {
    const parent = new ProcessAgent('parent');
    const child1 = new ProcessAgent('child-1');
    const child2 = new ProcessAgent('child-2');

    // Simulate child registration
    parent._children.add(child1);
    parent._children.add(child2);

    let child1Killed = false;
    let child2Killed = false;
    child1.kill = jest.fn(() => { child1Killed = true; });
    child2.kill = jest.fn(() => { child2Killed = true; });

    parent.state.status = 'running';
    parent.kill();

    expect(child1Killed).toBe(true);
    expect(child2Killed).toBe(true);
    expect(parent._children.size).toBe(0);
    expect(parent.state.status).toBe('killed');
  });

  // ── Watchdog stored instead of _timeoutTimer ─────────────────────

  test('constructor initializes _watchdog as null', () => {
    const agent = new ProcessAgent('test');
    expect(agent._watchdog).toBeNull();
    expect(agent._children).toBeDefined();
    expect(agent._children.size).toBe(0);
  });
});
