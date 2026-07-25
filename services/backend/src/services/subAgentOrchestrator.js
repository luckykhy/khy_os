'use strict';

/**
 * subAgentOrchestrator.js — Sub-agent orchestration with session forking.
 *
 * Ported from OpenClaw's sub-agent orchestration (1326 lines).
 * Provides a framework for spawning, managing, and coordinating
 * sub-agents that operate within isolated sessions. Features session
 * forking with inheritance, depth-limited recursion, scope-based
 * privilege management, and workspace materialization.
 *
 * Key features:
 * - Session forking: child agents inherit parent context selectively
 * - Depth-limited recursion: configurable max depth to prevent runaway
 * - Scope-based privileges: child can't exceed parent permissions
 * - Workspace materialization: each agent gets isolated workspace
 * - Result aggregation: collect and merge child results
 * - Lifecycle management: spawn, monitor, kill, cleanup
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

// ── Agent states ──

const AGENT_STATE = {
  CREATED:    'created',
  RUNNING:    'running',
  WAITING:    'waiting',
  COMPLETED:  'completed',
  FAILED:     'failed',
  KILLED:     'killed',
  TIMED_OUT:  'timed_out',
};

// ── Default limits ──

const DEFAULTS = {
  maxDepth: 3,              // Max nesting depth
  maxChildren: 10,          // Max concurrent child agents
  agentTimeoutMs: 300_000,  // 5 minutes per agent
  maxTotalAgents: 50,       // Total agents across all depths
  inheritContext: true,     // Whether to inherit parent context
  inheritTools: true,       // Whether to inherit parent tools
};

/**
 * @typedef {object} AgentSession
 * @property {string} id - Unique agent ID
 * @property {string} [parentId] - Parent agent ID (null for root)
 * @property {number} depth - Nesting depth (0 = root)
 * @property {string} name - Agent name/purpose
 * @property {string} state - AGENT_STATE
 * @property {string[]} scopes - Permitted scopes
 * @property {object} context - Agent's working context
 * @property {object} [result] - Agent's output
 * @property {string} [error] - Error message
 * @property {number} createdAt
 * @property {number} [completedAt]
 * @property {string[]} childIds - Child agent IDs
 */

class SubAgentOrchestrator extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxDepth=3]
   * @param {number} [opts.maxChildren=10]
   * @param {number} [opts.agentTimeoutMs=300000]
   * @param {number} [opts.maxTotalAgents=50]
   * @param {function} [opts.executeFn] - (session: AgentSession) => Promise<result>
   */
  constructor(opts = {}) {
    super();
    this._config = { ...DEFAULTS, ...opts };
    // 20 倍模式:开则放大并行子代理扇出(maxChildren/maxTotalAgents),但显式 opts 永远优先、
    // 绝不降现值。关 → scaleFanout 原引用返回(逐字节回退今日 DEFAULTS/opts merge)。
    try {
      this._config = require('./twentyXMode').scaleFanout(this._config, opts, process.env);
    } catch { /* twentyXMode 不可用 → 保持原 merge */ }
    this._executeFn = opts.executeFn || null;

    /** @type {Map<string, AgentSession>} */
    this._agents = new Map();

    /** @type {Map<string, NodeJS.Timeout>} agentId → timeout timer */
    this._timers = new Map();

    this._totalSpawned = 0;
  }

  /**
   * Spawn a root agent.
   *
   * @param {object} opts
   * @param {string} opts.name - Agent purpose
   * @param {string} opts.task - Task description
   * @param {string[]} [opts.scopes] - Allowed scopes
   * @param {object} [opts.context] - Initial context
   * @param {string[]} [opts.tools] - Available tools
   * @returns {AgentSession}
   */
  spawnRoot(opts = {}) {
    // Create root AgentContext for isolated state
    let agentContext = null;
    try {
      const { AgentContext } = require('./agentContext');
      agentContext = new AgentContext({
        role: opts.role || 'general',
        toolFilter: opts.toolFilter || null,
        config: opts.config,
      });
    } catch { /* agentContext not available */ }

    return this._spawn({
      parentId: null,
      depth: 0,
      name: opts.name || 'root',
      task: opts.task,
      scopes: opts.scopes || ['read', 'write', 'execute'],
      context: opts.context || {},
      tools: opts.tools || [],
      agentContext,
      executor: opts.executor,
      stepType: opts.stepType,
    });
  }

  /**
   * Fork a child agent from a parent.
   *
   * @param {string} parentId - Parent agent ID
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.task
   * @param {string[]} [opts.scopes] - Cannot exceed parent scopes
   * @param {object} [opts.context] - Additional context (merged with inherited)
   * @param {string[]} [opts.tools]
   * @returns {AgentSession}
   */
  fork(parentId, opts = {}) {
    const parent = this._agents.get(parentId);
    if (!parent) throw new Error(`Parent agent not found: ${parentId}`);
    if (parent.state !== AGENT_STATE.RUNNING) {
      throw new Error(`Cannot fork from agent in state: ${parent.state}`);
    }

    // Depth check
    if (parent.depth + 1 > this._config.maxDepth) {
      throw new Error(`Max depth ${this._config.maxDepth} exceeded`);
    }

    // Children count check
    const activeChildren = parent.childIds.filter(id => {
      const child = this._agents.get(id);
      return child && (child.state === AGENT_STATE.RUNNING || child.state === AGENT_STATE.WAITING);
    });
    if (activeChildren.length >= this._config.maxChildren) {
      throw new Error(`Max children ${this._config.maxChildren} exceeded`);
    }

    // Scope restriction — child cannot exceed parent
    const childScopes = (opts.scopes || parent.scopes).filter(s => parent.scopes.includes(s));

    // Context inheritance
    const childContext = this._config.inheritContext
      ? { ...parent.context, ...opts.context }
      : { ...opts.context };

    // Tool inheritance
    const childTools = this._config.inheritTools
      ? [...new Set([...(parent.tools || []), ...(opts.tools || [])])]
      : (opts.tools || []);

    // AgentContext inheritance: fork from parent if available
    let childAgentContext = null;
    if (parent.agentContext && typeof parent.agentContext.fork === 'function') {
      childAgentContext = parent.agentContext.fork({
        role: opts.role,
        toolFilter: opts.toolFilter,
        config: opts.config,
      });
    }

    const child = this._spawn({
      parentId,
      depth: parent.depth + 1,
      name: opts.name || `sub-${parent.name}`,
      task: opts.task,
      scopes: childScopes,
      context: childContext,
      tools: childTools,
      agentContext: childAgentContext,
      executor: opts.executor,
      stepType: opts.stepType,
    });

    parent.childIds.push(child.id);
    return child;
  }

  /**
   * Execute an agent's task.
   *
   * @param {string} agentId
   * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
   */
  async execute(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (agent.state !== AGENT_STATE.CREATED) {
      throw new Error(`Agent already started: ${agent.state}`);
    }

    agent.state = AGENT_STATE.RUNNING;
    agent.startedTs = Date.now();
    this.emit('agent:started', { agentId, name: agent.name, depth: agent.depth });

    // Set timeout
    const timer = setTimeout(() => {
      this._timeout(agentId);
    }, this._config.agentTimeoutMs);
    if (timer.unref) timer.unref();
    this._timers.set(agentId, timer);

    try {
      let result;
      if (this._executeFn) {
        result = await this._executeFn(agent);
      } else {
        result = { message: 'No execute function provided' };
      }

      this._clearTimer(agentId);
      agent.state = AGENT_STATE.COMPLETED;
      agent.result = result;
      agent.completedAt = Date.now();

      this.emit('agent:completed', { agentId, name: agent.name, result });
      return { success: true, result };

    } catch (err) {
      this._clearTimer(agentId);
      agent.state = AGENT_STATE.FAILED;
      agent.error = err.message;
      agent.completedAt = Date.now();

      this.emit('agent:failed', { agentId, name: agent.name, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * Execute an agent and all its children recursively.
   *
   * @param {string} agentId
   * @returns {Promise<{ results: Map<string, any> }>}
   */
  async executeTree(agentId) {
    const results = new Map();

    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    // Execute this agent
    const result = await this.execute(agentId);
    results.set(agentId, result);

    // Execute children concurrently
    if (agent.childIds.length > 0) {
      const childResults = await Promise.allSettled(
        agent.childIds.map(id => this.executeTree(id))
      );
      for (const cr of childResults) {
        if (cr.status === 'fulfilled') {
          for (const [id, r] of cr.value.results) {
            results.set(id, r);
          }
        }
      }
    }

    return { results };
  }

  /**
   * Execute tasks with dependency-aware ordering.
   * Tasks with dependencies wait for their prerequisites to complete.
   * Same-layer independent tasks run in parallel.
   *
   * Learned from CC's partitionToolCalls (concurrency-safe batching)
   * and OC's task-queue pattern with session isolation.
   *
   * @param {Array<{id: string, agentId: string, dependencies?: string[]}>} tasks
   * @returns {Promise<Map<string, {status: string, result: any}>>}
   */
  async executeDependencyAware(tasks) {
    if (!tasks || tasks.length === 0) return new Map();

    // Build adjacency: taskId → set of taskIds it depends on
    const deps = new Map();
    const taskById = new Map();
    for (const t of tasks) {
      deps.set(t.id, new Set(t.dependencies || []));
      taskById.set(t.id, t);
    }

    // Topological sort into layers
    const layers = [];
    const completed = new Set();
    const remaining = new Set(deps.keys());

    while (remaining.size > 0) {
      // Find tasks whose dependencies are all completed
      const ready = [];
      for (const id of remaining) {
        const taskDeps = deps.get(id);
        const allMet = [...taskDeps].every(d => completed.has(d));
        if (allMet) ready.push(id);
      }

      if (ready.length === 0) {
        // Circular dependency or missing dependency — break cycle by running all remaining
        for (const id of remaining) ready.push(id);
        remaining.clear();
      }

      layers.push(ready);
      for (const id of ready) {
        remaining.delete(id);
      }
      // Mark as completed (will be updated after actual execution)
      for (const id of ready) completed.add(id);
    }

    // Execute layer by layer
    const results = new Map();
    for (const layer of layers) {
      const layerPromises = layer.map(async (taskId) => {
        const task = taskById.get(taskId);
        if (!task || !task.agentId) {
          return { taskId, status: 'skipped', result: null };
        }

        // Check if any dependency failed → skip this task
        for (const depId of (task.dependencies || [])) {
          const depResult = results.get(depId);
          if (depResult && depResult.status === 'failed') {
            return { taskId, status: 'skipped', result: { reason: `dependency ${depId} failed` } };
          }
        }

        // Inject predecessor results into agent context
        const predecessorContext = [];
        for (const depId of (task.dependencies || [])) {
          const depResult = results.get(depId);
          if (depResult?.result) {
            let depText;
            if (typeof depResult.result === 'string') {
              depText = depResult.result;
            } else if (depResult.result && typeof depResult.result === 'object') {
              depText = typeof depResult.result.content === 'string'
                ? depResult.result.content
                : JSON.stringify(depResult.result);
            } else {
              depText = String(depResult.result ?? '');
            }
            const MAX_DEP = 4000;
            if (depText.length > MAX_DEP) {
              const cut = depText.lastIndexOf('\n', MAX_DEP);
              depText = depText.slice(0, cut > 0 ? cut : MAX_DEP)
                + `\n... [truncated ${depText.length - MAX_DEP} chars]`;
            }
            predecessorContext.push(`[Predecessor ${depId} result]: ${depText}`);
          }
        }
        if (predecessorContext.length > 0) {
          const agent = this._agents.get(task.agentId);
          if (agent) {
            const existing = typeof agent.context === 'string' ? agent.context : '';
            agent.context = existing + '\n' + predecessorContext.join('\n');
          }
        }

        try {
          const result = await this.execute(task.agentId);
          return { taskId, status: 'completed', result };
        } catch (err) {
          return { taskId, status: 'failed', result: { error: err.message } };
        }
      });

      const layerResults = await Promise.allSettled(layerPromises);
      for (const settled of layerResults) {
        if (settled.status === 'fulfilled') {
          const { taskId, status, result } = settled.value;
          results.set(taskId, { status, result });
        } else {
          // Promise rejection (shouldn't happen with try/catch above)
        }
      }
    }

    return results;
  }

  /**
   * Kill an agent and optionally its descendants.
   *
   * @param {string} agentId
   * @param {boolean} [cascade=true] - Also kill children
   */
  kill(agentId, cascade = true) {
    const agent = this._agents.get(agentId);
    if (!agent) return;

    this._clearTimer(agentId);

    if (agent.state === AGENT_STATE.RUNNING || agent.state === AGENT_STATE.WAITING) {
      agent.state = AGENT_STATE.KILLED;
      agent.completedAt = Date.now();
      this.emit('agent:killed', { agentId, name: agent.name });
    }

    if (cascade) {
      for (const childId of agent.childIds) {
        this.kill(childId, true);
      }
    }
  }

  /**
   * Get an agent's state.
   */
  getAgent(agentId) {
    const agent = this._agents.get(agentId);
    return agent ? { ...agent } : null;
  }

  /**
   * Get the agent tree starting from a root.
   */
  getTree(rootId) {
    const agent = this._agents.get(rootId);
    if (!agent) return null;

    return {
      ...agent,
      children: agent.childIds.map(id => this.getTree(id)).filter(Boolean),
    };
  }

  /**
   * Aggregate results from all descendants of an agent.
   */
  aggregateResults(rootId) {
    const results = [];
    const _collect = (agentId) => {
      const agent = this._agents.get(agentId);
      if (!agent) return;
      if (agent.result) {
        results.push({ agentId, name: agent.name, depth: agent.depth, result: agent.result });
      }
      for (const childId of agent.childIds) {
        _collect(childId);
      }
    };
    _collect(rootId);
    return results;
  }

  /**
   * List all agents with optional filter.
   */
  listAgents(filter) {
    const agents = [];
    for (const agent of this._agents.values()) {
      if (filter?.state && agent.state !== filter.state) continue;
      if (filter?.depth !== undefined && agent.depth !== filter.depth) continue;
      agents.push({ ...agent });
    }
    return agents;
  }

  /**
   * Get orchestrator stats.
   */
  getStats() {
    const byState = {};
    let maxDepth = 0;
    for (const agent of this._agents.values()) {
      byState[agent.state] = (byState[agent.state] || 0) + 1;
      if (agent.depth > maxDepth) maxDepth = agent.depth;
    }

    return {
      totalSpawned: this._totalSpawned,
      activeAgents: this._agents.size,
      byState,
      maxDepthReached: maxDepth,
      limits: {
        maxDepth: this._config.maxDepth,
        maxChildren: this._config.maxChildren,
        maxTotalAgents: this._config.maxTotalAgents,
      },
    };
  }

  /**
   * Clean up completed/failed/killed agents.
   */
  cleanup() {
    const terminal = new Set([AGENT_STATE.COMPLETED, AGENT_STATE.FAILED, AGENT_STATE.KILLED, AGENT_STATE.TIMED_OUT]);
    for (const [id, agent] of this._agents) {
      if (terminal.has(agent.state)) {
        this._agents.delete(id);
        this._clearTimer(id);
      }
    }
  }

  // ── Internal ──

  /**
   * Roll up an orchestration tree rooted at `rootId` into a summary (B1).
   * Walks every descendant subtask (the root itself is excluded — it is the
   * orchestration node, not a worked subtask) and aggregates duration,
   * executor, and step-type counts.
   *
   * @param {string} rootId
   * @returns {{
   *   subtaskCount: number, successCount: number, failCount: number,
   *   totalDurationMs: number,
   *   byStepType: Object<string, number>, byExecutor: Object<string, number>,
   *   subtasks: Array<{ id, name, executor, stepType, durationMs, status }>
   * }}
   */
  summarize(rootId) {
    const byStepType = {};
    const byExecutor = {};
    const subtasks = [];
    let successCount = 0;
    let failCount = 0;
    let totalDurationMs = 0;

    const visit = (id, isRoot) => {
      const agent = this._agents.get(id);
      if (!agent) return;
      if (!isRoot) {
        const durationMs = (agent.completedAt && agent.startedTs)
          ? Math.max(0, agent.completedAt - agent.startedTs)
          : 0;
        const status = agent.state;
        const executor = agent.executor || 'unknown';
        const stepType = agent.stepType || 'flexible';

        byStepType[stepType] = (byStepType[stepType] || 0) + 1;
        byExecutor[executor] = (byExecutor[executor] || 0) + 1;
        totalDurationMs += durationMs;
        if (status === AGENT_STATE.COMPLETED) successCount++;
        else if (status === AGENT_STATE.FAILED || status === AGENT_STATE.TIMED_OUT) failCount++;

        subtasks.push({ id, name: agent.name, executor, stepType, durationMs, status });
      }
      for (const childId of agent.childIds) visit(childId, false);
    };

    visit(rootId, true);

    return {
      subtaskCount: subtasks.length,
      successCount,
      failCount,
      totalDurationMs,
      byStepType,
      byExecutor,
      subtasks,
    };
  }

  _spawn(opts) {
    if (this._totalSpawned >= this._config.maxTotalAgents) {
      throw new Error(`Total agent limit ${this._config.maxTotalAgents} reached`);
    }

    const id = crypto.randomBytes(8).toString('hex');
    const agent = {
      id,
      parentId: opts.parentId,
      depth: opts.depth,
      name: opts.name,
      task: opts.task,
      state: AGENT_STATE.CREATED,
      scopes: opts.scopes,
      context: opts.context,
      tools: opts.tools || [],
      agentContext: opts.agentContext || null,
      result: null,
      error: null,
      createdAt: Date.now(),
      startedTs: null,
      completedAt: null,
      // B1 — rollup attribution. executor = which adapter/role ran the subtask;
      // stepType = hardened | flexible | human-gate (set by the caller via opts).
      executor: opts.executor
        || (opts.context && (opts.context.route || opts.context.role || opts.context.adapter))
        || 'unknown',
      stepType: opts.stepType || 'flexible',
      childIds: [],
    };

    this._agents.set(id, agent);
    this._totalSpawned++;

    this.emit('agent:spawned', { agentId: id, name: agent.name, depth: agent.depth, parentId: agent.parentId });
    return agent;
  }

  _timeout(agentId) {
    const agent = this._agents.get(agentId);
    if (!agent) return;
    if (agent.state === AGENT_STATE.RUNNING || agent.state === AGENT_STATE.WAITING) {
      agent.state = AGENT_STATE.TIMED_OUT;
      agent.error = 'Agent timed out';
      agent.completedAt = Date.now();
      this.emit('agent:timeout', { agentId, name: agent.name });

      // Kill children too
      for (const childId of agent.childIds) {
        this.kill(childId, true);
      }
    }
  }

  _clearTimer(agentId) {
    const timer = this._timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this._timers.delete(agentId);
    }
  }
}

module.exports = {
  AGENT_STATE,
  DEFAULTS,
  SubAgentOrchestrator,
};
