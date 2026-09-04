'use strict';

/**
 * taskScheduler.js — Dependency-graph based parallel task scheduler.
 *
 * Inspired by Y-code's TaskScheduler with dependency-aware parallel execution.
 * Extends Khy OS's subAgentOrchestrator with proper task scheduling.
 *
 * Architecture:
 *   - Task: unit of work with dependencies
 *   - TaskGraph: dependency resolution via topological sort
 *   - TaskScheduler: parallel execution with concurrency limits
 *
 * Key capabilities:
 *   1. Dependency graph resolution (topological sort)
 *   2. Parallel execution with configurable concurrency
 *   3. Result propagation to dependent tasks
 *   4. Cycle detection and error handling
 *   5. Progress tracking and cancellation
 *
 * @module taskScheduler
 */

const { EventEmitter } = require('events');

// ── Task State Constants ─────────────────────────────────────────────────

const TaskState = Object.freeze({
  PENDING: 'pending',
  WAITING: 'waiting',     // Waiting for dependencies
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

// ── Task Priority Constants ──────────────────────────────────────────────

const TaskPriority = Object.freeze({
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
  BACKGROUND: 4,
});

// ── Task Class ───────────────────────────────────────────────────────────

/**
 * A unit of work with dependencies and metadata.
 */
class Task {
  /**
   * @param {object} config
   * @param {string} config.id - Unique task identifier
   * @param {string} config.name - Human-readable name
   * @param {function} config.execute - Async function (ctx) => result
   * @param {string[]} [config.dependencies=[]] - IDs of tasks this depends on
   * @param {number} [config.priority=TaskPriority.NORMAL] - Execution priority
   * @param {number} [config.timeoutMs=30000] - Per-task timeout
   * @param {number} [config.retries=0] - Number of retry attempts
   * @param {object} [config.metadata={}] - Additional metadata
   */
  constructor(config) {
    if (!config || !config.id || typeof config.execute !== 'function') {
      throw new TypeError('Task requires id and execute function');
    }

    this.id = config.id;
    this.name = config.name || config.id;
    this.execute = config.execute;
    this.dependencies = config.dependencies || [];
    this.priority = config.priority ?? TaskPriority.NORMAL;
    this.timeoutMs = config.timeoutMs || 30000;
    this.retries = config.retries || 0;
    this.metadata = config.metadata || {};

    this.state = TaskState.PENDING;
    this.result = null;
    this.error = null;
    this.attempts = 0;
    this.startedAt = null;
    this.completedAt = null;
    this.abortController = null;
  }

  get duration() {
    if (!this.startedAt) return 0;
    return (this.completedAt || Date.now()) - this.startedAt;
  }
}

// ── TaskGraph Class ──────────────────────────────────────────────────────

/**
 * Manages task dependencies and resolves execution order.
 */
class TaskGraph {
  constructor() {
    /** @type {Map<string, Task>} */
    this.tasks = new Map();
  }

  /**
   * Add a task to the graph.
   * @param {Task} task
   */
  add(task) {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" already exists in graph`);
    }
    this.tasks.set(task.id, task);
  }

  /**
   * Get a task by ID.
   * @param {string} id
   * @returns {Task|undefined}
   */
  get(id) {
    return this.tasks.get(id);
  }

  /**
   * Validate the graph: check for missing dependencies and cycles.
   * @returns {object} { valid: boolean, errors: string[] }
   */
  validate() {
    const errors = [];

    // Check for missing dependencies
    for (const [id, task] of this.tasks) {
      for (const depId of task.dependencies) {
        if (!this.tasks.has(depId)) {
          errors.push(`Task "${id}" depends on missing task "${depId}"`);
        }
      }
    }

    // Check for cycles using DFS
    const visited = new Set();
    const inStack = new Set();

    const visit = (taskId, path) => {
      if (inStack.has(taskId)) {
        const cycle = [...path, taskId].join(' -> ');
        errors.push(`Dependency cycle detected: ${cycle}`);
        return;
      }
      if (visited.has(taskId)) return;

      visited.add(taskId);
      inStack.add(taskId);

      const task = this.tasks.get(taskId);
      if (task) {
        for (const depId of task.dependencies) {
          visit(depId, [...path, taskId]);
        }
      }

      inStack.delete(taskId);
    };

    for (const id of this.tasks.keys()) {
      visit(id, []);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get tasks that are ready to execute (all dependencies met).
   * @returns {Task[]}
   */
  getReadyTasks() {
    const ready = [];
    for (const task of this.tasks.values()) {
      if (task.state !== TaskState.PENDING) continue;
      const depsMet = task.dependencies.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.state === TaskState.COMPLETED;
      });
      if (depsMet) {
        task.state = TaskState.WAITING;
        ready.push(task);
      }
    }
    // Sort by priority (lower = higher priority)
    return ready.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get all tasks in topological order.
   * @returns {Task[]}
   */
  topologicalSort() {
    const result = [];
    const visited = new Set();

    const visit = (taskId) => {
      if (visited.has(taskId)) return;
      visited.add(taskId);

      const task = this.tasks.get(taskId);
      if (task) {
        for (const depId of task.dependencies) {
          visit(depId);
        }
        result.push(task);
      }
    };

    for (const id of this.tasks.keys()) {
      visit(id);
    }

    return result;
  }

  /**
   * Get execution statistics.
   * @returns {object}
   */
  getStats() {
    const stats = {
      total: this.tasks.size,
      pending: 0,
      waiting: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      stats[task.state]++;
    }

    return stats;
  }
}

// ── TaskScheduler Class ──────────────────────────────────────────────────

/**
 * Parallel task scheduler with dependency resolution.
 */
class TaskScheduler extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency=4] - Max parallel tasks
   * @param {number} [options.defaultTimeoutMs=30000] - Default task timeout
   * @param {boolean} [options.continueOnError=false] - Continue on task failure
   */
  constructor(options = {}) {
    super();
    this._concurrency = options.concurrency || 4;
    this._defaultTimeoutMs = options.defaultTimeoutMs || 30000;
    this._continueOnError = options.continueOnError === true;
    this._graph = new TaskGraph();
    this._running = false;
    this._abortControllers = new Map();
    this._stats = {
      totalScheduled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalCancelled: 0,
      totalRetries: 0,
    };
  }

  // ── Properties ──────────────────────────────────────────────────────

  get isRunning() { return this._running; }
  get stats() { return { ...this._stats, graph: this._graph.getStats() }; }

  // ── Task Management ─────────────────────────────────────────────────

  /**
   * Add a task to the scheduler.
   * @param {Task|object} task - Task instance or config object
   * @returns {TaskScheduler} this (for chaining)
   */
  add(task) {
    const taskInstance = task instanceof Task ? task : new Task(task);
    this._graph.add(taskInstance);
    this._stats.totalScheduled++;
    return this;
  }

  /**
   * Add multiple tasks at once.
   * @param {Task[]|object[]} tasks
   * @returns {TaskScheduler}
   */
  addAll(tasks) {
    for (const task of tasks) {
      this.add(task);
    }
    return this;
  }

  // ── Execution ───────────────────────────────────────────────────────

  /**
   * Execute all tasks respecting dependencies.
   * @param {object} [options]
   * @param {boolean} [options.parallel=true] - Enable parallel execution
   * @returns {Promise<Map<string, Task>>} All tasks with results
   */
  async run(options = {}) {
    const parallel = options.parallel !== false;

    // Validate graph
    const validation = this._graph.validate();
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join('; ')}`);
    }

    this._running = true;
    this.emit('start');

    try {
      if (parallel) {
        await this._runParallel();
      } else {
        await this._runSequential();
      }
    } finally {
      this._running = false;
      this.emit('complete', this._graph.getStats());
    }

    return this._graph.tasks;
  }

  /**
   * Run tasks in parallel with concurrency limit.
   * @private
   */
  async _runParallel() {
    const queue = this._graph.getReadyTasks();
    const running = new Set();

    const processNext = async () => {
      while (queue.length > 0 && running.size < this._concurrency) {
        const task = queue.shift();
        if (!task || task.state === TaskState.CANCELLED) continue;

        const promise = this._executeTask(task).finally(() => {
          running.delete(promise);
          // Check for newly ready tasks
          const newReady = this._graph.getReadyTasks();
          queue.push(...newReady);
          // Process next if available
          if (queue.length > 0 && running.size < this._concurrency) {
            processNext();
          }
        });

        running.add(promise);
      }
    };

    // Start initial batch
    await processNext();

    // Wait for all running tasks
    while (running.size > 0) {
      await Promise.race(running);
    }
  }

  /**
   * Run tasks sequentially in topological order.
   * @private
   */
  async _runSequential() {
    const sorted = this._graph.topologicalSort();
    for (const task of sorted) {
      if (task.state === TaskState.CANCELLED) continue;
      await this._executeTask(task);
      if (task.state === TaskState.FAILED && !this._continueOnError) {
        break;
      }
    }
  }

  /**
   * Execute a single task with timeout and retry logic.
   * @private
   */
  async _executeTask(task) {
    task.state = TaskState.RUNNING;
    task.startedAt = Date.now();
    task.abortController = new AbortController();

    this.emit('task:start', task);

    const maxAttempts = 1 + (task.retries || 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      task.attempts++;

      try {
        // Build context with dependency results
        const context = this._buildTaskContext(task);

        // Execute with timeout
        const result = await this._executeWithTimeout(task, context);

        task.result = result;
        task.state = TaskState.COMPLETED;
        task.completedAt = Date.now();
        this._stats.totalCompleted++;

        this.emit('task:complete', task);
        return;
      } catch (err) {
        task.error = err;

        if (task.abortController.signal.aborted) {
          task.state = TaskState.CANCELLED;
          this._stats.totalCancelled++;
          this.emit('task:cancel', task);
          return;
        }

        if (attempt < maxAttempts - 1) {
          this._stats.totalRetries++;
          this.emit('task:retry', task, attempt + 1);
          // Exponential backoff
          await this._delay(Math.min(1000 * Math.pow(2, attempt), 10000));
        }
      }
    }

    task.state = TaskState.FAILED;
    task.completedAt = Date.now();
    this._stats.totalFailed++;
    this.emit('task:fail', task);
  }

  /**
   * Build execution context with dependency results.
   * @private
   */
  _buildTaskContext(task) {
    const depResults = {};
    for (const depId of task.dependencies) {
      const dep = this._graph.get(depId);
      if (dep) {
        depResults[depId] = {
          result: dep.result,
          error: dep.error,
          state: dep.state,
        };
      }
    }

    return {
      dependencies: depResults,
      abortSignal: task.abortController.signal,
      attempt: task.attempts,
      metadata: task.metadata,
    };
  }

  /**
   * Execute task with timeout.
   * @private
   */
  async _executeWithTimeout(task, context) {
    return new Promise((resolve, reject) => {
      const timeoutMs = task.timeoutMs || this._defaultTimeoutMs;
      const timer = setTimeout(() => {
        task.abortController.abort();
        reject(new Error(`Task "${task.id}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      task.execute(context)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  // ── Cancellation ────────────────────────────────────────────────────

  /**
   * Cancel a specific task.
   * @param {string} taskId
   * @returns {boolean}
   */
  cancel(taskId) {
    const task = this._graph.get(taskId);
    if (!task || task.state !== TaskState.RUNNING) return false;

    task.abortController.abort();
    return true;
  }

  /**
   * Cancel all running tasks.
   */
  cancelAll() {
    for (const task of this._graph.tasks.values()) {
      if (task.state === TaskState.RUNNING && task.abortController) {
        task.abortController.abort();
      }
    }
  }

  // ── Utility ─────────────────────────────────────────────────────────

  /**
   * Delay helper.
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset the scheduler for reuse.
   */
  reset() {
    this._graph = new TaskGraph();
    this._running = false;
    this._abortControllers.clear();
    this._stats = {
      totalScheduled: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalCancelled: 0,
      totalRetries: 0,
    };
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  Task,
  TaskGraph,
  TaskScheduler,
  TaskState,
  TaskPriority,
};
