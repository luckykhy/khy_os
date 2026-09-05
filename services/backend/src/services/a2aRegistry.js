'use strict';

/**
 * A2A Registry — Agent service discovery and registration.
 *
 * Provides:
 * - Agent registration and deregistration
 * - Service discovery by capability
 * - Health checking and heartbeat monitoring
 * - Load balancing across agent instances
 */

const EventEmitter = require('events');
const crypto = require('crypto');

// ── Agent Status ──────────────────────────────────────────────────────────

const AGENT_STATUS = Object.freeze({
  REGISTERING: 'registering',
  ACTIVE: 'active',
  BUSY: 'busy',
  DRAINING: 'draining',
  UNHEALTHY: 'unhealthy',
  OFFLINE: 'offline',
});

// ── Agent Record ──────────────────────────────────────────────────────────

/**
 * @typedef {object} AgentRecord
 * @property {string} id - Unique agent ID
 * @property {string} name - Agent name
 * @property {string} type - Agent type (e.g., 'fundamental', 'technical')
 * @property {string[]} capabilities - List of capabilities
 * @property {string} endpoint - Connection endpoint
 * @property {string} status - Current status
 * @property {number} registeredAt - Registration timestamp
 * @property {number} lastHeartbeat - Last heartbeat timestamp
 * @property {object} metadata - Additional metadata
 * @property {number} activeTasks - Number of active tasks
 * @property {number} maxTasks - Maximum concurrent tasks
 */

// ── A2A Registry Class ────────────────────────────────────────────────────

class A2ARegistry extends EventEmitter {
  constructor(options = {}) {
    super();
    this._agents = new Map(); // agentId → AgentRecord
    this._capabilities = new Map(); // capability → Set<agentId>
    this._heartbeatInterval = options.heartbeatInterval || 30000; // 30s
    this._heartbeatTimeout = options.heartbeatTimeout || 90000; // 90s
    this._maxTasksPerAgent = options.maxTasksPerAgent || 5;
    
    // Start health check loop
    this._healthCheckTimer = setInterval(() => this._checkHealth(), this._heartbeatInterval);
    if (this._healthCheckTimer.unref) {
      this._healthCheckTimer.unref();
    }
  }

  // ── Registration ──────────────────────────────────────────────────────

  /**
   * Register an agent.
   * @param {object} agentInfo
   * @returns {AgentRecord} Registered agent record
   */
  register(agentInfo) {
    if (!agentInfo.name || !agentInfo.type) {
      throw new Error('Agent name and type are required');
    }

    const id = agentInfo.id || `agent-${crypto.randomBytes(8).toString('hex')}`;
    
    // Check if already registered
    if (this._agents.has(id)) {
      throw new Error(`Agent ${id} is already registered`);
    }

    const record = {
      id,
      name: agentInfo.name,
      type: agentInfo.type,
      capabilities: agentInfo.capabilities || [],
      endpoint: agentInfo.endpoint || null,
      status: AGENT_STATUS.REGISTERING,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      metadata: agentInfo.metadata || {},
      activeTasks: 0,
      maxTasks: agentInfo.maxTasks || this._maxTasksPerAgent,
    };

    this._agents.set(id, record);

    // Index capabilities
    for (const capability of record.capabilities) {
      if (!this._capabilities.has(capability)) {
        this._capabilities.set(capability, new Set());
      }
      this._capabilities.get(capability).add(id);
    }

    // Mark as active
    record.status = AGENT_STATUS.ACTIVE;

    this.emit('agent:registered', record);
    return record;
  }

  /**
   * Deregister an agent.
   * @param {string} agentId
   * @returns {boolean} True if deregistered
   */
  deregister(agentId) {
    const record = this._agents.get(agentId);
    if (!record) {
      return false;
    }

    // Remove from capability index
    for (const capability of record.capabilities) {
      const agents = this._capabilities.get(capability);
      if (agents) {
        agents.delete(agentId);
        if (agents.size === 0) {
          this._capabilities.delete(capability);
        }
      }
    }

    this._agents.delete(agentId);
    this.emit('agent:deregistered', record);
    return true;
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  /**
   * Get an agent by ID.
   * @param {string} agentId
   * @returns {AgentRecord|undefined}
   */
  getAgent(agentId) {
    return this._agents.get(agentId);
  }

  /**
   * Get all registered agents.
   * @returns {AgentRecord[]}
   */
  getAllAgents() {
    return Array.from(this._agents.values());
  }

  /**
   * Get agents by type.
   * @param {string} type
   * @returns {AgentRecord[]}
   */
  getAgentsByType(type) {
    return this.getAllAgents().filter(a => a.type === type);
  }

  /**
   * Get agents by capability.
   * @param {string} capability
   * @returns {AgentRecord[]}
   */
  getAgentsByCapability(capability) {
    const agentIds = this._capabilities.get(capability);
    if (!agentIds) {
      return [];
    }
    return Array.from(agentIds)
      .map(id => this._agents.get(id))
      .filter(a => a && a.status === AGENT_STATUS.ACTIVE);
  }

  /**
   * Find the best agent for a capability (load-balanced).
   * @param {string} capability
   * @returns {AgentRecord|null}
   */
  findBestAgent(capability) {
    const agents = this.getAgentsByCapability(capability);
    if (agents.length === 0) {
      return null;
    }

    // Filter agents that can accept more tasks
    const available = agents.filter(a => a.activeTasks < a.maxTasks);
    if (available.length === 0) {
      return null;
    }

    // Select agent with fewest active tasks (simple load balancing)
    return available.reduce((best, current) => {
      return current.activeTasks < best.activeTasks ? current : best;
    });
  }

  // ── Heartbeat & Health ────────────────────────────────────────────────

  /**
   * Record a heartbeat from an agent.
   * @param {string} agentId
   * @returns {boolean} True if heartbeat recorded
   */
  heartbeat(agentId) {
    const record = this._agents.get(agentId);
    if (!record) {
      return false;
    }

    record.lastHeartbeat = Date.now();
    
    // Update status if it was unhealthy
    if (record.status === AGENT_STATUS.UNHEALTHY || record.status === AGENT_STATUS.OFFLINE) {
      record.status = AGENT_STATUS.ACTIVE;
      this.emit('agent:recovered', record);
    }

    return true;
  }

  /**
   * Check health of all agents.
   * @private
   */
  _checkHealth() {
    const now = Date.now();
    
    for (const record of this._agents.values()) {
      const elapsed = now - record.lastHeartbeat;
      
      if (elapsed > this._heartbeatTimeout) {
        // Agent is unhealthy
        if (record.status !== AGENT_STATUS.UNHEALTHY) {
          record.status = AGENT_STATUS.UNHEALTHY;
          this.emit('agent:unhealthy', record);
        }
      } else if (elapsed > this._heartbeatTimeout / 2) {
        // Agent is draining (slow to respond)
        if (record.status === AGENT_STATUS.ACTIVE) {
          record.status = AGENT_STATUS.DRAINING;
          this.emit('agent:draining', record);
        }
      }
    }
  }

  // ── Task Tracking ─────────────────────────────────────────────────────

  /**
   * Increment active task count for an agent.
   * @param {string} agentId
   * @returns {boolean} True if incremented
   */
  incrementTasks(agentId) {
    const record = this._agents.get(agentId);
    if (!record) {
      return false;
    }
    record.activeTasks++;
    
    if (record.activeTasks >= record.maxTasks) {
      record.status = AGENT_STATUS.BUSY;
    }
    
    return true;
  }

  /**
   * Decrement active task count for an agent.
   * @param {string} agentId
   * @returns {boolean} True if decremented
   */
  decrementTasks(agentId) {
    const record = this._agents.get(agentId);
    if (!record) {
      return false;
    }
    
    record.activeTasks = Math.max(0, record.activeTasks - 1);
    
    if (record.activeTasks < record.maxTasks && record.status === AGENT_STATUS.BUSY) {
      record.status = AGENT_STATUS.ACTIVE;
    }
    
    return true;
  }

  // ── Status Management ─────────────────────────────────────────────────

  /**
   * Update agent status.
   * @param {string} agentId
   * @param {string} status
   * @returns {boolean} True if updated
   */
  updateStatus(agentId, status) {
    const record = this._agents.get(agentId);
    if (!record) {
      return false;
    }
    
    const oldStatus = record.status;
    record.status = status;
    
    if (oldStatus !== status) {
      this.emit('agent:statusChanged', { record, oldStatus, newStatus: status });
    }
    
    return true;
  }

  // ── Statistics ────────────────────────────────────────────────────────

  /**
   * Get registry statistics.
   * @returns {object}
   */
  getStatistics() {
    const agents = this.getAllAgents();
    const statusCounts = {};
    const capabilityCounts = {};
    
    for (const agent of agents) {
      statusCounts[agent.status] = (statusCounts[agent.status] || 0) + 1;
      for (const cap of agent.capabilities) {
        capabilityCounts[cap] = (capabilityCounts[cap] || 0) + 1;
      }
    }
    
    return {
      totalAgents: agents.length,
      statusCounts,
      capabilityCounts,
      totalCapabilities: this._capabilities.size,
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Stop the registry and clean up resources.
   */
  destroy() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    this._agents.clear();
    this._capabilities.clear();
    this.removeAllListeners();
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────

let _instance = null;

function getRegistry(options) {
  if (!_instance) {
    _instance = new A2ARegistry(options);
  }
  return _instance;
}

function resetRegistry() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  A2ARegistry,
  AGENT_STATUS,
  getRegistry,
  resetRegistry,
};