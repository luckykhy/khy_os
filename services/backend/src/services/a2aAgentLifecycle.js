'use strict';

/**
 * A2A Agent Lifecycle — Agent lifecycle management.
 *
 * Provides:
 * - Agent spawning and termination
 * - Context inheritance
 * - Depth-limited recursion
 * - Workspace materialization
 * - Result aggregation
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── Agent States ──────────────────────────────────────────────────────────

const AGENT_LIFECYCLE_STATE = Object.freeze({
  PENDING: 'pending',
  SPAWNING: 'spawning',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETING: 'completing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  KILLING: 'killing',
  KILLED: 'killed',
  TIMED_OUT: 'timed_out',
});

// ── Default Configuration ─────────────────────────────────────────────────

const DEFAULTS = {
  maxDepth: 3,
  maxChildren: 10,
  agentTimeoutMs: 300_000, // 5 minutes
  maxTotalAgents: 50,
  workspaceBaseDir: path.resolve(process.cwd(), '.khy', 'agent-workspaces'),
};

// ── Agent Session ─────────────────────────────────────────────────────────

/**
 * @typedef {object} AgentSession
 * @property {string} id - Unique agent ID
 * @property {string} [parentId] - Parent agent ID
 * @property {number} depth - Nesting depth
 * @property {string} name - Agent name
 * @property {string} type - Agent type
 * @property {string} state - Current state
 * @property {string[]} capabilities - Agent capabilities
 * @property {string[]} scopes - Permitted scopes
 * @property {object} context - Working context
 * @property {object} [result] - Agent output
 * @property {string} [error] - Error message
 * @property {number} createdAt - Creation timestamp
 * @property {number} [completedAt] - Completion timestamp
 * @property {string[]} childIds - Child agent IDs
 * @property {string} workspaceDir - Workspace directory
 */

// ── A2A Agent Lifecycle Manager ───────────────────────────────────────────

class A2AAgentLifecycle extends EventEmitter {
  constructor(options = {}) {
    super();
    this._options = { ...DEFAULTS, ...options };
    this._agents = new Map(); // agentId → AgentSession
    this._rootAgents = new Set(); // Root agent IDs
    this._depthMap = new Map(); // depth → Set<agentId>
    
    // Ensure workspace directory exists
    if (!fs.existsSync(this._options.workspaceBaseDir)) {
      fs.mkdirSync(this._options.workspaceBaseDir, { recursive: true });
    }
  }

  // ── Spawning ──────────────────────────────────────────────────────────

  /**
   * Spawn a new agent.
   * @param {object} config
   * @returns {AgentSession} Created agent session
   */
  spawn(config = {}) {
    // Check total agent limit
    if (this._agents.size >= this._options.maxTotalAgents) {
      throw new Error(`Maximum agent limit reached (${this._options.maxTotalAgents})`);
    }

    // Check depth limit
    const parentDepth = config.parentId ? this._agents.get(config.parentId)?.depth || 0 : 0;
    const depth = parentDepth + 1;
    if (depth > this._options.maxDepth) {
      throw new Error(`Maximum depth exceeded (${this._options.maxDepth})`);
    }

    // Check children limit
    if (config.parentId) {
      const parent = this._agents.get(config.parentId);
      if (parent && parent.childIds.length >= this._options.maxChildren) {
        throw new Error(`Maximum children limit reached for parent ${config.parentId}`);
      }
    }

    const id = config.id || `agent-${crypto.randomBytes(8).toString('hex')}`;
    
    // Create workspace directory
    const workspaceDir = path.join(this._options.workspaceBaseDir, id);
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }

    const session = {
      id,
      parentId: config.parentId || null,
      depth,
      name: config.name || id,
      type: config.type || 'generic',
      state: AGENT_LIFECYCLE_STATE.PENDING,
      capabilities: config.capabilities || [],
      scopes: config.scopes || [],
      context: config.context || {},
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      childIds: [],
      workspaceDir,
    };

    this._agents.set(id, session);

    // Track root agents
    if (!config.parentId) {
      this._rootAgents.add(id);
    }

    // Track depth
    if (!this._depthMap.has(depth)) {
      this._depthMap.set(depth, new Set());
    }
    this._depthMap.get(depth).add(id);

    // Register as child of parent
    if (config.parentId) {
      const parent = this._agents.get(config.parentId);
      if (parent) {
        parent.childIds.push(id);
      }
    }

    // Transition to spawning
    session.state = AGENT_LIFECYCLE_STATE.SPAWNING;
    this.emit('agent:spawning', session);

    // Transition to running
    session.state = AGENT_LIFECYCLE_STATE.RUNNING;
    this.emit('agent:spawned', session);

    return session;
  }

  // ── Termination ───────────────────────────────────────────────────────

  /**
   * Kill an agent and optionally its children.
   * @param {string} agentId
   * @param {object} [options]
   * @param {boolean} [options.killChildren=true]
   * @param {string} [options.reason='manual']
   * @returns {boolean} True if killed
   */
  kill(agentId, options = {}) {
    const { killChildren = true, reason = 'manual' } = options;
    
    const session = this._agents.get(agentId);
    if (!session) {
      return false;
    }

    // Kill children first
    if (killChildren && session.childIds.length > 0) {
      for (const childId of [...session.childIds]) {
        this.kill(childId, { killChildren: true, reason: `parent killed: ${reason}` });
      }
    }

    session.state = AGENT_LIFECYCLE_STATE.KILLING;
    this.emit('agent:killing', { session, reason });

    session.state = AGENT_LIFECYCLE_STATE.KILLED;
    session.completedAt = Date.now();
    
    this.emit('agent:killed', { session, reason });

    // Clean up workspace
    this._cleanupWorkspace(session);

    return true;
  }

  /**
   * Complete an agent's execution.
   * @param {string} agentId
   * @param {object} result
   * @returns {boolean} True if completed
   */
  complete(agentId, result) {
    const session = this._agents.get(agentId);
    if (!session) {
      return false;
    }

    session.state = AGENT_LIFECYCLE_STATE.COMPLETING;
    session.result = result;
    
    this.emit('agent:completing', session);

    session.state = AGENT_LIFECYCLE_STATE.COMPLETED;
    session.completedAt = Date.now();
    
    this.emit('agent:completed', session);

    // Notify parent if exists
    if (session.parentId) {
      const parent = this._agents.get(session.parentId);
      if (parent) {
        this.emit('agent:childCompleted', { parent, child: session });
      }
    }

    return true;
  }

  /**
   * Mark an agent as failed.
   * @param {string} agentId
   * @param {string} error
   * @returns {boolean} True if marked
   */
  fail(agentId, error) {
    const session = this._agents.get(agentId);
    if (!session) {
      return false;
    }

    session.state = AGENT_LIFECYCLE_STATE.FAILED;
    session.error = error;
    session.completedAt = Date.now();
    
    this.emit('agent:failed', session);

    // Notify parent if exists
    if (session.parentId) {
      const parent = this._agents.get(session.parentId);
      if (parent) {
        this.emit('agent:childFailed', { parent, child: session });
      }
    }

    return true;
  }

  // ── State Management ──────────────────────────────────────────────────

  /**
   * Get an agent session.
   * @param {string} agentId
   * @returns {AgentSession|undefined}
   */
  getAgent(agentId) {
    return this._agents.get(agentId);
  }

  /**
   * Get all agent sessions.
   * @returns {AgentSession[]}
   */
  getAllAgents() {
    return Array.from(this._agents.values());
  }

  /**
   * Get active agents.
   * @returns {AgentSession[]}
   */
  getActiveAgents() {
    return this.getAllAgents().filter(a => 
      a.state === AGENT_LIFECYCLE_STATE.RUNNING || 
      a.state === AGENT_LIFECYCLE_STATE.WAITING
    );
  }

  /**
   * Get children of an agent.
   * @param {string} agentId
   * @returns {AgentSession[]}
   */
  getChildren(agentId) {
    const session = this._agents.get(agentId);
    if (!session) {
      return [];
    }
    return session.childIds.map(id => this._agents.get(id)).filter(Boolean);
  }

  /**
   * Get agent tree (recursive).
   * @param {string} agentId
   * @returns {object}
   */
  getAgentTree(agentId) {
    const session = this._agents.get(agentId);
    if (!session) {
      return null;
    }

    return {
      ...session,
      children: session.childIds.map(id => this.getAgentTree(id)).filter(Boolean),
    };
  }

  // ── Context Inheritance ───────────────────────────────────────────────

  /**
   * Create child context from parent context.
   * @param {object} parentContext
   * @param {object} overrides
   * @returns {object}
   */
  inheritContext(parentContext, overrides = {}) {
    return {
      ...parentContext,
      ...overrides,
      parentId: parentContext.id,
      depth: (parentContext.depth || 0) + 1,
    };
  }

  // ── Workspace Management ──────────────────────────────────────────────

  /**
   * Write to agent workspace.
   * @param {string} agentId
   * @param {string} filename
   * @param {string|Buffer} content
   * @returns {string} Full path to written file
   */
  writeToWorkspace(agentId, filename, content) {
    const session = this._agents.get(agentId);
    if (!session) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const filepath = path.join(session.workspaceDir, filename);
    
    // Security check: ensure file is within workspace
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(session.workspaceDir)) {
      throw new Error('Path traversal detected');
    }

    fs.writeFileSync(filepath, content);
    return filepath;
  }

  /**
   * Read from agent workspace.
   * @param {string} agentId
   * @param {string} filename
   * @returns {Buffer}
   */
  readFromWorkspace(agentId, filename) {
    const session = this._agents.get(agentId);
    if (!session) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const filepath = path.join(session.workspaceDir, filename);
    
    // Security check: ensure file is within workspace
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(session.workspaceDir)) {
      throw new Error('Path traversal detected');
    }

    return fs.readFileSync(filepath);
  }

  /**
   * Clean up agent workspace.
   * @param {object} session
   * @private
   */
  _cleanupWorkspace(session) {
    try {
      if (fs.existsSync(session.workspaceDir)) {
        fs.rmSync(session.workspaceDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  // ── Result Aggregation ────────────────────────────────────────────────

  /**
   * Aggregate results from multiple agents.
   * @param {string[]} agentIds
   * @returns {object} Aggregated results
   */
  aggregateResults(agentIds) {
    const results = {
      successful: [],
      failed: [],
      total: agentIds.length,
      completed: 0,
      errors: 0,
    };

    for (const agentId of agentIds) {
      const session = this._agents.get(agentId);
      if (!session) {
        continue;
      }

      if (session.state === AGENT_LIFECYCLE_STATE.COMPLETED) {
        results.successful.push({
          agentId,
          name: session.name,
          result: session.result,
        });
        results.completed++;
      } else if (session.state === AGENT_LIFECYCLE_STATE.FAILED) {
        results.failed.push({
          agentId,
          name: session.name,
          error: session.error,
        });
        results.errors++;
      }
    }

    return results;
  }

  // ── Statistics ────────────────────────────────────────────────────────

  /**
   * Get lifecycle statistics.
   * @returns {object}
   */
  getStatistics() {
    const agents = this.getAllAgents();
    const stateCounts = {};
    let totalDepth = 0;

    for (const agent of agents) {
      stateCounts[agent.state] = (stateCounts[agent.state] || 0) + 1;
      totalDepth += agent.depth;
    }

    return {
      totalAgents: agents.length,
      rootAgents: this._rootAgents.size,
      activeAgents: this.getActiveAgents().length,
      stateCounts,
      maxDepth: Math.max(...Array.from(this._depthMap.keys()), 0),
      avgDepth: agents.length > 0 ? totalDepth / agents.length : 0,
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Stop the lifecycle manager and clean up resources.
   */
  destroy() {
    // Kill all active agents
    for (const agentId of [...this._rootAgents]) {
      this.kill(agentId, { reason: 'manager destroyed' });
    }

    this._agents.clear();
    this._rootAgents.clear();
    this._depthMap.clear();
    this.removeAllListeners();
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────

let _instance = null;

function getLifecycle(options) {
  if (!_instance) {
    _instance = new A2AAgentLifecycle(options);
  }
  return _instance;
}

function resetLifecycle() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  A2AAgentLifecycle,
  AGENT_LIFECYCLE_STATE,
  getLifecycle,
  resetLifecycle,
};