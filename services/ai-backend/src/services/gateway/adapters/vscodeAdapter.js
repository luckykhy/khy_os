/**
 * VSCode Adapter — connect to VS Code's Copilot / built-in AI models.
 *
 * Reads GitHub Copilot token from VS Code settings and provides
 * access to Copilot Chat models.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');

const VSCODE_COPILOT_PATHS = [
  path.join(os.homedir(), '.config', 'github-copilot', 'hosts.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'github-copilot', 'hosts.json'),
  path.join(os.homedir(), 'AppData', 'Local', 'github-copilot', 'hosts.json'),
];

const VSCODE_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'storage.json'),
];

const KNOWN_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o (Copilot)', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'o3-mini', name: 'o3-mini', isDefault: false },
];

const TIMEOUT_MS = 60_000;
let _available = null;
let _token = null;

function readCopilotToken() {
  for (const p of VSCODE_COPILOT_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const token = data['github.com']?.oauth_token;
        if (token) return { accessToken: token, source: 'copilot' };
      }
    } catch { /* skip */ }
  }
  return null;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  _token = readCopilotToken();
  if (_token) { _available = true; return true; }

  // Check if VS Code is installed
  try {
    const { findInstallation } = require('./ideDetector');
    const installed = findInstallation('vscode');
    _available = !!installed;
  } catch {
    _available = false;
  }
  return _available;
}

async function listModels() {
  return KNOWN_MODELS.map(m => ({ ...m, provider: 'vscode', description: '' }));
}

async function generate(prompt, options = {}) {
  if (!_token) {
    _token = readCopilotToken();
    if (!_token) {
      return {
        success: false, content: 'VS Code Copilot token not found',
        provider: 'VSCode', adapter: 'vscode',
        attempts: [{ provider: 'VSCode', success: false, error: 'No token' }],
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
      hostname: 'api.githubcopilot.com',
      port: 443,
      path: '/chat/completions',
      method: 'POST',
      headers: sanitizeOutgoingHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_token.accessToken}`,
        'Editor-Version': 'vscode/1.100.0',
        'Editor-Plugin-Version': 'copilot-chat/0.30.0',
        'Openai-Organization': 'github-copilot',
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
              provider: `VSCode Copilot (${model})`, adapter: 'vscode',
              attempts: [{ provider: 'VSCode', success: true }],
            });
          } else {
            resolve({
              success: false, content: json.error?.message || 'Unknown error',
              provider: 'VSCode', adapter: 'vscode',
              attempts: [{ provider: 'VSCode', success: false, error: json.error?.message }],
            });
          }
        } catch (e) {
          resolve({
            success: false, content: e.message,
            provider: 'VSCode', adapter: 'vscode',
            attempts: [{ provider: 'VSCode', success: false, error: e.message }],
          });
        }
      });
    });

    req.on('error', (err) => resolve({
      success: false, content: err.message, provider: 'VSCode', adapter: 'vscode',
      attempts: [{ provider: 'VSCode', success: false, error: err.message }],
    }));
    req.on('timeout', () => { req.destroy(); resolve({
      success: false, content: 'Request timeout', provider: 'VSCode', adapter: 'vscode',
      attempts: [{ provider: 'VSCode', success: false, error: 'timeout' }],
    }); });
    req.write(body);
    req.end();
  });
}

function getStatus() {
  detect();
  return {
    name: 'VS Code (Copilot)',
    type: 'vscode',
    available: _available,
    detail: _available
      ? `Copilot Token 有效 (${KNOWN_MODELS.length} 个模型)`
      : '未检测到 Copilot token — 请先在 VS Code 中登录 GitHub Copilot',
  };
}

function destroy() { _available = null; _token = null; }

module.exports = { detect, listModels, generate, getStatus, destroy };
