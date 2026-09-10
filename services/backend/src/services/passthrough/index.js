'use strict';

/**
 * Passthrough service — direct passthrough to LLM APIs.
 * Supports custom endpoints and non-standard providers.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_PASSTHROUGH_${name}`] || '').trim();
}

// ── Generic Passthrough ──
async function passthroughRequest(endpoint, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const lib = url.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : '';

      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          ...headers,
        },
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });

      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── Custom Endpoint Registration ──
const _customEndpoints = new Map();

function registerEndpoint(name, config) {
  _customEndpoints.set(name, {
    url: config.url,
    headers: config.headers || {},
    transformRequest: config.transformRequest,
    transformResponse: config.transformResponse,
  });
  return { success: true, name };
}

function getEndpoint(name) {
  return _customEndpoints.get(name) || null;
}

function listEndpoints() {
  return Array.from(_customEndpoints.entries()).map(([name, config]) => ({
    name,
    url: config.url,
  }));
}

async function callEndpoint(name, body) {
  const endpoint = _customEndpoints.get(name);
  if (!endpoint) return { error: `Endpoint not found: ${name}` };

  let requestBody = body;
  if (endpoint.transformRequest) {
    requestBody = endpoint.transformRequest(body);
  }

  const result = await passthroughRequest(endpoint.url, 'POST', requestBody, endpoint.headers);

  if (endpoint.transformResponse && result.status === 200) {
    result.data = endpoint.transformResponse(result.data);
  }

  return result;
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'custom', name: 'Custom Endpoint' },
  { id: 'ollama', name: 'Ollama' },
  { id: 'vllm', name: 'vLLM' },
  { id: 'lmstudio', name: 'LM Studio' },
];

function listProviders() {
  return PROVIDERS;
}

module.exports = {
  passthroughRequest,
  registerEndpoint,
  getEndpoint,
  listEndpoints,
  callEndpoint,
  listProviders,
  PROVIDERS,
};
