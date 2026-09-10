'use strict';

/**
 * Models service — model registry and management.
 * Central registry for all available models across providers.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_MODELS_${name}`] || '').trim();
}

// ── Model Registry ──
const _models = new Map();

function registerModel(id, config) {
  _models.set(id, {
    id,
    name: config.name || id,
    provider: config.provider,
    capabilities: config.capabilities || [],
    contextWindow: config.contextWindow || 4096,
    maxTokens: config.maxTokens || 4096,
    costPerToken: config.costPerToken || 0,
    supportsVision: config.supportsVision || false,
    supportsTools: config.supportsTools || false,
    supportsStreaming: config.supportsStreaming !== false,
    ...config,
  });
  return { success: true, id };
}

function getModel(id) {
  return _models.get(id) || null;
}

function listModels(filter = {}) {
  let models = Array.from(_models.values());

  if (filter.provider) {
    models = models.filter((m) => m.provider === filter.provider);
  }
  if (filter.capability) {
    models = models.filter((m) => m.capabilities.includes(filter.capability));
  }
  if (filter.vision) {
    models = models.filter((m) => m.supportsVision);
  }
  if (filter.tools) {
    models = models.filter((m) => m.supportsTools);
  }

  return models;
}

function removeModel(id) {
  return _models.delete(id);
}

function clearModels() {
  _models.clear();
}

// ── Model Capabilities ──
function getModelCapabilities(id) {
  const model = _models.get(id);
  return model ? model.capabilities : [];
}

function supportsCapability(id, capability) {
  const model = _models.get(id);
  return model ? model.capabilities.includes(capability) : false;
}

// ── Model Selection ──
function selectModel(requirements = {}) {
  const candidates = listModels(requirements);

  if (candidates.length === 0) {
    return null;
  }

  // Sort by cost (lowest first)
  candidates.sort((a, b) => (a.costPerToken || 0) - (b.costPerToken || 0));

  return candidates[0];
}

// ── Initialize Default Models ──
function initDefaults() {
  // OpenAI models
  registerModel('gpt-4o', {
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'code', 'tools', 'reasoning'],
    contextWindow: 128000,
    maxTokens: 16384,
    costPerToken: 0.00001,
    supportsVision: true,
    supportsTools: true,
  });

  registerModel('gpt-4o-mini', {
    name: 'GPT-4o Mini',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'code', 'tools'],
    contextWindow: 128000,
    maxTokens: 16384,
    costPerToken: 0.00000015,
    supportsVision: true,
    supportsTools: true,
  });

  registerModel('o1-preview', {
    name: 'o1 Preview',
    provider: 'openai',
    capabilities: ['chat', 'reasoning', 'code'],
    contextWindow: 128000,
    maxTokens: 16384,
    costPerToken: 0.000015,
    supportsVision: false,
    supportsTools: false,
  });

  // Anthropic models
  registerModel('claude-sonnet-4-5-20250929', {
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'code', 'tools', 'reasoning'],
    contextWindow: 200000,
    maxTokens: 8192,
    costPerToken: 0.000003,
    supportsVision: true,
    supportsTools: true,
  });

  registerModel('claude-opus-4-0-20250514', {
    name: 'Claude Opus 4',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'code', 'tools', 'reasoning'],
    contextWindow: 200000,
    maxTokens: 8192,
    costPerToken: 0.000015,
    supportsVision: true,
    supportsTools: true,
  });

  registerModel('claude-haiku-4-5-20241022', {
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'code', 'tools'],
    contextWindow: 200000,
    maxTokens: 8192,
    costPerToken: 0.00000025,
    supportsVision: true,
    supportsTools: true,
  });

  // Google models
  registerModel('gemini-2.0-flash', {
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    capabilities: ['chat', 'vision', 'code', 'tools', 'reasoning'],
    contextWindow: 1000000,
    maxTokens: 8192,
    costPerToken: 0.0000001,
    supportsVision: true,
    supportsTools: true,
  });

  registerModel('gemini-1.5-pro', {
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    capabilities: ['chat', 'vision', 'code', 'tools'],
    contextWindow: 1000000,
    maxTokens: 8192,
    costPerToken: 0.00000125,
    supportsVision: true,
    supportsTools: true,
  });

  // DeepSeek models
  registerModel('deepseek-v4-pro', {
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    capabilities: ['chat', 'code', 'reasoning'],
    contextWindow: 1000000,
    maxTokens: 8192,
    costPerToken: 0.0000002,
    supportsVision: false,
    supportsTools: true,
  });

  registerModel('deepseek-v4-flash', {
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    capabilities: ['chat', 'code'],
    contextWindow: 1000000,
    maxTokens: 8192,
    costPerToken: 0.0000001,
    supportsVision: false,
    supportsTools: true,
  });
}

// ── Persistence ──
function getModelsDir() {
  const dir = path.join(os.homedir(), '.khy', 'models');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveModels() {
  const dir = getModelsDir();
  const data = Object.fromEntries(_models);
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(data, null, 2));
  return { success: true, count: _models.size };
}

function loadModels() {
  const dir = getModelsDir();
  const filePath = path.join(dir, 'models.json');
  if (!fs.existsSync(filePath)) return { success: false, error: 'No saved models' };

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const [id, model] of Object.entries(data)) {
      _models.set(id, model);
    }
    return { success: true, count: _models.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  registerModel,
  getModel,
  listModels,
  removeModel,
  clearModels,
  getModelCapabilities,
  supportsCapability,
  selectModel,
  initDefaults,
  saveModels,
  loadModels,
  _models,
};
