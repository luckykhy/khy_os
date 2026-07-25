'use strict';

/**
 * Tests for multiTerminalBackend.js — multi-terminal agent management.
 */

// Mock the logger
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  detectBackends,
  selectBackend,
  createBackend,
  TmuxBackend,
  InProcessBackend,
} = require('../src/services/multiTerminalBackend');

describe('multiTerminalBackend', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── detectBackends() ──

  describe('detectBackends()', () => {
    test('returns object with tmux, iterm2, and inProcess keys', () => {
      const result = detectBackends();
      expect(result).toHaveProperty('tmux');
      expect(result).toHaveProperty('iterm2');
      expect(result).toHaveProperty('inProcess');
    });

    test('inProcess is always true', () => {
      const result = detectBackends();
      expect(result.inProcess).toBe(true);
    });

    test('all values are booleans', () => {
      const result = detectBackends();
      expect(typeof result.tmux).toBe('boolean');
      expect(typeof result.iterm2).toBe('boolean');
      expect(typeof result.inProcess).toBe('boolean');
    });
  });

  // ── selectBackend() ──

  describe('selectBackend()', () => {
    test('returns a string', () => {
      const result = selectBackend();
      expect(typeof result).toBe('string');
    });

    test('returns "inProcess" when explicitly requested', () => {
      const result = selectBackend('inProcess');
      expect(result).toBe('inProcess');
    });

    test('returns one of the known backend names', () => {
      const result = selectBackend();
      expect(['tmux', 'iterm2', 'inProcess']).toContain(result);
    });
  });

  // ── InProcessBackend ──

  describe('InProcessBackend', () => {
    let backend;

    beforeEach(() => {
      backend = new InProcessBackend();
    });

    afterEach(() => {
      backend.destroy();
    });

    test('spawnAgent() creates a child process and returns agentId + pid', async () => {
      const result = await backend.spawnAgent('test-agent-1', 'echo', ['hello']);
      expect(result).toHaveProperty('agentId', 'test-agent-1');
      expect(result).toHaveProperty('pid');
      expect(typeof result.pid).toBe('number');
    });

    test('listAgents() returns spawned agents', async () => {
      await backend.spawnAgent('agent-a', 'echo', ['a']);
      await backend.spawnAgent('agent-b', 'echo', ['b']);

      const agents = backend.listAgents();
      expect(agents.length).toBe(2);

      const ids = agents.map((a) => a.agentId);
      expect(ids).toContain('agent-a');
      expect(ids).toContain('agent-b');
    });

    test('listAgents() returns objects with agentId, pid, and alive fields', async () => {
      await backend.spawnAgent('agent-fields', 'echo', ['x']);
      const agents = backend.listAgents();

      expect(agents[0]).toHaveProperty('agentId');
      expect(agents[0]).toHaveProperty('pid');
      expect(agents[0]).toHaveProperty('alive');
    });

    test('killAgent() removes agent from the list', async () => {
      await backend.spawnAgent('agent-kill', 'sleep', ['60']);

      const beforeKill = backend.listAgents();
      expect(beforeKill.some((a) => a.agentId === 'agent-kill')).toBe(true);

      backend.killAgent('agent-kill');

      const afterKill = backend.listAgents();
      expect(afterKill.some((a) => a.agentId === 'agent-kill')).toBe(false);
    });

    test('killAgent() is a no-op for unknown agent', () => {
      expect(() => backend.killAgent('nonexistent')).not.toThrow();
    });

    test('destroy() cleans up all agents', async () => {
      await backend.spawnAgent('d1', 'sleep', ['60']);
      await backend.spawnAgent('d2', 'sleep', ['60']);

      expect(backend.listAgents().length).toBe(2);

      backend.destroy();

      expect(backend.listAgents().length).toBe(0);
    });

    test('getProcess() returns child process for spawned agent', async () => {
      await backend.spawnAgent('proc-get', 'echo', ['test']);
      const child = backend.getProcess('proc-get');
      expect(child).toBeDefined();
      expect(child).toHaveProperty('pid');
    });

    test('getProcess() returns null for unknown agent', () => {
      const child = backend.getProcess('no-such-agent');
      expect(child).toBeNull();
    });
  });

  // ── createBackend() ──

  describe('createBackend()', () => {
    test('createBackend("inProcess") returns an InProcessBackend instance', () => {
      const b = createBackend('inProcess');
      expect(b).toBeInstanceOf(InProcessBackend);
      b.destroy();
    });

    test('createBackend() without type returns a backend instance', () => {
      const b = createBackend();
      expect(b).toBeDefined();
      expect(typeof b.spawnAgent).toBe('function');
      expect(typeof b.listAgents).toBe('function');
      expect(typeof b.destroy).toBe('function');
      b.destroy();
    });
  });

  // ── TmuxBackend constructor ──

  describe('TmuxBackend', () => {
    test('constructor sets session name from options', () => {
      const b = new TmuxBackend({ sessionName: 'my-test-session' });
      expect(b.sessionName).toBe('my-test-session');
    });

    test('constructor auto-generates session name when not provided', () => {
      const b = new TmuxBackend();
      expect(b.sessionName).toMatch(/^khy-agent-/);
    });
  });
});
