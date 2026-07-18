/**
 * Windsurf IDE Adapter — connect to Windsurf (Codeium) IDE's AI models.
 *
 * Reads Windsurf's auth token from local storage and provides
 * access to its built-in AI capabilities.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');

const WINDSURF_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Windsurf', 'User', 'globalStorage', 'storage.json'),
  // Legacy Codeium paths
  path.join(os.homedir(), '.config', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Codeium', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Codeium', 'User', 'globalStorage', 'storage.json'),
];

const KNOWN_MODELS = [
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', isDefault: false },
  { id: 'windsurf-cascade', name: 'Windsurf Cascade', isDefault: false },
];

const TIMEOUT_MS = 60_000;
let _available = null;
let _token = null;

function readWindsurfToken() {
  for (const p of WINDSURF_STORAGE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const token = data.windsurfAuth?.accessToken
          || data['codeium/accessToken']
          || data.accessToken;
        if (token) return { accessToken: token, source: path.basename(path.dirname(path.dirname(path.dirname(p)))) };
      }
    } catch { /* skip */ }
  }
  return null;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  _token = readWindsurfToken();
  if (_token) { _available = true; return true; }

  try {
    const { findInstallation } = require('./ideDetector');
    const installed = findInstallation('windsurf');
    _available = !!installed;
  } catch {
    _available = false;
  }
  return _available;
}

async function listModels() {
  return KNOWN_MODELS.map(m => ({ ...m, provider: 'windsurf', description: '' }));
}

async function generate(prompt, options = {}) {
  if (!_token) {
    _token = readWindsurfToken();
    if (!_token) {
      return {
        success: false, content: 'Windsurf token not found',
        provider: 'Windsurf', adapter: 'windsurf',
        attempts: [{ provider: 'Windsurf', success: false, error: 'No token' }],
      };
    }
  }

  const model = options.model || 'gpt-4o';

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });

    const req = https.request({
      hostname: 'api.codeium.com',
      port: 443,
      path: '/windsurf/v1/chat/completions',
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
          if (json.choices?.[0]) {
            resolve({
              success: true, content: json.choices[0].message.content,
              provider: `Windsurf (${model})`, adapter: 'windsurf',
              attempts: [{ provider: 'Windsurf', success: true }],
            });
          } else {
            resolve({
              success: false, content: json.error?.message || 'Unknown error',
              provider: 'Windsurf', adapter: 'windsurf',
              attempts: [{ provider: 'Windsurf', success: false, error: json.error?.message }],
            });
          }
        } catch (e) {
          resolve({
            success: false, content: e.message,
            provider: 'Windsurf', adapter: 'windsurf',
            attempts: [{ provider: 'Windsurf', success: false, error: e.message }],
          });
        }
      });
    });

    req.on('error', (err) => resolve({
      success: false, content: err.message, provider: 'Windsurf', adapter: 'windsurf',
      attempts: [{ provider: 'Windsurf', success: false, error: err.message }],
    }));
    req.on('timeout', () => { req.destroy(); resolve({
      success: false, content: 'Request timeout', provider: 'Windsurf', adapter: 'windsurf',
      attempts: [{ provider: 'Windsurf', success: false, error: 'timeout' }],
    }); });
    req.write(body);
    req.end();
  });
}

function getStatus() {
  detect();
  return {
    name: 'Windsurf IDE',
    type: 'windsurf',
    available: _available,
    detail: _available
      ? `Token 有效 (${KNOWN_MODELS.length} 个模型)`
      : '未检测到 Windsurf token — 请先登录 Windsurf IDE',
  };
}

function destroy() { _available = null; _token = null; }

module.exports = { detect, listModels, generate, getStatus, destroy };
