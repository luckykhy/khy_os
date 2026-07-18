/**
 * Agent Communication Service — Multi-agent messaging, shared memory, and growth.
 *
 * Provides:
 * - Inter-agent message passing (ACP JSON-RPC 2.0 format internally)
 * - Shared memory store (persisted in growth directory)
 * - Agent specialization tracking (accuracy/domains)
 * - Custom multi-agent task orchestration
 * - Multi-IDE model collaboration (when multiple AI tools are available)
 * - Online learning integration (agents absorb new patterns from internet AI)
 *
 * Internal wire format uses ACP (Agent Communication Protocol) envelopes.
 * Public API remains unchanged for backward compatibility.
 */

const path = require('path');
const crypto = require('crypto');
const { ACP_METHODS, createRequest, createNotification } = require('./acpTransport');

let growthService = null;
function getGrowthService() {
  if (!growthService) growthService = require('./growthService');
  return growthService;
}

// ─── Agent Registry ─────────────────────────────────────────────────────────

const AGENT_REGISTRY = {
  fundamental: { name: '基本面分析师', role: 'Analyze company financials, earnings, and valuation' },
  technical: { name: '技术面分析师', role: 'Analyze price patterns, indicators, and trends' },
  sentiment: { name: '情绪面分析师', role: 'Gauge market sentiment from social media and news tone' },
  news: { name: '新闻分析师', role: 'Parse and interpret market news and events' },
  bullResearcher: { name: '多头研究员', role: 'Build bullish investment cases with evidence' },
  bearResearcher: { name: '空头研究员', role: 'Build bearish investment cases with evidence' },
  trader: { name: '交易决策师', role: 'Make final trading decisions based on all inputs' },
  riskManager: { name: '风控经理', role: 'Evaluate risk and adjust position sizing' },
};

// ─── Message Queue (in-memory per session) ──────────────────────────────────

const _messageQueue = [];
const _messageHistory = [];
const MAX_HISTORY = 200;

/**
 * Send a message from one agent to another.
 * Internally wraps in ACP JSON-RPC 2.0 envelope.
 */
function sendMessage(from, to, type, payload) {
  const msgId = crypto.randomUUID();
  // Build ACP-compatible envelope
  const acpMsg = createRequest(ACP_METHODS.MESSAGE_SEND, {
    from,
    to,
    type,  // 'signal' | 'query' | 'alert' | 'context' | 'insight'
    payload,
    correlationId: payload.correlationId || null,
  }, msgId);

  // Store in legacy format for backward compat with consumers
  const msg = {
    id: msgId,
    from,
    to,
    type,
    payload,
    timestamp: new Date().toISOString(),
    correlationId: payload.correlationId || null,
    _acp: acpMsg, // internal ACP envelope reference
  };
  _messageQueue.push(msg);
  _messageHistory.push(msg);
  if (_messageHistory.length > MAX_HISTORY) _messageHistory.shift();
  return msg.id;
}

/**
 * Broadcast a message to all agents.
 */
function broadcastMessage(from, type, payload) {
  const ids = [];
  for (const agentId of Object.keys(AGENT_REGISTRY)) {
    if (agentId !== from) {
      ids.push(sendMessage(from, agentId, type, payload));
    }
  }
  return ids;
}

/**
 * Get pending messages for an agent.
 */
function getMessages(agentId) {
  const msgs = _messageQueue.filter(m => m.to === agentId);
  // Remove from queue
  for (let i = _messageQueue.length - 1; i >= 0; i--) {
    if (_messageQueue[i].to === agentId) _messageQueue.splice(i, 1);
  }
  return msgs;
}

// ─── Shared Memory ──────────────────────────────────────────────────────────

/**
 * Get the shared agent memory context.
 */
function getSharedContext() {
  return getGrowthService().loadComponent('agent_memory.json');
}

/**
 * Update a key in shared context.
 */
function updateSharedContext(key, value) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  if (!memory.sharedContext) memory.sharedContext = {};
  memory.sharedContext[key] = value;
  memory.sharedContext.lastUpdated = new Date().toISOString();
  getGrowthService().saveComponent('agent_memory.json', memory);
}

/**
 * Update an agent's individual state.
 */
function updateAgentState(agentId, state) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  if (!memory.agentStates) memory.agentStates = {};
  memory.agentStates[agentId] = { ...memory.agentStates[agentId], ...state, lastUpdated: new Date().toISOString() };
  getGrowthService().saveComponent('agent_memory.json', memory);
}

/**
 * Record a cross-agent insight (when multiple agents agree or produce a novel finding).
 */
function recordInsight(insight) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  if (!memory.sharedContext.crossAgentInsights) memory.sharedContext.crossAgentInsights = [];
  memory.sharedContext.crossAgentInsights.push({
    ...insight,
    timestamp: new Date().toISOString(),
  });
  // Keep last 50 insights
  if (memory.sharedContext.crossAgentInsights.length > 50) {
    memory.sharedContext.crossAgentInsights = memory.sharedContext.crossAgentInsights.slice(-50);
  }
  getGrowthService().saveComponent('agent_memory.json', memory);
}

// ─── Agent Specialization & Growth ──────────────────────────────────────────

/**
 * Record an agent's prediction for later validation.
 */
function recordPrediction(agentId, prediction) {
  const spec = getGrowthService().loadComponent('agent_specialization.json');
  if (!spec.agents[agentId]) {
    spec.agents[agentId] = { accuracy: 0.5, totalPredictions: 0, correctPredictions: 0, strongDomains: [], weakDomains: [], pendingPredictions: [] };
  }
  if (!spec.agents[agentId].pendingPredictions) spec.agents[agentId].pendingPredictions = [];

  spec.agents[agentId].pendingPredictions.push({
    id: crypto.randomUUID(),
    ...prediction,
    timestamp: new Date().toISOString(),
  });

  // Keep only last 20 pending
  if (spec.agents[agentId].pendingPredictions.length > 20) {
    spec.agents[agentId].pendingPredictions = spec.agents[agentId].pendingPredictions.slice(-20);
  }

  getGrowthService().saveComponent('agent_specialization.json', spec);
  return spec.agents[agentId].pendingPredictions.at(-1).id;
}

/**
 * Validate a prediction outcome (called after market data confirms).
 */
function validatePrediction(agentId, predictionId, correct, domain) {
  const spec = getGrowthService().loadComponent('agent_specialization.json');
  const agent = spec.agents[agentId];
  if (!agent) return;

  // Remove from pending
  if (agent.pendingPredictions) {
    agent.pendingPredictions = agent.pendingPredictions.filter(p => p.id !== predictionId);
  }

  // Update stats
  agent.totalPredictions = (agent.totalPredictions || 0) + 1;
  if (correct) agent.correctPredictions = (agent.correctPredictions || 0) + 1;
  agent.accuracy = agent.totalPredictions > 0 ? agent.correctPredictions / agent.totalPredictions : 0.5;

  // Update domains
  if (domain) {
    if (correct) {
      if (!agent.strongDomains.includes(domain)) agent.strongDomains.push(domain);
      agent.weakDomains = agent.weakDomains.filter(d => d !== domain);
    } else {
      if (!agent.weakDomains.includes(domain)) agent.weakDomains.push(domain);
      // Only remove from strong after 3+ failures
      const failCount = agent.totalPredictions - agent.correctPredictions;
      if (failCount > 3 && agent.strongDomains.includes(domain)) {
        agent.strongDomains = agent.strongDomains.filter(d => d !== domain);
      }
    }
  }

  getGrowthService().saveComponent('agent_specialization.json', spec);
}

/**
 * Get agent reliability score (for weighted consensus).
 */
function getAgentReliability(agentId, domain) {
  const spec = getGrowthService().loadComponent('agent_specialization.json');
  const agent = spec.agents[agentId];
  if (!agent || agent.totalPredictions < 5) return 0.5; // Not enough data

  let score = agent.accuracy;

  // Bonus for strong domain
  if (domain && agent.strongDomains && agent.strongDomains.includes(domain)) {
    score = Math.min(1, score + 0.1);
  }
  // Penalty for weak domain
  if (domain && agent.weakDomains && agent.weakDomains.includes(domain)) {
    score = Math.max(0.1, score - 0.1);
  }

  return score;
}

/**
 * Get all agent specialization stats.
 */
function getAgentStats() {
  const spec = getGrowthService().loadComponent('agent_specialization.json');
  const result = {};

  for (const [agentId, info] of Object.entries(AGENT_REGISTRY)) {
    const stats = spec.agents[agentId] || { accuracy: 0.5, totalPredictions: 0, strongDomains: [], weakDomains: [] };
    result[agentId] = {
      name: info.name,
      role: info.role,
      accuracy: Math.round((stats.accuracy || 0.5) * 100),
      totalPredictions: stats.totalPredictions || 0,
      strongDomains: stats.strongDomains || [],
      weakDomains: stats.weakDomains || [],
    };
  }

  return result;
}

// ─── Multi-Agent Task Execution ─────────────────────────────────────────────

/**
 * Execute a custom multi-agent task.
 * @param {string} taskDescription - What the user wants analyzed
 * @param {string[]} selectedAgents - Which agents to involve (default: all)
 * @param {object} context - Additional context (symbol, data, etc.)
 * @returns {object} Aggregated analysis result
 */
async function executeCustomTask(taskDescription, selectedAgents, context = {}) {
  const agents = selectedAgents || Object.keys(AGENT_REGISTRY);
  const correlationId = crypto.randomUUID();

  // Phase 1: Individual analysis
  const analyses = {};
  for (const agentId of agents) {
    if (!AGENT_REGISTRY[agentId]) continue;

    const agentInfo = AGENT_REGISTRY[agentId];
    const reliability = getAgentReliability(agentId, context.domain);

    analyses[agentId] = {
      name: agentInfo.name,
      role: agentInfo.role,
      reliability: Math.round(reliability * 100),
      prompt: _buildAgentPrompt(agentId, taskDescription, context),
    };
  }

  // Phase 2: Synthesize (caller handles actual LLM calls)
  return {
    correlationId,
    taskDescription,
    agents: analyses,
    synthesisPrompt: _buildSynthesisPrompt(taskDescription, agents, context),
    timestamp: new Date().toISOString(),
  };
}

function _buildAgentPrompt(agentId, task, context) {
  const info = AGENT_REGISTRY[agentId];
  const symbol = context.symbol ? `\n标的: ${context.symbol}` : '';
  return `你是${info.name}。你的职责: ${info.role}\n\n分析任务: ${task}${symbol}\n\n请从你的专业角度提供分析意见，包括关键发现、风险因素和置信度(0-100)。`;
}

function _buildSynthesisPrompt(task, agents, context) {
  const agentNames = agents.map(id => AGENT_REGISTRY[id]?.name || id).join('、');
  return `综合以下专家的分析意见，给出最终建议:\n\n任务: ${task}\n参与专家: ${agentNames}\n\n请综合各方观点，指出共识和分歧，给出明确的行动建议。`;
}

// ─── Multi-IDE Collaboration ────────────────────────────────────────────────

/**
 * Get available IDE/AI providers for multi-model collaboration.
 */
function getAvailableCollaborators() {
  try {
    const aiGateway = require('./gateway/aiGateway');
    const status = aiGateway.getStatus();
    return status.filter(s => s.enabled && s.available).map(s => ({
      name: s.name,
      type: s.type,
      canCollaborate: true,
    }));
  } catch {
    return [];
  }
}

/**
 * Run a collaborative query across multiple available models.
 * Each model provides its perspective, then results are synthesized.
 */
async function collaborativeQuery(prompt, options = {}) {
  const collaborators = getAvailableCollaborators();
  if (collaborators.length <= 1) {
    return { single: true, message: '仅检测到单一模型，无法协作' };
  }

  return {
    collaborators: collaborators.map(c => c.name),
    prompt,
    strategy: options.strategy || 'consensus', // 'consensus' | 'debate' | 'specialist'
    // Actual execution delegated to caller who has access to AI gateway
  };
}

// ─── Online Learning Integration ────────────────────────────────────────────

/**
 * Absorb a new pattern learned from user interaction or internet AI.
 * Agents evolve by incorporating new knowledge patterns.
 */
function absorbPattern(agentId, pattern) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  if (!memory.agentStates) memory.agentStates = {};
  if (!memory.agentStates[agentId]) memory.agentStates[agentId] = { learnedPatterns: [] };
  if (!memory.agentStates[agentId].learnedPatterns) memory.agentStates[agentId].learnedPatterns = [];

  memory.agentStates[agentId].learnedPatterns.push({
    ...pattern,
    absorbedAt: new Date().toISOString(),
  });

  // Keep last 100 patterns per agent
  if (memory.agentStates[agentId].learnedPatterns.length > 100) {
    memory.agentStates[agentId].learnedPatterns = memory.agentStates[agentId].learnedPatterns.slice(-100);
  }

  getGrowthService().saveComponent('agent_memory.json', memory);
}

/**
 * Get learned patterns for an agent (used to enrich its prompts).
 */
function getLearnedPatterns(agentId, limit = 10) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  const patterns = memory.agentStates?.[agentId]?.learnedPatterns || [];
  return patterns.slice(-limit);
}

/**
 * Record user language/style patterns for response diversity.
 * khy model responses should be varied, combining learned patterns.
 */
function recordResponseStyle(input, output, metadata = {}) {
  const memory = getGrowthService().loadComponent('agent_memory.json');
  if (!memory.sharedContext.responseStyles) memory.sharedContext.responseStyles = [];

  memory.sharedContext.responseStyles.push({
    inputPattern: input.slice(0, 100),
    outputStyle: _extractStyle(output),
    metadata,
    timestamp: new Date().toISOString(),
  });

  if (memory.sharedContext.responseStyles.length > 200) {
    memory.sharedContext.responseStyles = memory.sharedContext.responseStyles.slice(-200);
  }

  getGrowthService().saveComponent('agent_memory.json', memory);
}

function _extractStyle(text) {
  // Extract linguistic features for response diversity
  return {
    length: text.length,
    sentenceCount: (text.match(/[。！？.!?]/g) || []).length,
    hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(text),
    formality: text.includes('您') ? 'formal' : 'casual',
    hasBulletPoints: /[-•·]/.test(text),
    hasNumbers: /\d/.test(text),
  };
}

module.exports = {
  // Messaging
  sendMessage,
  broadcastMessage,
  getMessages,

  // Shared Memory
  getSharedContext,
  updateSharedContext,
  updateAgentState,
  recordInsight,

  // Specialization
  recordPrediction,
  validatePrediction,
  getAgentReliability,
  getAgentStats,

  // Task execution
  executeCustomTask,

  // Multi-IDE
  getAvailableCollaborators,
  collaborativeQuery,

  // Online learning
  absorbPattern,
  getLearnedPatterns,
  recordResponseStyle,

  // Registry
  AGENT_REGISTRY,
};
