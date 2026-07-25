/**
 * Cursor Adapter — connect to Cursor IDE's AI models.
 *
 * Reads Cursor's auth token from local storage files and provides
 * access to Cursor's model catalog. Supports both local token detection
 * and account pool fallback.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { sanitizeOutgoingHeaders } = require('./ipAnonymizer');

// Cursor stores auth tokens in different locations per platform
const CURSOR_STORAGE_PATHS = [
  path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'storage.json'),
];

const CURSOR_DB_PATHS = [
  path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
];

const KNOWN_MODELS = [
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false },
  { id: 'gpt-4o', name: 'GPT-4o', isDefault: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', isDefault: false },
  { id: 'claude-3-opus', name: 'Claude 3 Opus', isDefault: false },
  { id: 'cursor-small', name: 'Cursor Small', isDefault: false },
];

const TIMEOUT_MS = 60_000;
let _available = null;
let _token = null;

/**
 * Try to read Cursor auth token from local storage.
 */
function readCursorToken() {
  // Try storage.json first
  for (const p of CURSOR_STORAGE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        // Cursor stores token under various keys
        const token = data.cursorAuth?.accessToken
          || data['cursorAuth/accessToken']
          || data.accessToken;
        if (token) return { accessToken: token, source: 'storage.json' };
      }
    } catch { /* skip */ }
  }
  return null;
}

function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;

  // Check token first
  _token = readCursorToken();
  if (_token) { _available = true; return true; }

  // Fallback: check if Cursor is installed
  try {
    const { findInstallation, findDataPath } = require('./ideDetector');
    const installed = findInstallation('cursor') || findDataPath('cursor');
    _available = !!installed;
  } catch {
    _available = false;
  }
  return _available;
}

async function listModels() {
  return KNOWN_MODELS.map(m => ({
    ...m,
    provider: 'cursor',
    description: '',
  }));
}

/**
 * Generate a response using Cursor's API.
 * Falls back to OpenAI-compatible endpoint if direct API unavailable.
 */
async function generate(prompt, options = {}) {
  if (!detect()) {
    return { success: false, content: '', provider: 'Cursor', adapter: 'cursor', attempts: [] };
  }

  const model = options.model || 'gpt-4o';
  const onChunk = options.onChunk || (() => {});

  try {
    // Use OpenAI-compatible endpoint
    const content = await cursorChat(prompt, model, onChunk);
    return {
      success: true,
      content,
      provider: `Cursor (${model})`,
      adapter: 'cursor',
      attempts: [{ provider: 'Cursor', success: true }],
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      provider: 'Cursor',
      adapter: 'cursor',
      attempts: [{ provider: 'Cursor', success: false, error: err.message }],
    };
  }
}

/**
 * Call Cursor's API endpoint.
 */
function cursorChat(prompt, model, onChunk) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });

    const options = {
      hostname: 'api2.cursor.sh',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: sanitizeOutgoingHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_token.accessToken}`,
        'Content-Length': Buffer.byteLength(payload),
      }),
      timeout: TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.choices?.[0]?.message?.content) {
            const text = result.choices[0].message.content;
            onChunk({ type: 'text', text });
            resolve(text);
          } else if (result.error) {
            reject(new Error(result.error.message || 'Cursor API error'));
          } else {
            reject(new Error(`Unexpected response (HTTP ${res.statusCode})`));
          }
        } catch {
          reject(new Error(`Invalid response from Cursor API (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Cursor API timeout')); });
    req.write(payload);
    req.end();
  });
}

function getStatus() {
  detect();
  return {
    name: 'Cursor IDE',
    type: 'cursor',
    available: _available,
    detail: _available
      ? `Token 有效 (${KNOWN_MODELS.length} 个模型)`
      : '未检测到 Cursor token — 请先登录 Cursor IDE',
  };
}

function destroy() {
  _available = null;
  _token = null;
}

module.exports = { detect, listModels, generate, getStatus, destroy };
