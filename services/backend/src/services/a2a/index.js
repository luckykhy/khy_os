'use strict';

/**
 * A2A (Agent-to-Agent) Protocol service — inter-agent communication.
 * Supports Google A2A protocol for agent interoperability.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_A2A_${name}`] || '').trim();
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : '';
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0, ...headers },
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── A2A Agent Card ──
async function getAgentCard(agentUrl) {
  return _request(`${agentUrl}/.well-known/agent-card.json`);
}

// ── A2A Message Send ──
async function sendMessage(agentUrl, message, options = {}) {
  const apiKey = _env('API_KEY');
  return _request(`${agentUrl}/v1/message:send`, 'POST', {
    message: {
      messageId: options.messageId || `msg_${Date.now()}`,
      parts: [{ text: message }],
      role: 'user',
    },
    metadata: options.metadata || {},
  }, {
    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,
    'X-User-Id': options.userId,
  });
}

// ── A2A Task Create ──
async function createTask(agentUrl, task, options = {}) {
  const apiKey = _env('API_KEY');
  return _request(`${agentUrl}/v1/tasks`, 'POST', {
    id: options.taskId || `task_${Date.now()}`,
    messages: [{ parts: [{ text: task }], role: 'user' }],
    metadata: options.metadata || {},
  }, {
    'Authorization': apiKey ? `Bearer ${apiKey}` : undefined,
  });
}

// ── A2A Task Get ──
async function getTask(agentUrl, taskId) {
  return _request(`${agentUrl}/v1/tasks/${taskId}`);
}

// ── Local A2A Server ──
function createLocalAgentCard(options = {}) {
  const serviceDefaults = require('../../constants/serviceDefaults');
  return {
    name: options.name || 'khy-os-agent',
    description: options.description || 'Khy OS Agent',
    // Advertised URL of the local backend; port comes from the single source
    // of truth (serviceDefaults.BACKEND_PORT) — never a literal host:port.
    url: options.url || `http://127.0.0.1:${serviceDefaults.BACKEND_PORT}`,
    version: options.version || '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['bearer'],
    },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: options.skills || [],
  };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'google', name: 'Google A2A' },
  { id: 'local', name: 'Local A2A' },
];

function listProviders() {
  return PROVIDERS;
}

module.exports = {
  getAgentCard,
  sendMessage,
  createTask,
  getTask,
  createLocalAgentCard,
  listProviders,
  PROVIDERS,
};
