'use strict';

/**
 * Tests for the mailbox protocol in workerAgent — bounded queue, ACK,
 * backpressure, sequence numbering, and taskBoard integration.
 */

// Mock the heavy dependencies so workerAgent loads cleanly
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
  acknowledgeMessage,
  getUnackedMessages,
  getWorkerStatus,
  listWorkers: listAll,
  cleanup: cleanupWorkers,
  WORKER_DEFAULTS,
} = require('../../src/coordinator/workerAgent');

function purgeAllWorkers() {
  for (const w of listAll()) {
    w.status = 'completed';
    w.completedAt = 1;
  }
  cleanupWorkers(0);
}

describe('mailbox protocol — sendMessage', () => {
  let worker;

  beforeEach(async () => {
    purgeAllWorkers();
    worker = await spawnWorker('test task', { role: 'general' });
    // Force to running for message tests
    worker.status = 'running';
  });

  test('returns seq and delivered:true on success', () => {
    const result = sendMessage(worker.id, 'hello');
    expect(result.delivered).toBe(true);
    expect(result.seq).toBe(1);
    expect(result.queueSize).toBe(1);
  });

  test('seq is monotonically increasing', () => {
    const r1 = sendMessage(worker.id, 'msg1');
    const r2 = sendMessage(worker.id, 'msg2');
    const r3 = sendMessage(worker.id, 'msg3');
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r3.seq).toBe(3);
  });

  test('returns backpressure when queue is full', () => {
    // Fill the queue to maxSize
    worker.mailbox.maxSize = 3;
    sendMessage(worker.id, 'a');
    sendMessage(worker.id, 'b');
    sendMessage(worker.id, 'c');
    const result = sendMessage(worker.id, 'overflow');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('backpressure');
    expect(result.queueSize).toBe(3);
  });

  test('returns error for unknown worker', () => {
    const result = sendMessage('nonexistent', 'hello');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('unknown_worker');
  });

  test('returns error for stopped worker', () => {
    worker.status = 'stopped';
    const result = sendMessage(worker.id, 'hello');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('not_running');
  });
});

describe('mailbox protocol — acknowledgeMessage', () => {
  let worker;

  beforeEach(async () => {
    purgeAllWorkers();
    worker = await spawnWorker('test ack', { role: 'general' });
    worker.status = 'running';
  });

  test('acks a message and prunes from head', () => {
    sendMessage(worker.id, 'msg1');
    sendMessage(worker.id, 'msg2');
    expect(worker.mailbox.queue.length).toBe(2);

    const acked = acknowledgeMessage(worker.id, 1);
    expect(acked).toBe(true);
    // First message was acked and pruned from head
    expect(worker.mailbox.queue.length).toBe(1);
    expect(worker.mailbox.queue[0].seq).toBe(2);
    expect(worker.mailbox.ackedSeq).toBe(1);
  });

  test('does not prune out-of-order acks until head is acked', () => {
    sendMessage(worker.id, 'msg1');
    sendMessage(worker.id, 'msg2');
    sendMessage(worker.id, 'msg3');

    // ACK msg3 first (out of order)
    acknowledgeMessage(worker.id, 3);
    // Head (seq=1) is not acked, so nothing pruned
    expect(worker.mailbox.queue.length).toBe(3);

    // ACK msg1
    acknowledgeMessage(worker.id, 1);
    // Now head is acked, prune it
    expect(worker.mailbox.queue.length).toBe(2);

    // ACK msg2 — now all head entries are acked, prune both
    acknowledgeMessage(worker.id, 2);
    expect(worker.mailbox.queue.length).toBe(0);
  });

  test('returns false for unknown worker', () => {
    expect(acknowledgeMessage('nonexistent', 1)).toBe(false);
  });

  test('returns false for unknown seq', () => {
    sendMessage(worker.id, 'msg1');
    expect(acknowledgeMessage(worker.id, 999)).toBe(false);
  });
});

describe('mailbox protocol — getUnackedMessages', () => {
  let worker;

  beforeEach(async () => {
    purgeAllWorkers();
    worker = await spawnWorker('test unacked', { role: 'general' });
    worker.status = 'running';
  });

  test('returns only unacked messages', () => {
    sendMessage(worker.id, 'msg1');
    sendMessage(worker.id, 'msg2');
    sendMessage(worker.id, 'msg3');

    acknowledgeMessage(worker.id, 2);
    const unacked = getUnackedMessages(worker.id);
    // msg1 was pruned (it's the head and still acked? no, only msg2 was acked)
    // Actually msg1 is unacked, msg2 is acked, msg3 is unacked
    // But head (msg1) is not acked, so no pruning happened
    expect(unacked.length).toBe(2); // msg1, msg3
    expect(unacked.map(m => m.seq)).toEqual([1, 3]);
  });

  test('returns empty for unknown worker', () => {
    expect(getUnackedMessages('nonexistent')).toEqual([]);
  });
});

describe('taskBoard integration', () => {
  const taskBoard = require('../../src/coordinator/taskBoard');

  beforeEach(() => {
    purgeAllWorkers();
    taskBoard._reset();
    taskBoard.claimTask.mockClear();
    taskBoard.completeTask.mockClear();
    taskBoard.failTask.mockClear();
  });

  test('spawnWorker with taskId auto-claims', async () => {
    taskBoard._addTask('task-1', { description: 'test' });
    const worker = await spawnWorker('do stuff', { taskId: 'task-1' });
    expect(taskBoard.claimTask).toHaveBeenCalledWith('task-1', worker.id);
    expect(worker._taskId).toBe('task-1');
  });

  test('spawnWorker fails if task cannot be claimed', async () => {
    // No task in the board — claim will return false
    const worker = await spawnWorker('do stuff', { taskId: 'nonexistent' });
    expect(worker.status).toBe('error');
    expect(worker.error).toContain('Failed to claim task');
  });

  test('spawnWorker fails if task already claimed', async () => {
    taskBoard._addTask('task-2', { description: 'test' });
    taskBoard._tasks.get('task-2').status = 'claimed'; // already claimed
    const worker = await spawnWorker('do stuff', { taskId: 'task-2' });
    expect(worker.status).toBe('error');
  });
});
