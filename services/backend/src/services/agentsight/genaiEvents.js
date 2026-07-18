/**
 * GenAI Semantic Events — OpenTelemetry GenAI Semantic Conventions compatible.
 *
 * Aligned with ANOLISA AgentSight GenAI event model:
 * - LLMCall events (model, tokens, cost, latency)
 * - ToolUse events (tool_name, input, output, duration)
 * - AgentStep events (session, trace, interactions)
 *
 * These events follow the OpenTelemetry GenAI Semantic Conventions
 * for observability across AI agent systems.
 *
 * Cross-platform: pure JavaScript, no platform-specific code.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

// ─── Event Types ────────────────────────────────────────────────────────────

const EVENT_TYPES = {
  LLM_CALL:    'gen_ai.llm.call',
  TOOL_USE:    'gen_ai.tool.use',
  AGENT_STEP:  'gen_ai.agent.step',
  EMBEDDING:   'gen_ai.embedding',
  RETRIEVAL:   'gen_ai.retrieval',
  ERROR:       'gen_ai.error',
};

// ─── Event Store ────────────────────────────────────────────────────────────

const MAX_EVENTS = parseInt(process.env.GENAI_EVENTS_MAX, 10) || 500;
const _events = [];
const _eventEmitter = new EventEmitter();
_eventEmitter.setMaxListeners(50);

// Aggregated statistics
const _stats = {
  llmCalls: 0,
  toolUses: 0,
  agentSteps: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCost: 0,
  totalLatencyMs: 0,
  errors: 0,
  byModel: {},        // model -> { calls, inputTokens, outputTokens, cost }
  byTool: {},         // tool -> { calls, totalDuration }
};

// ─── Event Recording ────────────────────────────────────────────────────────

/**
 * Record an LLM call event.
 * @param {object} params
 * @param {string} params.model - Model name (e.g., 'claude-sonnet-4-5-20250514')
 * @param {string} [params.provider] - Provider (e.g., 'anthropic', 'openai')
 * @param {number} [params.inputTokens] - Prompt tokens
 * @param {number} [params.outputTokens] - Completion tokens
 * @param {number} [params.latencyMs] - Response time
 * @param {number} [params.cost] - Estimated cost (USD)
 * @param {boolean} [params.streaming] - Whether streaming was used
 * @param {string} [params.traceId] - Parent trace ID
 * @returns {object} The recorded event
 */
function recordLLMCall(params) {
  const event = _createEvent(EVENT_TYPES.LLM_CALL, {
    'gen_ai.system': params.provider || 'unknown',
    'gen_ai.request.model': params.model,
    'gen_ai.usage.input_tokens': params.inputTokens || 0,
    'gen_ai.usage.output_tokens': params.outputTokens || 0,
    'gen_ai.response.latency_ms': params.latencyMs || 0,
    'gen_ai.cost.usd': params.cost || 0,
    'gen_ai.request.streaming': params.streaming || false,
  }, params.traceId);

  // Update stats
  _stats.llmCalls++;
  _stats.totalInputTokens += params.inputTokens || 0;
  _stats.totalOutputTokens += params.outputTokens || 0;
  _stats.totalCost += params.cost || 0;
  _stats.totalLatencyMs += params.latencyMs || 0;

  // Per-model stats
  const model = params.model || 'unknown';
  if (!_stats.byModel[model]) {
    _stats.byModel[model] = { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  _stats.byModel[model].calls++;
  _stats.byModel[model].inputTokens += params.inputTokens || 0;
  _stats.byModel[model].outputTokens += params.outputTokens || 0;
  _stats.byModel[model].cost += params.cost || 0;

  return event;
}

/**
 * Record a tool use event.
 * @param {object} params
 * @param {string} params.toolName - Tool identifier
 * @param {string} [params.input] - Tool input (truncated)
 * @param {string} [params.output] - Tool output (truncated)
 * @param {number} [params.durationMs] - Execution time
 * @param {boolean} [params.success] - Whether tool succeeded
 * @param {string} [params.traceId] - Parent trace ID
 * @returns {object} The recorded event
 */
function recordToolUse(params) {
  const event = _createEvent(EVENT_TYPES.TOOL_USE, {
    'gen_ai.tool.name': params.toolName,
    'gen_ai.tool.input': _truncate(params.input, 500),
    'gen_ai.tool.output': _truncate(params.output, 500),
    'gen_ai.tool.duration_ms': params.durationMs || 0,
    'gen_ai.tool.success': params.success !== false,
  }, params.traceId);

  // Update stats
  _stats.toolUses++;
  const tool = params.toolName || 'unknown';
  if (!_stats.byTool[tool]) {
    _stats.byTool[tool] = { calls: 0, totalDuration: 0 };
  }
  _stats.byTool[tool].calls++;
  _stats.byTool[tool].totalDuration += params.durationMs || 0;

  return event;
}

/**
 * Record an agent step event (higher-level abstraction).
 * @param {object} params
 * @param {string} params.sessionId - Agent session
 * @param {number} params.stepIndex - Step number
 * @param {string} params.action - What the agent decided to do
 * @param {string} [params.reasoning] - Agent's reasoning (truncated)
 * @param {string} [params.traceId] - Parent trace ID
 * @returns {object} The recorded event
 */
function recordAgentStep(params) {
  const event = _createEvent(EVENT_TYPES.AGENT_STEP, {
    'gen_ai.agent.session_id': params.sessionId,
    'gen_ai.agent.step_index': params.stepIndex,
    'gen_ai.agent.action': params.action,
    'gen_ai.agent.reasoning': _truncate(params.reasoning, 300),
  }, params.traceId);

  _stats.agentSteps++;
  return event;
}

/**
 * Record an error event.
 * @param {object} params
 * @param {string} params.source - Where the error originated
 * @param {string} params.message - Error message
 * @param {string} [params.traceId]
 * @returns {object}
 */
function recordError(params) {
  const event = _createEvent(EVENT_TYPES.ERROR, {
    'gen_ai.error.source': params.source,
    'gen_ai.error.message': _truncate(params.message, 500),
  }, params.traceId);

  _stats.errors++;
  return event;
}

// ─── Query & Stats ──────────────────────────────────────────────────────────

/**
 * Get recent events with optional filtering.
 * @param {object} [filter]
 * @param {string} [filter.type] - Event type filter
 * @param {string} [filter.traceId] - Trace ID filter
 * @param {number} [filter.since] - Timestamp (ms) filter
 * @param {number} [filter.limit=50] - Max events to return
 * @returns {Array<object>}
 */
function getEvents(filter = {}) {
  let result = [..._events];

  if (filter.type) {
    result = result.filter(e => e.type === filter.type);
  }
  if (filter.traceId) {
    result = result.filter(e => e.traceId === filter.traceId);
  }
  if (filter.since) {
    result = result.filter(e => e.timestamp >= filter.since);
  }

  const limit = filter.limit || 50;
  return result.slice(-limit);
}

/**
 * Get aggregated statistics.
 * @returns {object}
 */
function getStats() {
  return {
    ..._stats,
    totalEvents: _events.length,
    avgLatencyMs: _stats.llmCalls > 0 ? Math.round(_stats.totalLatencyMs / _stats.llmCalls) : 0,
  };
}

/**
 * Create an SSE event stream for real-time monitoring.
 * @returns {EventEmitter}
 */
function createEventStream() {
  return _eventEmitter;
}

/**
 * Reset all events and stats.
 */
function reset() {
  _events.length = 0;
  Object.assign(_stats, {
    llmCalls: 0, toolUses: 0, agentSteps: 0,
    totalInputTokens: 0, totalOutputTokens: 0,
    totalCost: 0, totalLatencyMs: 0, errors: 0,
    byModel: {}, byTool: {},
  });
}

// ─── Internal ───────────────────────────────────────────────────────────────

function _createEvent(type, attributes, traceId) {
  const event = {
    eventId: `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    type,
    timestamp: Date.now(),
    traceId: traceId || null,
    attributes,
  };

  // Ring buffer
  if (_events.length >= MAX_EVENTS) {
    _events.shift();
  }
  _events.push(event);

  // Emit for real-time consumers
  _eventEmitter.emit('event', event);
  _eventEmitter.emit(type, event);

  return event;
}

function _truncate(str, maxLen) {
  if (!str || typeof str !== 'string') return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

module.exports = {
  // Event recording
  recordLLMCall,
  recordToolUse,
  recordAgentStep,
  recordError,
  // Query
  getEvents,
  getStats,
  createEventStream,
  reset,
  // Constants
  EVENT_TYPES,
};
