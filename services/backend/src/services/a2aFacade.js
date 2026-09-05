'use strict';

/**
 * A2A Facade — Unified facade for Agent-to-Agent communication.
 *
 * Integrates:
 * - ACP Transport Layer (acpTransport.js)
 * - Agent Registry (a2aRegistry.js)
 * - Agent Lifecycle (a2aAgentLifecycle.js)
 * - Message Router (a2aMessageRouter.js)
 *
 * Provides a single entry point for all A2A operations.
 */

const { ACP_METHODS, ACPTransport, createRequest, createNotification } = require('./acpTransport');
const { A2ARegistry, AGENT_STATUS, getRegistry } = require('./a2aRegistry');
const { A2AAgentLifecycle, AGENT_LIFECYCLE_STATE, getLifecycle } = require('./a2aAgentLifecycle');
const { A2AMessageRouter, MESSAGE_PRIORITY, MESSAGE_STATUS, getRouter } = require('./a2aMessageRouter');

// ── A2A Facade ────────────────────────────────────────────────────────────

class A2AFacade {
  constructor(options = {}) {
    this.registry = getRegistry(options.registry);
    this.lifecycle = getLifecycle(options.lifecycle);
    this.router = getRouter(options.router);
    
    // Wire up event handlers
    this._setupEventHandlers();
  }

  // ── Agent Management ─────────────────────────────────────────────────

  /**
   * Register an agent with the A2A network.
   * @param {object} agentInfo
   * @returns {object} Registered agent record
   */
  registerAgent(agentInfo) {
    return this.registry.register(agentInfo);
  }

  /**
   * Deregister an agent.
   * @param {string} agentId
   * @returns {boolean}
   */
  deregisterAgent(agentId) {
    return this.registry.deregister(agentId);
  }

  /**
   * Spawn a new agent session.
   * @param {object} config
   * @returns {object} Agent session
   */
  spawnAgent(config = {}) {
    const session = this.lifecycle.spawn(config);
    
    // Register with registry if capabilities provided
    if (config.capabilities && config.capabilities.length > 0) {
      try {
        this.registry.register({
          id: session.id,
          name: session.name,
          type: session.type,
          capabilities: session.capabilities,
        });
      } catch (error) {
        // Registration failed, but session still created
      }
    }
    
    return session;
  }

  /**
   * Kill an agent.
   * @param {string} agentId
   * @param {object} [options]
   * @returns {boolean}
   */
  killAgent(agentId, options = {}) {
    return this.lifecycle.kill(agentId, options);
  }

  /**
   * Get agent information.
   * @param {string} agentId
   * @returns {object|null}
   */
  getAgent(agentId) {
    const record = this.registry.getAgent(agentId);
    const session = this.lifecycle.getAgent(agentId);
    
    if (!record && !session) {
      return null;
    }
    
    return {
      ...record,
      ...session,
      registry: record,
      lifecycle: session,
    };
  }

  /**
   * Get all agents.
   * @returns {object[]}
   */
  getAllAgents() {
    const registryAgents = this.registry.getAllAgents();
    const lifecycleAgents = this.lifecycle.getAllAgents();
    
    // Merge by ID
    const agentMap = new Map();
    
    for (const agent of registryAgents) {
      agentMap.set(agent.id, { ...agent, source: 'registry' });
    }
    
    for (const agent of lifecycleAgents) {
      const existing = agentMap.get(agent.id);
      if (existing) {
        Object.assign(existing, agent);
        existing.sources = ['registry', 'lifecycle'];
      } else {
        agentMap.set(agent.id, { ...agent, source: 'lifecycle' });
      }
    }
    
    return Array.from(agentMap.values());
  }

  // ── Communication ─────────────────────────────────────────────────────

  /**
   * Send a message to an agent.
   * @param {string} targetAgentId
   * @param {object} message
   * @returns {Promise<object>}
   */
  async sendMessage(targetAgentId, message) {
    return this.router.routeTo(targetAgentId, message);
  }

  /**
   * Broadcast a message to all agents with a capability.
   * @param {string} capability
   * @param {object} message
   * @returns {Promise<object[]>}
   */
  async broadcast(capability, message) {
    return this.router.broadcast(capability, message);
  }

  /**
   * Submit a task to an agent.
   * @param {string} agentId
   * @param {object} task
   * @returns {Promise<object>}
   */
  async submitTask(agentId, task) {
    // Increment task count
    this.registry.incrementTasks(agentId);
    
    try {
      const result = await this.router.routeTo(agentId, {
        type: 'task.submit',
        payload: task,
      });
      
      // Decrement task count
      this.registry.decrementTasks(agentId);
      
      return result;
    } catch (error) {
      this.registry.decrementTasks(agentId);
      throw error;
    }
  }

  /**
   * Request agent status.
   * @param {string} agentId
   * @returns {Promise<object>}
   */
  async getAgentStatus(agentId) {
    return this.router.routeTo(agentId, {
      type: 'agent.status',
      payload: { agentId },
    });
  }

  // ── Discovery ────────────────────────────────────────────────────────

  /**
   * Find agents by capability.
   * @param {string} capability
   * @returns {object[]}
   */
  findAgentsByCapability(capability) {
    return this.registry.getAgentsByCapability(capability);
  }

  /**
   * Find the best agent for a capability.
   * @param {string} capability
   * @returns {object|null}
   */
  findBestAgent(capability) {
    return this.registry.findBestAgent(capability);
  }

  /**
   * Get agents by type.
   * @param {string} type
   * @returns {object[]}
   */
  getAgentsByType(type) {
    return this.registry.getAgentsByType(type);
  }

  // ── Health & Monitoring ───────────────────────────────────────────────

  /**
   * Send heartbeat for an agent.
   * @param {string} agentId
   * @returns {boolean}
   */
  heartbeat(agentId) {
    return this.registry.heartbeat(agentId);
  }

  /**
   * Get system statistics.
   * @returns {object}
   */
  getStatistics() {
    return {
      registry: this.registry.getStatistics(),
      lifecycle: this.lifecycle.getStatistics(),
      router: this.router.getQueueStats(),
    };
  }

  // ── Event Handling ────────────────────────────────────────────────────

  /**
   * Set up event handlers between components.
   * @private
   */
  _setupEventHandlers() {
    // Lifecycle events → Registry updates
    this.lifecycle.on('agent:spawned', (session) => {
      this.registry.updateStatus(session.id, AGENT_STATUS.ACTIVE);
    });
    
    this.lifecycle.on('agent:completed', (session) => {
      this.registry.updateStatus(session.id, AGENT_STATUS.ACTIVE);
      this.registry.decrementTasks(session.id);
    });
    
    this.lifecycle.on('agent:failed', (session) => {
      this.registry.updateStatus(session.id, AGENT_STATUS.UNHEALTHY);
      this.registry.decrementTasks(session.id);
    });
    
    this.lifecycle.on('agent:killed', (session) => {
      this.registry.updateStatus(session.id, AGENT_STATUS.OFFLINE);
    });
    
    // Registry events → Lifecycle updates
    this.registry.on('agent:unhealthy', (record) => {
      const session = this.lifecycle.getAgent(record.id);
      if (session && session.state === AGENT_LIFECYCLE_STATE.RUNNING) {
        // Optionally kill unhealthy agents
      }
    });
    
    // Router events → Lifecycle updates
    this.router.on('message:completed', (envelope) => {
      if (envelope.metadata.target) {
        this.registry.decrementTasks(envelope.metadata.target);
      }
    });
    
    this.router.on('message:failed', (envelope) => {
      if (envelope.metadata.target) {
        this.registry.decrementTasks(envelope.metadata.target);
      }
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Initialize the A2A facade.
   */
  async initialize() {
    // Register built-in agents
    this._registerBuiltinAgents();
  }

  /**
   * Register built-in agents.
   * @private
   */
  _registerBuiltinAgents() {
    const builtinAgents = [
      { name: 'fundamental', type: 'analyst', capabilities: ['fundamental_analysis', 'financial_analysis'] },
      { name: 'technical', type: 'analyst', capabilities: ['technical_analysis', 'chart_analysis'] },
      { name: 'sentiment', type: 'analyst', capabilities: ['sentiment_analysis', 'news_analysis'] },
      { name: 'risk', type: 'manager', capabilities: ['risk_assessment', 'position_sizing'] },
      { name: 'coordinator', type: 'coordinator', capabilities: ['task_coordination', 'result_aggregation'] },
    ];

    for (const agent of builtinAgents) {
      try {
        this.registerAgent(agent);
      } catch (error) {
        // Agent may already be registered
      }
    }
  }

  /**
   * Shutdown the A2A facade.
   */
  destroy() {
    this.router.destroy();
    this.lifecycle.destroy();
    this.registry.destroy();
  }
}

// ── Singleton Instance ────────────────────────────────────────────────────

let _instance = null;

function getA2A(options) {
  if (!_instance) {
    _instance = new A2AFacade(options);
  }
  return _instance;
}

function resetA2A() {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}

module.exports = {
  A2AFacade,
  ACP_METHODS,
  AGENT_STATUS,
  AGENT_LIFECYCLE_STATE,
  MESSAGE_PRIORITY,
  MESSAGE_STATUS,
  getA2A,
  resetA2A,
};