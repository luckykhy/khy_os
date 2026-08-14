'use strict';

/**
 * Tests for D4 worker routing, zombie detection, and dependency timeout.
 */

jest.mock('../../src/services/resourceGuard', () => ({
  startWatchdog: () => ({ touch: () => {}, done: () => {} }),
  createProcessLimits: () => ({ execArgv: [], env: {} }),
}));

jest.mock('../../src/coordinator/taskBoard', () => {
  const _tasks = new Map();
  return {
    claimTask: jest.fn((id, workerId) => {
      const task = _tasks.get(id);
      if (!task || task.status !== 'pending') return false;
      task.status = 'claimed';
      task.assignee = workerId;
      return true;
    }),
    completeTask: jest.fn((id, result) => {
      const task = _tasks.get(id);
      if (!task) return null;
      task.status = 'completed';
      task.result = result;
      return task;
    }),
    failTask: jest.fn((id, error) => {
      const task = _tasks.get(id);
      if (!task) return null;
      task.status = 'failed';
      task.result = error;
      return task;
    }),
    _tasks,
    _addTask: (id, task) => _tasks.set(id, { id, status: 'pending', ...task }),
    _reset: () => _tasks.clear(),
  };
});

const {
  spawnWorker,
  sendMessage,
  routeMessage,
  detectZombies,
  startZombieDetector,
  stopZombieDetector,
  listWorkers,
  cleanup: cleanupWorkers,
  ZOMBIE_THRESHOLD_MS,
} = require('../../src/coordinator/workerAgent');

function purgeAllWorkers() {
  for (const w of listWorkers()) {
    w.status = 'completed';
    w.completedAt = 1;
  }
  cleanupWorkers(0);
}

describe('D4: worker-to-worker routing', () => {
  let worker1, worker2;

  beforeEach(async () => {
    purgeAllWorkers();
    const ctx = { id: 'parent-1', depth: 0 };
    worker1 = await spawnWorker('task 1', { role: 'general', parentContext: ctx });
    worker2 = await spawnWorker('task 2', { role: 'general', parentContext: ctx });
    worker1.status = 'running';
    worker2.status = 'running';
  });

  test('routes message between siblings', () => {
    const result = routeMessage(worker1.id, worker2.id, 'hello sibling');
    expect(result.routed).toBe(true);
    expect(result.path).toBe('direct');
    expect(typeof result.seq).toBe('number');
    expect(worker2.mailbox.queue).toHaveLength(1);
    expect(worker2.mailbox.queue[0].sender).toBe(worker1.id);
  });

  test('rejects routing to unknown worker', () => {
    const result = routeMessage(worker1.id, 'nonexistent', 'hello');
    expect(result.routed).toBe(false);
    expect(result.reason).toBe('unknown_worker');
  });

  test('rejects routing to stopped worker', () => {
    worker2.status = 'stopped';
    const result = routeMessage(worker1.id, worker2.id, 'hello');
    expect(result.routed).toBe(false);
    expect(result.reason).toBe('target_not_running');
  });

  test('rejects routing between non-siblings', async () => {
    const otherCtx = { id: 'parent-2', depth: 0 };
    const worker3 = await spawnWorker('task 3', { role: 'general', parentContext: otherCtx });
    worker3.status = 'running';
    const result = routeMessage(worker1.id, worker3.id, 'hello');
    expect(result.routed).toBe(false);
    expect(result.reason).toBe('not_siblings');
  });

  test('returns backpressure when target queue full', () => {
    worker2.mailbox.maxSize = 2;
    routeMessage(worker1.id, worker2.id, 'msg1');
    routeMessage(worker1.id, worker2.id, 'msg2');
    const result = routeMessage(worker1.id, worker2.id, 'msg3');
    expect(result.routed).toBe(false);
    expect(result.reason).toBe('backpressure');
  });
});

describe('D4: zombie detection', () => {
  beforeEach(() => {
    purgeAllWorkers();
    stopZombieDetector();
  });

  test('detects worker with stale _lastActivity', async () => {
    const worker = await spawnWorker('zombie task', { role: 'general' });
    worker.status = 'running';
    worker._lastActivity = Date.now() - ZOMBIE_THRESHOLD_MS - 1000;

    const zombies = detectZombies();
    expect(zombies).toContain(worker.id);
    expect(worker.status).toBe('error');
    expect(worker.error).toMatch(/Zombie/);
  });

  test('ignores active workers', async () => {
    const worker = await spawnWorker('active task', { role: 'general' });
    worker.status = 'running';
    worker._lastActivity = Date.now();

    const zombies = detectZombies();
    expect(zombies).not.toContain(worker.id);
    expect(worker.status).toBe('running');
  });

  test('ignores non-running workers', async () => {
    const worker = await spawnWorker('done task', { role: 'general' });
    worker.status = 'completed';
    worker._lastActivity = Date.now() - ZOMBIE_THRESHOLD_MS - 1000;

    const zombies = detectZombies();
    expect(zombies).not.toContain(worker.id);
  });

  test('startZombieDetector and stopZombieDetector are safe to call', () => {
    expect(() => startZombieDetector()).not.toThrow();
    expect(() => startZombieDetector()).not.toThrow(); // idempotent
    expect(() => stopZombieDetector()).not.toThrow();
    expect(() => stopZombieDetector()).not.toThrow(); // idempotent
  });
});

describe('D4: _lastActivity tracking', () => {
  let worker;

  beforeEach(async () => {
    purgeAllWorkers();
    worker = await spawnWorker('activity tracking', { role: 'general' });
    worker.status = 'running';
  });

  test('sendMessage updates _lastActivity', () => {
    const before = worker._lastActivity;
    sendMessage(worker.id, 'hello');
    expect(worker._lastActivity).toBeGreaterThanOrEqual(before || 0);
  });
});
