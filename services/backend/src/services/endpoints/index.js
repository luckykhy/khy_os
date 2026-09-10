'use strict';

/**
 * Endpoints service — API endpoint management.
 * Central registry for all API endpoints used by the system.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_ENDPOINT_${name}`] || '').trim();
}

// ── Endpoint Registry ──
const _endpoints = new Map();

function registerEndpoint(name, config) {
  _endpoints.set(name, {
    name,
    url: config.url,
    method: config.method || 'POST',
    headers: config.headers || {},
    provider: config.provider,
    description: config.description || '',
    enabled: config.enabled !== false,
    timeout: config.timeout || 30000,
    retryCount: config.retryCount || 3,
    ...config,
  });
  return { success: true, name };
}

function getEndpoint(name) {
  return _endpoints.get(name) || null;
}

function listEndpoints(filter = {}) {
  let endpoints = Array.from(_endpoints.values());

  if (filter.provider) {
    endpoints = endpoints.filter((e) => e.provider === filter.provider);
  }
  if (filter.enabled !== undefined) {
    endpoints = endpoints.filter((e) => e.enabled === filter.enabled);
  }

  return endpoints;
}

function updateEndpoint(name, updates) {
  const endpoint = _endpoints.get(name);
  if (!endpoint) return { success: false, error: 'Endpoint not found' };

  _endpoints.set(name, { ...endpoint, ...updates, name });
  return { success: true, name };
}

function removeEndpoint(name) {
  return _endpoints.delete(name);
}

function enableEndpoint(name) {
  return updateEndpoint(name, { enabled: true });
}

function disableEndpoint(name) {
  return updateEndpoint(name, { enabled: false });
}

// ── Default Endpoints ──
function initDefaults() {
  registerEndpoint('openai_chat', {
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    provider: 'openai',
    description: 'OpenAI Chat Completions',
    headers: { 'Authorization': 'Bearer ${OPENAI_API_KEY}' },
  });

  registerEndpoint('openai_embedding', {
    url: 'https://api.openai.com/v1/embeddings',
    method: 'POST',
    provider: 'openai',
    description: 'OpenAI Embeddings',
  });

  registerEndpoint('openai_image', {
    url: 'https://api.openai.com/v1/images/generations',
    method: 'POST',
    provider: 'openai',
    description: 'OpenAI Image Generation',
  });

  registerEndpoint('anthropic_messages', {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    provider: 'anthropic',
    description: 'Anthropic Messages',
    headers: {
      'x-api-key': '${ANTHROPIC_API_KEY}',
      'anthropic-version': '2023-06-01',
    },
  });

  registerEndpoint('google_generate', {
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    method: 'POST',
    provider: 'google',
    description: 'Google Generative AI',
  });

  registerEndpoint('ollama_chat', {
    url: '${OLLAMA_HOST}/api/chat',
    method: 'POST',
    provider: 'ollama',
    description: 'Ollama Chat',
  });

  registerEndpoint('firecrawl_search', {
    url: 'https://api.firecrawl.dev/v1/search',
    method: 'GET',
    provider: 'firecrawl',
    description: 'Firecrawl Search',
  });
}

// ── Persistence ──
function getEndpointsDir() {
  const dir = path.join(os.homedir(), '.khy', 'endpoints');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveEndpoints() {
  const dir = getEndpointsDir();
  const data = Object.fromEntries(_endpoints);
  fs.writeFileSync(path.join(dir, 'endpoints.json'), JSON.stringify(data, null, 2));
  return { success: true, count: _endpoints.size };
}

function loadEndpoints() {
  const dir = getEndpointsDir();
  const filePath = path.join(dir, 'endpoints.json');
  if (!fs.existsSync(filePath)) return { success: false, error: 'No saved endpoints' };

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const [name, endpoint] of Object.entries(data)) {
      _endpoints.set(name, endpoint);
    }
    return { success: true, count: _endpoints.size };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  registerEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
  removeEndpoint,
  enableEndpoint,
  disableEndpoint,
  initDefaults,
  saveEndpoints,
  loadEndpoints,
  _endpoints,
};
