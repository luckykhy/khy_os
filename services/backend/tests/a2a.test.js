'use strict';

/**
 * A2A Tests — Comprehensive tests for the A2A implementation.
 */

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { getA2A, resetA2A, AGENT_STATUS, AGENT_LIFECYCLE_STATE, MESSAGE_STATUS } = require('./a2aFacade');
const { getRegistry, resetRegistry } = require('./a2aRegistry');
const { getLifecycle, resetLifecycle } = require('./a2aAgentLifecycle');
const { getRouter, resetRouter } = require('./a2aMessageRouter');

describe('A2A Registry', () => {
  let registry;

  beforeEach(() => {
    resetRegistry();
    registry = getRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it('should register an agent', () => {
    const agent = registry.register({
      name: 'test-agent',
      type: 'analyst',
      capabilities: ['analysis', 'reporting'],
    });

    expect(agent.id).toBeDefined();
    expect(agent.name).toBe('test-agent');
    expect(agent.status).toBe(AGENT_STATUS.ACTIVE);
    expect(agent.capabilities).toEqual(['analysis', 'reporting']);
  });

  it('should reject duplicate registration', () => {
    registry.register({ name: 'agent-1', type: 'analyst' });
    
    expect(() => {
      registry.register({ name: 'agent-1', type: 'analyst' });
    }).toThrow();
  });

  it('should deregister an agent', () => {
    const agent = registry.register({ name: 'test-agent', type: 'analyst' });
    const result = registry.deregister(agent.id);
    
    expect(result).toBe(true);
    expect(registry.getAgent(agent.id)).toBeUndefined();
  });

  it('should find agents by capability', () => {
    registry.register({ name: 'agent-1', type: 'analyst', capabilities: ['analysis'] });
    registry.register({ name: 'agent-2', type: 'analyst', capabilities: ['reporting'] });
    registry.register({ name: 'agent-3', type: 'analyst', capabilities: ['analysis', 'reporting'] });

    const analysisAgents = registry.getAgentsByCapability('analysis');
    expect(analysisAgents.length).toBe(2);
  });

  it('should find best agent with load balancing', () => {
    const agent1 = registry.register({ name: 'agent-1', type: 'analyst', capabilities: ['analysis'] });
    const agent2 = registry.register({ name: 'agent-2', type: 'analyst', capabilities: ['analysis'] });
    
    // Give agent1 some tasks
    registry.incrementTasks(agent1.id);
    registry.incrementTasks(agent1.id);
    
    // Give agent2 fewer tasks
    registry.incrementTasks(agent2.id);
    
    const best = registry.findBestAgent('analysis');
    expect(best.id).toBe(agent2.id);
  });

  it('should handle heartbeat', () => {
    const agent = registry.register({ name: 'test-agent', type: 'analyst' });
    const result = registry.heartbeat(agent.id);
    
    expect(result).toBe(true);
  });

  it('should update agent status', () => {
    const agent = registry.register({ name: 'test-agent', type: 'analyst' });
    registry.updateStatus(agent.id, AGENT_STATUS.BUSY);
    
    const updated = registry.getAgent(agent.id);
    expect(updated.status).toBe(AGENT_STATUS.BUSY);
  });

  it('should provide statistics', () => {
    registry.register({ name: 'agent-1', type: 'analyst', capabilities: ['analysis'] });
    registry.register({ name: 'agent-2', type: 'manager', capabilities: ['coordination'] });
    
    const stats = registry.getStatistics();
    expect(stats.totalAgents).toBe(2);
    expect(stats.totalCapabilities).toBe(2);
  });
});

describe('A2A Agent Lifecycle', () => {
  let lifecycle;

  beforeEach(() => {
    resetLifecycle();
    lifecycle = getLifecycle();
  });

  afterEach(() => {
    lifecycle.destroy();
  });

  it('should spawn an agent', () => {
    const session = lifecycle.spawn({
      name: 'test-agent',
      type: 'analyst',
      capabilities: ['analysis'],
    });

    expect(session.id).toBeDefined();
    expect(session.name).toBe('test-agent');
    expect(session.state).toBe(AGENT_LIFECYCLE_STATE.RUNNING);
    expect(session.depth).toBe(1);
  });

  it('should respect max depth', () => {
    const parent = lifecycle.spawn({ name: 'parent', type: 'coordinator' });
    
    // Should throw when exceeding max depth
    let current = parent;
    for (let i = 0; i < 3; i++) {
      const child = lifecycle.spawn({ name: `child-${i}`, type: 'analyst', parentId: current.id });
      current = child;
    }
    
    expect(() => {
      lifecycle.spawn({ name: 'too-deep', type: 'analyst', parentId: current.id });
    }).toThrow();
  });

  it('should kill an agent', () => {
    const agent = lifecycle.spawn({ name: 'test-agent', type: 'analyst' });
    const result = lifecycle.kill(agent.id);
    
    expect(result).toBe(true);
    const killed = lifecycle.getAgent(agent.id);
    expect(killed.state).toBe(AGENT_LIFECYCLE_STATE.KILLED);
  });

  it('should complete an agent', () => {
    const agent = lifecycle.spawn({ name: 'test-agent', type: 'analyst' });
    lifecycle.complete(agent.id, { result: 'success' });
    
    const completed = lifecycle.getAgent(agent.id);
    expect(completed.state).toBe(AGENT_LIFECYCLE_STATE.COMPLETED);
    expect(completed.result).toEqual({ result: 'success' });
  });

  it('should fail an agent', () => {
    const agent = lifecycle.spawn({ name: 'test-agent', type: 'analyst' });
    lifecycle.fail(agent.id, 'Something went wrong');
    
    const failed = lifecycle.getAgent(agent.id);
    expect(failed.state).toBe(AGENT_LIFECYCLE_STATE.FAILED);
    expect(failed.error).toBe('Something went wrong');
  });

  it('should write and read workspace', () => {
    const agent = lifecycle.spawn({ name: 'test-agent', type: 'analyst' });
    
    lifecycle.writeToWorkspace(agent.id, 'test.txt', 'Hello World');
    const content = lifecycle.readFromWorkspace(agent.id, 'test.txt');
    
    expect(content.toString()).toBe('Hello World');
  });

  it('should provide statistics', () => {
    lifecycle.spawn({ name: 'agent-1', type: 'analyst' });
    lifecycle.spawn({ name: 'agent-2', type: 'manager' });
    
    const stats = lifecycle.getStatistics();
    expect(stats.totalAgents).toBe(2);
    expect(stats.rootAgents).toBe(2);
  });
});

describe('A2A Message Router', () => {
  let router;

  beforeEach(() => {
    resetRouter();
    router = getRouter();
  });

  afterEach(() => {
    router.destroy();
  });

  it('should route a message', async () => {
    const message = await router.route({
      type: 'test',
      payload: { data: 'hello' },
    });
    
    expect(message.id).toBeDefined();
    expect(message.status).toBeDefined();
  });

  it('should route to specific agent', async () => {
    const message = await router.routeTo('agent-123', {
      type: 'test',
      payload: { data: 'hello' },
    });
    
    expect(message.metadata.target).toBe('agent-123');
  });

  it('should track queue statistics', () => {
    router.route({ type: 'test', payload: {} });
    
    const stats = router.getQueueStats();
    expect(stats.totalRouted).toBeGreaterThanOrEqual(1);
  });
});

describe('A2A Facade Integration', () => {
  let a2a;

  beforeEach(() => {
    resetA2A();
    a2a = getA2A();
  });

  afterEach(() => {
    a2a.destroy();
  });

  it('should register and retrieve an agent', () => {
    const agent = a2a.registerAgent({
      name: 'test-agent',
      type: 'analyst',
      capabilities: ['analysis'],
    });

    const retrieved = a2a.getAgent(agent.id);
    expect(retrieved).toBeDefined();
    expect(retrieved.name).toBe('test-agent');
  });

  it('should spawn an agent', () => {
    const session = a2a.spawnAgent({
      name: 'test-agent',
      type: 'analyst',
      capabilities: ['analysis'],
    });

    expect(session.id).toBeDefined();
    expect(session.state).toBe(AGENT_LIFECYCLE_STATE.RUNNING);
  });

  it('should find agents by capability', () => {
    a2a.registerAgent({ name: 'agent-1', type: 'analyst', capabilities: ['analysis'] });
    a2a.registerAgent({ name: 'agent-2', type: 'analyst', capabilities: ['reporting'] });

    const agents = a2a.findAgentsByCapability('analysis');
    expect(agents.length).toBe(1);
  });

  it('should send heartbeat', () => {
    const agent = a2a.registerAgent({ name: 'test-agent', type: 'analyst' });
    const result = a2a.heartbeat(agent.id);
    
    expect(result).toBe(true);
  });

  it('should provide system statistics', () => {
    const stats = a2a.getStatistics();
    expect(stats).toHaveProperty('registry');
    expect(stats).toHaveProperty('lifecycle');
    expect(stats).toHaveProperty('router');
  });
});