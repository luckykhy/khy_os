'use strict';

/**
 * ProcessAgent — spawn agent workers as isolated child processes.
 *
 * Uses `child_process.fork()` to create a separate V8 instance per agent,
 * communicating via structured IPC (ipcProtocol).
 *
 * Benefits over in-process workers:
 *   - Independent heap (configurable via --max-old-space-size)
 *   - Crash isolation (child crash doesn't bring down parent)
 *   - Per-process resource enforcement
 */
const { fork } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { MSG, createMessage, parseMessage, createRequestResponse } = require('./ipcProtocol');
const { createProcessLimits, startWatchdog } = require('../services/resourceGuard');
const { safeKill } = require('../tools/platformUtils');

const WORKER_ENTRY = path.join(__dirname, 'agentWorkerEntry.js');
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * @typedef {object} ProcessAgentState
 * @property {string} id
 * @property {string} task
 * @property {'created'|'initializing'|'ready'|'running'|'completed'|'error'|'killed'} status
 * @property {number|null} pid
 * @property {string} result
 * @property {object|null} metrics
 * @property {string|null} error
 * @property {number} startedAt
 * @property {number|null} completedAt
 */

class ProcessAgent extends EventEmitter {
  /**
   * @param {string} taskDescription
   * @param {object} [opts]
   * @param {string} [opts.role='general']
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxHeapMB]
   * @param {object} [opts.parentContext] - AgentContext instance (will be serialized)
   * @param {object} [opts.chatOpts] - Extra options passed to ai.chat in child
   */
  constructor(taskDescription, opts = {}) {
    super();
    this.id = 'pa-' + crypto.randomBytes(3).toString('hex');
    this.task = taskDescription;
    this.role = opts.role || 'general';
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxHeapMB = opts.maxHeapMB;
    this.parentContext = opts.parentContext || null;
    this.chatOpts = opts.chatOpts || {};

    // ── Depth tracking ──────────────────────────────────────────────
    this._currentDepth = (opts.parentContext?.depth ?? opts.parentContext?.toSerializable?.()?.depth) || 0;
    this._maxDepth = opts.maxSpawnDepth || 3;

    /** @type {ProcessAgentState} */
    this.state = {
      id: this.id,
      task: taskDescription,
      status: 'created',
      pid: null,
      result: '',
      metrics: null,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
    };

    this._child = null;
    this._rpc = null;
    this._watchdog = null;
    this._children = new Set(); // child ProcessAgent instances
  }

  /**
   * Spawn the child process, send INIT, wait for READY, send TASK, wait for RESULT.
   * @returns {Promise<ProcessAgentState>}
   */
  async run() {
    // ── Depth guard ─────────────────────────────────────────────────
    if (this._currentDepth >= this._maxDepth) {
      this.state.status = 'error';
      this.state.error = `Spawn rejected: depth ${this._currentDepth} >= maxSpawnDepth ${this._maxDepth}`;
      this.state.completedAt = Date.now();
      throw new Error(this.state.error);
    }

    // ── Hook: SubAgentStart ─────────────────────────────────────────
    try {
      const hookSystem = require('../cli/hooks/hookSystem');
      await hookSystem.trigger('SubAgentStart', {
        agentId: this.id, task: this.task, role: this.role,
        depth: this._currentDepth, mode: 'process',
      });
    } catch { /* hooks are best-effort */ }

    try {
      await this._spawn();
      await this._initialize();
      const result = await this._executeTask();

      // ── Hook: SubAgentEnd (success) ───────────────────────────────
      try {
        const hookSystem = require('../cli/hooks/hookSystem');
        await hookSystem.trigger('SubAgentEnd', {
          agentId: this.id, task: this.task, status: 'completed',
          durationMs: (this.state.completedAt || Date.now()) - this.state.startedAt,
        });
      } catch { /* hooks are best-effort */ }

      return result;
    } catch (err) {
      this.state.status = 'error';
      this.state.error = err.message;
      this.state.completedAt = Date.now();
      this._cleanup();

      // ── Hook: SubAgentEnd (error) ─────────────────────────────────
      try {
        const hookSystem = require('../cli/hooks/hookSystem');
        await hookSystem.trigger('SubAgentEnd', {
          agentId: this.id, task: this.task, status: 'error',
          error: err.message,
          durationMs: (this.state.completedAt || Date.now()) - this.state.startedAt,
        });
      } catch { /* hooks are best-effort */ }

      throw err;
    }
  }

  /**
   * Kill the agent process.
   */
  kill() {
    // ── Cascade: kill children first ────────────────────────────────
    for (const child of this._children) {
      try { child.kill(); } catch { /* best-effort */ }
    }
    this._children.clear();

    // ── Hook: Stop ──────────────────────────────────────────────────
    try {
      const hookSystem = require('../cli/hooks/hookSystem');
      hookSystem.trigger('Stop', {
        agentId: this.id, task: this.task, reason: 'killed',
      }).catch(() => {});
    } catch { /* hooks are best-effort */ }

    if (this._rpc) {
      this._rpc.notify(MSG.KILL, {});
    }
    this.state.status = 'killed';
    this.state.completedAt = Date.now();
    // Grace period before SIGKILL
    setTimeout(() => {
      if (this._child && !this._child.killed) {
        safeKill(this._child, 'SIGKILL', 0);
      }
    }, 3000);
    this._cleanup();
  }

  /**
   * Get current state snapshot.
   * @returns {ProcessAgentState}
   */
  getStatus() {
    return { ...this.state };
  }

  /**
   * Send a follow-up message to the running child agent.
   * @param {string} message - Follow-up prompt
   * @param {number} seq - Mailbox sequence number for ACK correlation
   * @returns {boolean} true if sent successfully
   */
  sendFollowUp(message, seq) {
    if (!this._child || this._child.killed) return false;
    const msg = createMessage(MSG.FOLLOW_UP, this.id, { message, seq });
    try { this._child.send(msg); return true; } catch { return false; }
  }

  // ── Internal ──────────────────────────────────────────────────────

  async _spawn() {
    const limits = createProcessLimits({
      role: this.role,
      maxHeapMB: this.maxHeapMB,
    });

    this._child = fork(WORKER_ENTRY, [], {
      execArgv: limits.execArgv,
      env: limits.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      silent: true,
    });

    this.state.pid = this._child.pid;
    this.state.status = 'initializing';

    this._rpc = createRequestResponse(this._child, this.id, {
      timeoutMs: this.timeoutMs,
    });

    // Listen for child events
    this._child.on('exit', (code, signal) => {
      if (this.state.status === 'running' || this.state.status === 'initializing') {
        this.state.status = 'error';
        this.state.error = `Child exited unexpectedly (code=${code}, signal=${signal})`;
        this.state.completedAt = Date.now();
      }
      this._cleanup();
      this.emit('exit', code, signal);
    });

    this._child.on('error', (err) => {
      this.state.status = 'error';
      this.state.error = err.message;
      this.state.completedAt = Date.now();
      this._cleanup();
      this.emit('error', err);
    });

    // Collect child stdout/stderr for diagnostics
    this._childOutput = '';
    if (this._child.stdout) {
      this._child.stdout.on('data', (chunk) => {
        this._childOutput += chunk.toString().slice(0, 10000);
      });
    }
    if (this._child.stderr) {
      this._child.stderr.on('data', (chunk) => {
        this._childOutput += chunk.toString().slice(0, 10000);
      });
    }

    // Listen for progress and metrics — touch watchdog on activity
    this._child.on('message', (raw) => {
      const parsed = parseMessage(raw);
      if (!parsed.valid) return;
      const { msg } = parsed;
      // Any IPC message counts as activity
      if (this._watchdog) this._watchdog.touch();
      if (msg.type === MSG.PROGRESS) this.emit('progress', msg.payload);
      if (msg.type === MSG.METRICS) {
        this.state.metrics = msg.payload;
        this.emit('metrics', msg.payload);
      }
      if (msg.type === MSG.ACK) {
        this.emit('ack', msg.payload);
      }
    });

    // Activity-based idle watchdog (replaces fixed setTimeout)
    this._watchdog = startWatchdog(`processAgent:${this.id}`, this.timeoutMs, () => {
      if (this.state.status === 'running' || this.state.status === 'initializing') {
        this.state.error = `Idle timeout after ${this.timeoutMs}ms`;
        this.kill();
      }
    });
  }

  async _initialize() {
    // Serialize context for IPC, propagating depth+1
    let contextData = null;
    if (this.parentContext) {
      contextData = typeof this.parentContext.toSerializable === 'function'
        ? this.parentContext.toSerializable()
        : { ...this.parentContext };
    } else {
      // Create minimal context
      const { AgentContext } = require('../services/agentContext');
      const ctx = new AgentContext({ role: this.role });
      contextData = ctx.toSerializable();
    }
    // Propagate depth+1 so children know their nesting level
    contextData.depth = (this._currentDepth || 0) + 1;

    const initMsg = createMessage(MSG.INIT, this.id, { context: contextData });
    this._child.send(initMsg);

    // Wait for READY
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Agent init timed out (no READY received)'));
      }, 15_000);
      timer.unref?.();

      const onMsg = (raw) => {
        const parsed = parseMessage(raw);
        if (!parsed.valid) return;
        if (parsed.msg.type === MSG.READY) {
          clearTimeout(timer);
          this._child.removeListener('message', onMsg);
          this.state.status = 'ready';
          resolve();
        } else if (parsed.msg.type === MSG.ERROR) {
          clearTimeout(timer);
          this._child.removeListener('message', onMsg);
          reject(new Error(parsed.msg.payload.message || 'Init error'));
        }
      };
      this._child.on('message', onMsg);
    });
  }

  async _executeTask() {
    this.state.status = 'running';

    const taskMsg = createMessage(MSG.TASK, this.id, {
      prompt: this.task,
      chatOpts: this.chatOpts,
    });
    this._child.send(taskMsg);

    // Wait for RESULT or ERROR
    return new Promise((resolve, reject) => {
      const onMsg = (raw) => {
        const parsed = parseMessage(raw);
        if (!parsed.valid) return;
        const { msg } = parsed;

        if (msg.type === MSG.RESULT) {
          this._child.removeListener('message', onMsg);
          this.state.status = 'completed';
          this.state.result = msg.payload.text || '';
          this.state.completedAt = Date.now();
          this._cleanup();
          resolve(this.state);
        } else if (msg.type === MSG.ERROR) {
          this._child.removeListener('message', onMsg);
          this.state.status = 'error';
          this.state.error = msg.payload.message || 'Unknown error';
          this.state.completedAt = Date.now();
          this._cleanup();
          reject(new Error(this.state.error));
        }
      };
      this._child.on('message', onMsg);
    });
  }

  _cleanup() {
    if (this._watchdog) {
      this._watchdog.done();
      this._watchdog = null;
    }
    if (this._rpc) {
      this._rpc.destroy();
      this._rpc = null;
    }
  }
}

module.exports = { ProcessAgent };
