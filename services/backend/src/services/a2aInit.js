'use strict';

/**
 * A2A Initialization — Initialize A2A protocol and register built-in agents.
 *
 * This module should be called once during application startup.
 */

const { getA2A } = require('./a2aFacade');
const { getConfig } = require('../config/a2aConfig');

let _initialized = false;

/**
 * Initialize A2A protocol.
 * @param {object} [options]
 * @returns {object|null} A2A facade or null if disabled
 */
function initializeA2A(options = {}) {
  if (_initialized) {
    return getA2A();
  }
  
  const config = getConfig();
  
  if (!config.enabled) {
    console.log('A2A protocol is disabled');
    return null;
  }
  
  try {
    // Initialize facade with config
    const a2a = getA2A({
      registry: {
        heartbeatInterval: config.registry.heartbeatInterval,
        heartbeatTimeout: config.registry.heartbeatTimeout,
        maxTasksPerAgent: config.registry.maxTasksPerAgent,
      },
      lifecycle: {
        maxDepth: config.lifecycle.maxDepth,
        maxChildren: config.lifecycle.maxChildren,
        agentTimeoutMs: config.lifecycle.agentTimeoutMs,
        maxTotalAgents: config.lifecycle.maxTotalAgents,
        workspaceBaseDir: config.lifecycle.workspaceBaseDir,
      },
      router: {
        maxRetries: config.router.maxRetries,
        retryDelayMs: config.router.retryDelayMs,
        maxQueueSize: config.router.maxQueueSize,
        messageTimeoutMs: config.router.messageTimeoutMs,
        deadLetterEnabled: config.router.deadLetterEnabled,
      },
    });
    
    // Register built-in trading agents
    _registerBuiltinAgents(a2a);
    
    // Set up event handlers
    _setupEventHandlers(a2a);
    
    _initialized = true;
    console.log('A2A protocol initialized successfully');
    
    return a2a;
  } catch (error) {
    console.error('A2A initialization failed:', error.message);
    return null;
  }
}

/**
 * Register built-in agents with A2A.
 * @param {object} a2a - A2A facade
 * @private
 */
function _registerBuiltinAgents(a2a) {
  const builtinAgents = [
    { id: 'fundamental', name: '基本面分析师', type: 'analyst', capabilities: ['fundamental_analysis', 'financial_analysis'] },
    { id: 'technical', name: '技术面分析师', type: 'analyst', capabilities: ['technical_analysis', 'chart_analysis'] },
    { id: 'sentiment', name: '情绪面分析师', type: 'analyst', capabilities: ['sentiment_analysis', 'news_analysis'] },
    { id: 'news', name: '新闻分析师', type: 'analyst', capabilities: ['news_analysis', 'event_analysis'] },
    { id: 'bullResearcher', name: '多头研究员', type: 'researcher', capabilities: ['research', 'bullish_analysis'] },
    { id: 'bearResearcher', name: '空头研究员', type: 'researcher', capabilities: ['research', 'bearish_analysis'] },
    { id: 'trader', name: '交易决策师', type: 'trader', capabilities: ['trading', 'decision_making'] },
    { id: 'riskManager', name: '风控经理', type: 'manager', capabilities: ['risk_assessment', 'position_sizing'] },
    { id: 'coordinator', name: '协调者', type: 'coordinator', capabilities: ['task_coordination', 'result_aggregation'] },
    { id: 'explore', name: '探索者', type: 'explorer', capabilities: ['code_exploration', 'analysis'] },
    { id: 'plan', name: '规划者', type: 'planner', capabilities: ['task_planning', 'strategy'] },
    { id: 'audit', name: '审计者', type: 'auditor', capabilities: ['code_audit', 'quality_check'] },
    { id: 'fix', name: '修复者', type: 'fixer', capabilities: ['bug_fix', 'code_repair'] },
    { id: 'research', name: '研究员', type: 'researcher', capabilities: ['deep_research', 'analysis'] },
  ];

  for (const agent of builtinAgents) {
    try {
      a2a.registerAgent(agent);
    } catch (error) {
      // Agent may already be registered
    }
  }
}

/**
 * Set up A2A event handlers.
 * @param {object} a2a - A2A facade
 * @private
 */
function _setupEventHandlers(a2a) {
  const a2aRegistry = require('./a2aRegistry');
  const { AGENT_STATUS } = a2aRegistry;
  
  // Registry events
  a2a.registry.on('agent:registered', (record) => {
    console.log(`A2A: Agent registered - ${record.name} (${record.id})`);
  });
  
  a2a.registry.on('agent:deregistered', (record) => {
    console.log(`A2A: Agent deregistered - ${record.name} (${record.id})`);
  });
  
  a2a.registry.on('agent:unhealthy', (record) => {
    console.warn(`A2A: Agent unhealthy - ${record.name} (${record.id})`);
  });
  
  a2a.registry.on('agent:recovered', (record) => {
    console.log(`A2A: Agent recovered - ${record.name} (${record.id})`);
  });
  
  // Lifecycle events
  a2a.lifecycle.on('agent:spawned', (session) => {
    console.log(`A2A: Agent spawned - ${session.name} (${session.id})`);
  });
  
  a2a.lifecycle.on('agent:completed', (session) => {
    console.log(`A2A: Agent completed - ${session.name} (${session.id})`);
  });
  
  a2a.lifecycle.on('agent:failed', (session) => {
    console.warn(`A2A: Agent failed - ${session.name} (${session.id}): ${session.error}`);
  });
  
  // Router events
  a2a.router.on('message:completed', (envelope) => {
    console.log(`A2A: Message completed - ${envelope.id}`);
  });
  
  a2a.router.on('message:deadLetter', (envelope) => {
    console.warn(`A2A: Message dead letter - ${envelope.id}`);
  });
}

/**
 * Shutdown A2A protocol.
 */
function shutdownA2A() {
  if (!_initialized) {
    return;
  }
  
  try {
    const { resetA2A } = require('./a2aFacade');
    resetA2A();
    _initialized = false;
    console.log('A2A protocol shutdown');
  } catch (error) {
    console.error('A2A shutdown error:', error.message);
  }
}

module.exports = {
  initializeA2A,
  shutdownA2A,
  isInitialized: () => _initialized,
};