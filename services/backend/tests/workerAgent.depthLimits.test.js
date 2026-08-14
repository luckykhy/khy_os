'use strict';

describe('workerAgent depth/concurrency limits', () => {
  let workerAgent;

  beforeEach(() => {
    // Fresh require to reset module state
    jest.resetModules();
    workerAgent = require('../src/coordinator/workerAgent');
  });

  // ── Depth guard ──────────────────────────────────────────────────

  test('spawn refused when depth >= maxSpawnDepth', async () => {
    const result = await workerAgent.spawnWorker('deep task', {
      parentContext: { depth: 3, id: 'parent-1' },
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/depth 3 >= maxSpawnDepth 3/);
  });

  test('spawn allowed when depth < maxSpawnDepth', async () => {
    const result = await workerAgent.spawnWorker('shallow task', {
      parentContext: { depth: 1, id: 'parent-2' },
    });
    // Should not be rejected by depth guard
    expect(result.status).not.toBe('error');
    expect(result.error).toBeNull();
    // Cleanup
    workerAgent.shutdownWorker(result.id);
  });

  test('spawn allowed with no parentContext (depth 0)', async () => {
    const result = await workerAgent.spawnWorker('root task');
    expect(result.status).not.toBe('error');
    expect(result.error).toBeNull();
    workerAgent.shutdownWorker(result.id);
  });

  // ── Concurrency guard ──────────────────────────────────────────

  test('concurrent children limit enforcement', async () => {
    const parentId = 'parent-concurrent';
    const children = [];

    // Spawn maxConcurrentChildren workers
    for (let i = 0; i < workerAgent.WORKER_DEFAULTS.maxConcurrentChildren; i++) {
      const w = await workerAgent.spawnWorker(`task-${i}`, {
        parentContext: { depth: 0, id: parentId },
      });
      expect(w.status).not.toBe('error');
      children.push(w);
    }

    // Next spawn should be refused
    const rejected = await workerAgent.spawnWorker('over-limit', {
      parentContext: { depth: 0, id: parentId },
    });
    expect(rejected.status).toBe('error');
    expect(rejected.error).toMatch(/maxConcurrentChildren/);

    // Cleanup
    children.forEach(w => workerAgent.shutdownWorker(w.id));
  });

  test('completed children do not count towards concurrency limit', async () => {
    const parentId = 'parent-completed';
    const children = [];

    for (let i = 0; i < workerAgent.WORKER_DEFAULTS.maxConcurrentChildren; i++) {
      const w = await workerAgent.spawnWorker(`task-${i}`, {
        parentContext: { depth: 0, id: parentId },
      });
      children.push(w);
    }

    // Stop one child — it becomes 'stopped', freeing a slot
    workerAgent.shutdownWorker(children[0].id);

    const extra = await workerAgent.spawnWorker('after-free', {
      parentContext: { depth: 0, id: parentId },
    });
    expect(extra.status).not.toBe('error');
    workerAgent.shutdownWorker(extra.id);
    children.slice(1).forEach(w => workerAgent.shutdownWorker(w.id));
  });

  // ── Cascading shutdown ───────────────────────────────────────────

  test('shutdownWorker cascades to children', async () => {
    const parentResult = await workerAgent.spawnWorker('parent task', {
      parentContext: { depth: 0, id: '__root__' },
    });

    // Simulate spawning children under this parent
    const child1 = await workerAgent.spawnWorker('child-1', {
      parentContext: { depth: 1, id: parentResult.id },
    });
    const child2 = await workerAgent.spawnWorker('child-2', {
      parentContext: { depth: 1, id: parentResult.id },
    });

    // Shutdown parent — should cascade
    workerAgent.shutdownWorker(parentResult.id);

    expect(workerAgent.getWorkerStatus(child1.id).status).toBe('stopped');
    expect(workerAgent.getWorkerStatus(child2.id).status).toBe('stopped');
    expect(workerAgent.getWorkerStatus(parentResult.id).status).toBe('stopped');
  });

  // ── WORKER_DEFAULTS export ──────────────────────────────────────

  test('WORKER_DEFAULTS exported and configurable via env', () => {
    expect(workerAgent.WORKER_DEFAULTS).toBeDefined();
    expect(workerAgent.WORKER_DEFAULTS.maxSpawnDepth).toBe(3);
    expect(workerAgent.WORKER_DEFAULTS.maxConcurrentChildren).toBe(3);
    expect(workerAgent.WORKER_DEFAULTS.childTimeoutMs).toBe(300_000);
  });

  // ── _depth stored on worker ──────────────────────────────────────

  test('worker stores _depth from parentContext', async () => {
    const result = await workerAgent.spawnWorker('depth test', {
      parentContext: { depth: 2, id: 'p-depth' },
    });
    expect(result._depth).toBe(2);
    workerAgent.shutdownWorker(result.id);
  });
});
