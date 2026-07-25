/**
 * VSCode Adapter — connect to VS Code's Copilot / built-in AI models.
 *
 * Reads GitHub Copilot token from VS Code settings and provides
 * access to Copilot Chat models.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');
const { requestJson } = require('./_proxyTunnel');
const { parseList, dedupePaths, resolveUserHomeRoots } = require('./_adapterUtils');
// Model-name SSOT: default IDE model flows from constants/models.js.
const { PRIMARY: MODELS } = require('../../../constants/models');
const { createProtocolHandler } = require('./_protocolPipeline');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
const { normalizeToken, isLikelyCredentialToken: hasTokenShape } = require('./_ideTokenMixin');


// resolveUserHomeRoots imported from _adapterUtils

function buildCopilotPaths() {
  const out = [];
  for (const homeRoot of resolveUserHomeRoots()) {
    out.push(path.join(homeRoot, '.config', 'github-copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'github-copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'AppData', 'Local', 'github-copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'github-copilot', 'hosts.json'));
    out.push(path.join(homeRoot, '.config', 'Code', 'User', 'globalStorage', 'github.copilot', 'hosts.json'));
    out.push(path.join(homeRoot, '.config', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'github.copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'github.copilot', 'hosts.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', 'github.copilot', 'hosts.json'));
  }
  for (const p of parseList(process.env.VSCODE_COPILOT_PATHS || process.env.VSCODE_COPILOT_PATH)) {
    out.push(p);
  }
  return dedupePaths(out);
}

function buildStoragePaths() {
  const out = [];
  for (const homeRoot of resolveUserHomeRoots()) {
    out.push(path.join(homeRoot, '.config', 'Code', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, '.config', 'Code - Insiders', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'storage.json'));
    out.push(path.join(homeRoot, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage', 'storage.json'));
  }
  for (const p of parseList(process.env.VSCODE_STORAGE_PATHS || process.env.VSCODE_STORAGE_PATH)) {
    out.push(p);
  }
  return dedupePaths(out);
}

const VSCODE_COPILOT_PATHS = buildCopilotPaths();
const VSCODE_STORAGE_PATHS = buildStoragePaths();

const KNOWN_MODELS = [
  { id: 'gpt-4o', name: 'GPT-4o (Copilot)', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'o3-mini', name: 'o3-mini', isDefault: false },
];

const { DEFAULT_TIMEOUT_MS } = require('./_protocolPipeline');
const TIMEOUT_MS = parseInt(process.env.VSCODE_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
const _openaiHandler = createProtocolHandler({ protocol: 'openai', adapterName: 'vscode' });
let _available = null;
let _token = null;

function extractTokenFromUnknown(value, depth = 0) {
  if (depth > 6 || value == null) return '';

  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return '';
    if (hasTokenShape(raw)) return normalizeToken(raw);
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try { return extractTokenFromUnknown(JSON.parse(raw), depth + 1); } catch { return ''; }
    }
    return '';
  }

  if (Buffer.isBuffer(value)) {
    return extractTokenFromUnknown(value.toString('utf8'), depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = extractTokenFromUnknown(item, depth + 1);
      if (token) return token;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const directKeys = ['oauth_token', 'oauthToken', 'accessToken', 'token', 'authorization'];
  for (const key of directKeys) {
    const token = normalizeToken(value[key]);
    if (hasTokenShape(token)) return token;
  }

  for (const [k, v] of Object.entries(value)) {
    if (/(refresh.?token)/i.test(k)) continue;
    if (/(oauth|access.?token|auth.?token|id.?token|jwt|bearer|copilot)/i.test(k)) {
      const token = extractTokenFromUnknown(v, depth + 1);
      if (token) return token;
    }
  }
  return '';
}

function readCopilotToken() {
  for (const p of VSCODE_COPILOT_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const token = normalizeToken(
          data['github.com']?.oauth_token
          || data['https://github.com']?.oauth_token
          || data['github.com']?.oauthToken
          || extractTokenFromUnknown(data)
        );
        if (hasTokenShape(token)) return { accessToken: token, source: 'copilot', path: p };
      }
    } catch { /* skip */ }
  }

  // Fallback: scan VS Code storage.json for embedded Copilot auth payloads.
  for (const p of VSCODE_STORAGE_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const token = normalizeToken(
        data['github.copilot']?.oauth_token
        || data['github.copilot']?.oauthToken
        || data['github.copilot.chat']?.accessToken
        || data['github.copilot-chat']?.accessToken
        || extractTokenFromUnknown(data['github.copilot'])
        || extractTokenFromUnknown(data['github.copilot.chat'])
        || extractTokenFromUnknown(data['github.copilot-chat'])
      );
      if (hasTokenShape(token)) return { accessToken: token, source: 'storage.json', path: p };
    } catch { /* skip */ }
  }
  return null;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  _token = readCopilotToken();
  _available = !!(_token && hasTokenShape(_token.accessToken));
  return _available;
}

async function detectAsync(forceRefresh = false) {
  return detect(forceRefresh);
}

async function listModels() {
  return KNOWN_MODELS.map(m => ({ ...m, provider: 'vscode', description: '' }));
}

async function generate(prompt, options = {}) {
  if (!_token || !hasTokenShape(_token.accessToken)) {
    _token = readCopilotToken();
    if (!_token || !hasTokenShape(_token.accessToken)) {
      return buildFailure('VS Code Copilot token not found', {
        adapter: 'vscode', provider: 'VSCode', errorType: 'auth',
        attempts: [{ provider: 'VSCode', success: false, error: 'No token' }],
      });
    }
  }

  const model = options.model || MODELS.ide;

  try {
    const { body } = _openaiHandler.buildRequestBody(prompt, {
      ...options,
      model,
      stream: false,
    });

    const res = await requestJson(
      'https://api.githubcopilot.com/chat/completions',
      {
        method: 'POST',
        timeout: TIMEOUT_MS,
        headers: sanitizeOutgoingHeaders({
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_token.accessToken}`,
          'Editor-Version': 'vscode/1.100.0',
          'Editor-Plugin-Version': 'copilot-chat/0.30.0',
          'Openai-Organization': 'github-copilot',
        }),
        body,
      },
      {
        namespace: 'vscode',
        envKeys: ['VSCODE_HTTP_PROXY', 'VSCODE_HTTPS_PROXY', 'VSCODE_PROXY', 'VSCODE_ALL_PROXY'],
        autoEnvKey: 'VSCODE_AUTO_PROXY',
        portsEnvKey: 'VSCODE_AUTO_PROXY_PORTS',
      }
    );

    const statusCode = Number(res.status || 0);
    if (statusCode === 401 || statusCode === 403) {
      return buildFailure(`Copilot auth failed (${statusCode})`, {
        adapter: 'vscode', provider: 'VSCode', errorType: 'auth', statusCode,
        attempts: [{ provider: 'VSCode', success: false, error: `auth failed (${statusCode})` }],
      });
    }
    if (statusCode < 200 || statusCode >= 300) {
      return buildFailure(`Copilot API HTTP ${statusCode}`, {
        adapter: 'vscode', provider: 'VSCode', statusCode,
        attempts: [{ provider: 'VSCode', success: false, error: `HTTP ${statusCode}` }],
      });
    }

    const json = res.data || {};
    const choice = json.choices?.[0];
    if (choice) {
      const parsed = _openaiHandler.parseJsonResponse(json);
      return buildSuccess(parsed.content, {
        adapter: 'vscode', provider: `VSCode Copilot (${model})`, model: parsed.model || model,
        toolUseBlocks: parsed.toolUseBlocks, stopReason: parsed.stopReason,
        tokenUsage: parsed.usage, thinking: parsed.thinking,
        attempts: [{ provider: 'VSCode', success: true }],
      });
    }
    return buildFailure(json.error?.message || 'Unknown error', {
      adapter: 'vscode', provider: 'VSCode',
      attempts: [{ provider: 'VSCode', success: false, error: json.error?.message || 'unknown_error' }],
    });
  } catch (err) {
    return buildFailure(err, {
      adapter: 'vscode', provider: 'VSCode',
      attempts: [{ provider: 'VSCode', success: false, error: err.message }],
    });
  }
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

module.exports = { detect, detectAsync, listModels, generate, getStatus, destroy };
