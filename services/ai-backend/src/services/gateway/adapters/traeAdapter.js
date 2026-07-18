/**
 * Trae IDE Adapter — connect to Trae (ByteDance) IDE's AI models.
 *
 * Reads Trae's auth token from local storage and provides access
 * to its built-in AI capabilities (Doubao/Claude/GPT models).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');

// Trae stores auth tokens in different locations per platform
const TRAE_STORAGE_PATHS = [
  // Trae CN (Chinese version)
  path.join(os.homedir(), '.config', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae CN', 'User', 'globalStorage', 'storage.json'),
  // Trae International
  path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'storage.json'),
];

const KNOWN_MODELS = [
  { id: 'doubao-1.5-pro', name: 'Doubao 1.5 Pro', isDefault: true },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: false },
  { id: 'deepseek-v3', name: 'DeepSeek V3', isDefault: false },
  { id: 'doubao-1.5-thinking', name: 'Doubao 1.5 Thinking', isDefault: false },
];

const TIMEOUT_MS = 60_000;
let _available = null;
let _token = null;
let _models = [];

/**
 * Try to read Trae auth token from local storage.
 */
function readTraeToken() {
  for (const p of TRAE_STORAGE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Trae stores token under various keys
        const token = data.traeAuth?.accessToken
          || data['traeAuth/accessToken']
          || data['bytedance.auth']?.accessToken
          || data.accessToken;
        if (token) return { accessToken: token, source: path.basename(path.dirname(path.dirname(path.dirname(p)))) };
      }
    } catch { /* skip */ }
  }
  return null;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  _token = readTraeToken();
  if (_token) { _available = true; return true; }

  // Fallback: check if Trae is installed
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    const installed = findInstallation('trae') || findDataPath('trae');
    _available = !!installed;
  } catch {
    _available = false;
  }
  return _available;
}

async function listModels() {
  _models = KNOWN_MODELS.map(m => ({
    ...m,
    provider: 'trae',
    description: '',
  }));
  return _models;
}

function getStatus() {
  detect();
  return {
    name: 'Trae IDE',
    type: 'trae',
    available: _available,
    detail: _available
      ? `Token 有效` + (_models.length ? ` (${_models.length} 个模型)` : '')
      : '未检测到 Trae token — 请先登录 Trae IDE',
    refreshModels: listModels,
  };
}

async function generate(prompt, options = {}) {
  if (!_token) {
    _token = readTraeToken();
    if (!_token) {
      return {
        success: false,
        content: 'Trae token not found',
        provider: 'Trae',
        adapter: 'trae',
        attempts: [{ provider: 'Trae', success: false, error: 'No token' }],
      };
    }
  }

  const model = options.model || 'doubao-1.5-pro';

  // Trae's real gateway speaks an encrypted native protocol (adaptive-api.trae.ai),
  // NOT the OpenAI-compatible /v1/chat/completions shape this simple HTTP path assumes.
  // Calling api.trae.ai/v1/chat/completions returns 404 (TLB gateway). We therefore do
  // not hardcode api.trae.ai; an OpenAI-compatible endpoint must be supplied explicitly
  // via TRAE_API_ENDPOINT (e.g. a self-hosted proxy). Unset → graceful failure + fallback.
  const endpoint = (process.env.TRAE_API_ENDPOINT || '').trim();
  if (!endpoint) {
    return {
      success: false,
      content: 'Trae native protocol is not supported by this adapter; set TRAE_API_ENDPOINT to an OpenAI-compatible proxy.',
      provider: 'Trae',
      adapter: 'trae',
      attempts: [{ provider: 'Trae', success: false, error: 'no OpenAI-compatible endpoint configured' }],
    };
  }

  let endpointUrl;
  try {
    const base = endpoint.replace(/\/+$/, '');
    endpointUrl = new URL(/\/(chat\/)?completions$/.test(base) ? base : `${base}/chat/completions`);
  } catch (e) {
    return {
      success: false,
      content: `Invalid TRAE_API_ENDPOINT: ${e.message}`,
      provider: 'Trae',
      adapter: 'trae',
      attempts: [{ provider: 'Trae', success: false, error: 'invalid endpoint' }],
    };
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.4,
    });

    const req = https.request({
      hostname: endpointUrl.hostname,
      port: endpointUrl.port || 443,
      path: `${endpointUrl.pathname}${endpointUrl.search}`,
      method: 'POST',
      headers: sanitizeOutgoingHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_token.accessToken}`,
        'Content-Length': Buffer.byteLength(body),
      }),
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve({
              success: true,
              content: json.choices[0].message.content,
              provider: `Trae (${model})`,
              adapter: 'trae',
              attempts: [{ provider: 'Trae', success: true }],
            });
          } else {
            resolve({
              success: false,
              content: json.error?.message || 'Unknown error',
              provider: 'Trae',
              adapter: 'trae',
              attempts: [{ provider: 'Trae', success: false, error: json.error?.message }],
            });
          }
        } catch (e) {
          resolve({
            success: false,
            content: e.message,
            provider: 'Trae',
            adapter: 'trae',
            attempts: [{ provider: 'Trae', success: false, error: e.message }],
          });
        }
      });
    });

    req.on('error', (err) => {
      resolve({
        success: false,
        content: err.message,
        provider: 'Trae',
        adapter: 'trae',
        attempts: [{ provider: 'Trae', success: false, error: err.message }],
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        content: 'Request timeout',
        provider: 'Trae',
        adapter: 'trae',
        attempts: [{ provider: 'Trae', success: false, error: 'timeout' }],
      });
    });

    req.write(body);
    req.end();
  });
}

function destroy() {
  _available = null;
  _token = null;
  _models = [];
}

module.exports = { detect, getStatus, listModels, generate, destroy };
