'use strict';

/**
 * Model Router — intelligent model routing across providers.
 * Routes requests to optimal provider based on capabilities, cost, and latency.
 */

const _providers = new Map();

function registerProvider(name, config) {
  _providers.set(name, {
    name,
    models: config.models || [],
    capabilities: config.capabilities || [],
    costPerToken: config.costPerToken || {},
    avgLatencyMs: config.avgLatencyMs || 1000,
    priority: config.priority || 0,
    ...config,
  });
}

function getProvider(name) {
  return _providers.get(name) || null;
}

function listProviders() {
  return Array.from(_providers.values()).map((p) => ({
    name: p.name,
    models: p.models,
    capabilities: p.capabilities,
    costPerToken: p.costPerToken,
    avgLatencyMs: p.avgLatencyMs,
  }));
}

// ── Route by model name ──
function routeByModel(modelName) {
  for (const [name, provider] of _providers.entries()) {
    if (provider.models.includes(modelName)) {
      return { provider: name, model: modelName, ...provider };
    }
  }
  return null;
}

// ── Route by capability ──
function routeByCapability(capability) {
  const candidates = [];
  for (const [name, provider] of _providers.entries()) {
    if (provider.capabilities.includes(capability)) {
      candidates.push({ provider: name, ...provider, score: calculateScore(provider) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// ── Route by cost optimization ──
function routeByCost(modelName) {
  let bestProvider = null;
  let bestCost = Infinity;

  for (const [name, provider] of _providers.entries()) {
    if (provider.models.includes(modelName)) {
      const cost = provider.costPerToken[modelName] || provider.costPerToken.default || Infinity;
      if (cost < bestCost) {
        bestCost = cost;
        bestProvider = { provider: name, model: modelName, costPerToken: cost, ...provider };
      }
    }
  }
  return bestProvider;
}

// ── Route by latency ──
function routeByLatency(modelName) {
  let bestProvider = null;
  let bestLatency = Infinity;

  for (const [name, provider] of _providers.entries()) {
    if (provider.models.includes(modelName)) {
      if (provider.avgLatencyMs < bestLatency) {
        bestLatency = provider.avgLatencyMs;
        bestProvider = { provider: name, model: modelName, avgLatencyMs: bestLatency, ...provider };
      }
    }
  }
  return bestProvider;
}

// ── Calculate provider score (higher is better) ──
function calculateScore(provider) {
  const latencyScore = Math.max(0, 1000 - provider.avgLatencyMs) / 10;
  const costScore = provider.costPerToken.default
    ? Math.max(0, 100 - provider.costPerToken.default * 10000)
    : 50;
  const priorityScore = provider.priority * 10;
  return latencyScore + costScore + priorityScore;
}

// ── Get routing stats ──
function getRoutingStats() {
  return {
    totalProviders: _providers.size,
    providers: listProviders(),
  };
}

// ── Initialize with default providers ──
function initDefaults() {
  registerProvider('openai', {
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-preview', 'o1-mini'],
    capabilities: ['chat', 'vision', 'code', 'reasoning', 'function_calling'],
    costPerToken: { 'gpt-4o': 0.00001, 'gpt-4o-mini': 0.00000015, default: 0.00001 },
    avgLatencyMs: 800,
    priority: 10,
  });

  registerProvider('anthropic', {
    models: ['claude-sonnet-4-5-20250929', 'claude-opus-4-0-20250514', 'claude-haiku-4-5-20241022'],
    capabilities: ['chat', 'vision', 'code', 'reasoning', 'function_calling'],
    costPerToken: { 'claude-sonnet-4-5-20250929': 0.000003, 'claude-haiku-4-5-20241022': 0.00000025, default: 0.000003 },
    avgLatencyMs: 1000,
    priority: 9,
  });

  registerProvider('google', {
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    capabilities: ['chat', 'vision', 'code', 'reasoning', 'function_calling'],
    costPerToken: { 'gemini-2.0-flash': 0.0000001, 'gemini-1.5-pro': 0.00000125, default: 0.0000001 },
    avgLatencyMs: 700,
    priority: 8,
  });

  registerProvider('deepseek', {
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-r1-0528'],
    capabilities: ['chat', 'code', 'reasoning'],
    costPerToken: { 'deepseek-v4-flash': 0.0000001, default: 0.0000002 },
    avgLatencyMs: 1200,
    priority: 7,
  });

  registerProvider('ollama', {
    models: ['llama3.3', 'qwen2.5', 'deepseek-r1', 'codellama'],
    capabilities: ['chat', 'code', 'reasoning'],
    costPerToken: { default: 0 },
    avgLatencyMs: 500,
    priority: 5,
  });
}

module.exports = {
  registerProvider,
  getProvider,
  listProviders,
  routeByModel,
  routeByCapability,
  routeByCost,
  routeByLatency,
  getRoutingStats,
  initDefaults,
};
