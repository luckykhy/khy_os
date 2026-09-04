'use strict';

/**
 * Tests for TaskScheduler (taskScheduler.js)
 *
 * Validates:
 * 1. Task creation and state management
 * 2. Dependency graph resolution
 * 3. Parallel execution with concurrency limits
 * 4. Sequential execution
 * 5. Error handling and retries
 * 6. Cancellation
 * 7. Cycle detection
 * 8. Progress tracking
 */

const {
  Task,
  TaskGraph,
  TaskScheduler,
  TaskState,
  TaskPriority,
} = require('./taskScheduler');

// ── Test Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// ── Task Tests ────────────────────────────────────────────────────────────

function testTaskCreation() {
  console.log('\n── Task Creation ──');

  const task = new Task({
    id: 'test-1',
    name: 'Test Task',
    execute: async () => 'result',
    dependencies: ['dep-1'],
    priority: TaskPriority.HIGH,
    timeoutMs: 5000,
    retries: 2,
  });

  assert(task.id === 'test-1', 'task id set');
  assert(task.name === 'Test Task', 'task name set');
  assert(task.state === TaskState.PENDING, 'initial state is pending');
  assert(task.dependencies.length === 1, 'dependencies set');
  assert(task.priority === TaskPriority.HIGH, 'priority set');
  assert(task.timeoutMs === 5000, 'timeout set');
  assert(task.retries === 2, 'retries set');
  assert(task.duration === 0, 'duration is 0 before start');
}

// ── TaskGraph Tests ───────────────────────────────────────────────────────

function testTaskGraph() {
  console.log('\n── TaskGraph: Add & Lookup ──');

  const graph = new TaskGraph();

  const task1 = new Task({ id: 'a', execute: async () => 'a' });
  const task2 = new Task({ id: 'b', execute: async () => 'b', dependencies: ['a'] });
  const task3 = new Task({ id: 'c', execute: async () => 'c', dependencies: ['a', 'b'] });

  graph.add(task1);
  graph.add(task2);
  graph.add(task3);

  assert(graph.tasks.size === 3, 'graph has 3 tasks');
  assert(graph.get('a') === task1, 'get task a');
  assert(graph.get('nonexistent') === undefined, 'get nonexistent returns undefined');

  console.log('\n── TaskGraph: Validation ──');

  const validation = graph.validate();
  assert(validation.valid === true, 'valid graph passes validation');

  // Add task with missing dependency
  graph.add(new Task({ id: 'd', execute: async () => 'd', dependencies: ['missing'] }));
  const invalid = graph.validate();
  assert(invalid.valid === false, 'graph with missing dep fails validation');
  assert(invalid.errors.some(e => e.includes('missing')), 'error mentions missing dep');

  console.log('\n── TaskGraph: Cycle Detection ──');

  const cyclicGraph = new TaskGraph();
  cyclicGraph.add(new Task({ id: 'x', execute: async () => 'x', dependencies: ['y'] }));
  cyclicGraph.add(new Task({ id: 'y', execute: async () => 'y', dependencies: ['z'] }));
  cyclicGraph.add(new Task({ id: 'z', execute: async () => 'z', dependencies: ['x'] }));

  const cyclic = cyclicGraph.validate();
  assert(cyclic.valid === false, 'cyclic graph fails validation');
  assert(cyclic.errors.some(e => e.includes('cycle')), 'error mentions cycle');

  console.log('\n── TaskGraph: Topological Sort ──');

  const sorted = graph.topologicalSort();
  assert(sorted.length === 4, 'sorted has all tasks');
  const idxA = sorted.findIndex(t => t.id === 'a');
  const idxB = sorted.findIndex(t => t.id === 'b');
  const idxC = sorted.findIndex(t => t.id === 'c');
  assert(idxA < idxB, 'a before b');
  assert(idxB < idxC, 'b before c');

  console.log('\n── TaskGraph: Ready Tasks ──');

  const readyGraph = new TaskGraph();
  readyGraph.add(new Task({ id: 'r1', execute: async () => 'r1' }));
  readyGraph.add(new Task({ id: 'r2', execute: async () => 'r2' }));
  readyGraph.add(new Task({ id: 'r3', execute: async () => 'r3', dependencies: ['r1'] }));

  const ready = readyGraph.getReadyTasks();
  assert(ready.length === 2, '2 ready tasks (no deps)');
  assert(ready.some(t => t.id === 'r1'), 'r1 is ready');
  assert(ready.some(t => t.id === 'r2'), 'r2 is ready');
}

// ── Scheduler Tests ───────────────────────────────────────────────────────

async function testSchedulerParallel() {
  console.log('\n── Scheduler: Parallel Execution ──');

  const scheduler = new TaskScheduler({ concurrency: 2 });
  const executionOrder = [];
  const startTimes = {};

  scheduler.addAll([
    {
      id: 'p1',
      name: 'Task 1',
      priority: TaskPriority.HIGH,
      execute: async () => {
        startTimes.p1 = Date.now();
        executionOrder.push('p1');
        await new Promise(r => setTimeout(r, 50));
        return 'result-1';
      },
    },
    {
      id: 'p2',
      name: 'Task 2',
      priority: TaskPriority.NORMAL,
      execute: async () => {
        startTimes.p2 = Date.now();
        executionOrder.push('p2');
        await new Promise(r => setTimeout(r, 30));
        return 'result-2';
      },
    },
    {
      id: 'p3',
      name: 'Task 3',
      priority: TaskPriority.LOW,
      execute: async () => {
        executionOrder.push('p3');
        await new Promise(r => setTimeout(r, 10));
        return 'result-3';
      },
    },
  ]);

  const results = await scheduler.run();

  assert(results.size === 3, 'all 3 tasks completed');
  for (const [id, task] of results) {
    assert(task.state === TaskState.COMPLETED, `${id} completed`);
    assert(task.result === `result-${id.slice(1)}`, `${id} has correct result`);
  }
}

async function testSchedulerSequential() {
  console.log('\n── Scheduler: Sequential Execution ──');

  const scheduler = new TaskScheduler();
  const executionOrder = [];

  scheduler.addAll([
    {
      id: 's1',
      execute: async () => { executionOrder.push('s1'); return 'r1'; },
    },
    {
      id: 's2',
      execute: async () => { executionOrder.push('s2'); return 'r2'; },
    },
    {
      id: 's3',
      execute: async () => { executionOrder.push('s3'); return 'r3'; },
    },
  ]);

  await scheduler.run({ parallel: false });

  assert(executionOrder[0] === 's1', 's1 first');
  assert(executionOrder[1] === 's2', 's2 second');
  assert(executionOrder[2] === 's3', 's3 third');
}

async function testSchedulerDependencies() {
  console.log('\n── Scheduler: Dependency Resolution ──');

  const scheduler = new TaskScheduler({ concurrency: 4 });
  const executionOrder = [];

  scheduler.addAll([
    {
      id: 'dep-a',
      execute: async () => { executionOrder.push('a'); return 'A'; },
    },
    {
      id: 'dep-b',
      execute: async () => { executionOrder.push('b'); return 'B'; },
    },
    {
      id: 'dep-c',
      dependencies: ['dep-a', 'dep-b'],
      execute: async (ctx) => {
        executionOrder.push('c');
        assert(ctx.dependencies['dep-a'].result === 'A', 'c sees A result');
        assert(ctx.dependencies['dep-b'].result === 'B', 'c sees B result');
        return 'C';
      },
    },
  ]);

  const results = await scheduler.run();

  assert(results.get('dep-c').state === TaskState.COMPLETED, 'c completed');
  const idxA = executionOrder.indexOf('a');
  const idxB = executionOrder.indexOf('b');
  const idxC = executionOrder.indexOf('c');
  assert(idxC > idxA && idxC > idxB, 'c runs after a and b');
}

async function testSchedulerRetries() {
  console.log('\n── Scheduler: Retry Logic ──');

  let attempts = 0;
  const scheduler = new TaskScheduler();

  scheduler.add({
    id: 'retry-task',
    retries: 2,
    execute: async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`Attempt ${attempts} failed`);
      }
      return 'success';
    },
  });

  const results = await scheduler.run({ parallel: false });
  const task = results.get('retry-task');

  assert(task.state === TaskState.COMPLETED, 'task eventually succeeded');
  assert(attempts === 3, 'task attempted 3 times');
  assert(task.result === 'success', 'task has success result');
}

async function testSchedulerErrorHandling() {
  console.log('\n── Scheduler: Error Handling ──');

  const scheduler = new TaskScheduler({ continueOnError: true });

  scheduler.addAll([
    {
      id: 'ok-task',
      execute: async () => 'ok',
    },
    {
      id: 'fail-task',
      execute: async () => { throw new Error('intentional failure'); },
    },
  ]);

  const results = await scheduler.run({ parallel: false });

  assert(results.get('ok-task').state === TaskState.COMPLETED, 'ok task completed');
  assert(results.get('fail-task').state === TaskState.FAILED, 'fail task failed');
  assert(results.get('fail-task').error.message === 'intentional failure', 'error preserved');
}

async function testSchedulerCancellation() {
  console.log('\n── Scheduler: Cancellation ──');

  const scheduler = new TaskScheduler();

  scheduler.add({
    id: 'cancel-task',
    execute: async (ctx) => {
      // Wait for abort
      await new Promise((_, reject) => {
        ctx.abortSignal.addEventListener('abort', () => reject(new Error('cancelled')));
      });
      return 'never';
    },
  });

  // Start execution and cancel immediately
  const runPromise = scheduler.run({ parallel: false });
  scheduler.cancel('cancel-task');

  const results = await runPromise;
  const task = results.get('cancel-task');
  assert(task.state === TaskState.CANCELLED || task.state === TaskState.FAILED, 'task cancelled or failed');
}

async function testSchedulerStats() {
  console.log('\n── Scheduler: Statistics ──');

  const scheduler = new TaskScheduler();

  scheduler.addAll([
    { id: 'stat-1', execute: async () => 'ok' },
    { id: 'stat-2', execute: async () => 'ok' },
    { id: 'stat-3', execute: async () => { throw new Error('fail'); } },
  ]);

  await scheduler.run({ parallel: false });

  const stats = scheduler.stats;
  assert(stats.totalScheduled === 3, '3 scheduled');
  assert(stats.totalCompleted === 2, '2 completed');
  assert(stats.totalFailed === 1, '1 failed');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  TaskScheduler Tests');
  console.log('═══════════════════════════════════════════');

  testTaskCreation();
  testTaskGraph();
  await testSchedulerParallel();
  await testSchedulerSequential();
  await testSchedulerDependencies();
  await testSchedulerRetries();
  await testSchedulerErrorHandling();
  await testSchedulerCancellation();
  await testSchedulerStats();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
