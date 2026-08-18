/**
 * Ollama Adapter — connect to a local Ollama instance for LLM inference.
 *
 * Ollama exposes OpenAI-compatible generation and chat APIs; the service host
 * is resolved through the shared OLLAMA_HOST default.
 *
 * Detection: GET /api/tags (list available models).
 * Generation: POST /api/generate { model, prompt, stream: false }
 */
const http = require('http');

// Endpoint default comes from the single source of truth (which already applies
// the OLLAMA_HOST env override), so a self-hosted or remapped Ollama is one edit
// there rather than a literal repeated per adapter.
const { OLLAMA_HOST } = require('../../../constants/serviceDefaults');

const DEFAULT_HOST = OLLAMA_HOST;
const DEFAULT_MODEL = 'qwen2.5:7b'; // Good Chinese support
const TIMEOUT_MS = 120_000;

let _available = null;
let _models = [];

/**
 * Make an HTTP request to the Ollama API.
 */
function ollamaRequest(path, method = 'GET', body = null) {
  const host = process.env.OLLAMA_HOST || DEFAULT_HOST;
  const url = new URL(path, host);
  const timeoutMs = method === 'GET' ? 3000 : TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let req;
    let idleTimer;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        req.destroy();
        reject(new Error('Ollama request idle timeout'));
      }, timeoutMs);
    };

    const options = {
      // Force IPv4 to avoid Windows dual-stack DNS delay
      hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };

    req = http.request(options, (res) => {
      resetIdleTimeout();
      let data = '';
      res.on('data', (chunk) => {
        resetIdleTimeout();
        data += chunk;
      });
      res.on('end', () => {
        clearTimeout(idleTimer);
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', (err) => {
      clearTimeout(idleTimer);
      reject(err);
    });
    req.on('timeout', () => {
      clearTimeout(idleTimer);
      req.destroy();
      reject(new Error('Ollama request idle timeout'));
    });
    resetIdleTimeout();

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Detect if Ollama is running and has models available.
 * Returns cached result unless forceRefresh is true.
 * Because detection uses async HTTP, call detectAsync() for fresh probe.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  // Synchronous path can only return cached value; trigger async probe
  detectAsync().catch(() => {});
  return _available || false;
}

/**
 * Async detection — probe Ollama /api/tags via Node http (no curl dependency).
 */
async function detectAsync() {
  try {
    const result = await ollamaRequest('/api/tags', 'GET');
    if (result.status === 200 && result.data?.models?.length > 0) {
      _models = result.data.models.map((m) => m.name || m.model);
      _available = true;
      return true;
    }
    _available = false;
    return false;
  } catch {
    _available = false;
    _models = [];
    return false;
  }
}

/**
 * Generate a response using the Ollama API.
 */
async function generate(prompt, options = {}) {
  const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;

  try {
    const result = await ollamaRequest('/api/generate', 'POST', {
      model,
      prompt,
      system: options.system || undefined,
      stream: false,
      options: {
        temperature: options.temperature || 0.4,
        num_predict: options.maxTokens || 2048,
      },
    });

    if (result.status === 200 && result.data && result.data.response) {
      return {
        success: true,
        content: result.data.response,
        provider: `Ollama (${model})`,
        adapter: 'ollama',
        attempts: [{ provider: `Ollama (${model})`, success: true }],
      };
    }

    // Model not found — try to suggest pulling
    if (result.status === 404) {
      return {
        success: false,
        content: `模型 ${model} 未找到。请运行: ollama pull ${model}`,
        provider: 'Ollama',
        adapter: 'ollama',
        attempts: [{ provider: `Ollama (${model})`, success: false, error: 'model not found' }],
      };
    }

    return {
      success: false,
      content: '',
      provider: 'Ollama',
      adapter: 'ollama',
      attempts: [{ provider: `Ollama (${model})`, success: false, error: `HTTP ${result.status}` }],
    };
  } catch (err) {
    return {
      success: false,
      content: '',
      provider: 'Ollama',
      adapter: 'ollama',
      attempts: [{ provider: `Ollama (${model})`, success: false, error: err.message }],
    };
  }
}

/**
 * Get adapter status.
 */
function getStatus() {
  const available = detect();
  const model = process.env.OLLAMA_MODEL || DEFAULT_MODEL;
  return {
    name: 'Ollama 本地模型',
    type: 'ollama',
    available,
    detail: available
      ? `${_models.length} 个模型 (当前: ${model})`
      : '未运行 — ollama serve 启动服务',
  };
}

/**
 * Get list of available models.
 */
function getModels() {
  return _models;
}

function destroy() {
  _available = null;
  _models = [];
}

module.exports = { detect, detectAsync, generate, getStatus, getModels, destroy };
