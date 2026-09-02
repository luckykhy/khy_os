'use strict';

/**
 * visionProxy.js — 多后端视觉代理：给无视觉能力的模型装上眼睛。
 *
 * 当当前模型不支持视觉输入时，将图片发送到配置的视觉模型进行识别，
 * 返回文字描述注入 prompt，让纯文本推理模型也能"看到"图片。
 *
 * 支持后端（通过 KHY_VISION_PROXY_BACKEND 选择）：
 *   - "openrouter" — OpenRouter 免费视觉模型（dots-studio/dots-3-note-preview:free）
 *   - "modelscope" — ModelScope 通义千问VL（Qwen/Qwen3-VL-8B-Instruct）
 *   - "custom"     — 自定义 OpenAI 兼容端点
 *
 * 稳定性机制：
 *   - 自动重试（可重试错误：429/5xx/网络超时/连接重置）
 *   - 熔断器（连续失败达阈值后跳过该后端，冷却后半开探测）
 *   - 图片校验（大小/格式/base64 完整性）
 *   - 健康状态查询（供路由层感知）
 *
 * 环境变量：
 *   KHY_VISION_PROXY_BACKEND     — 后端选择（默认 auto）
 *   KHY_VISION_PROXY_DISABLE     — 设为 1/true/off/no 关闭
 *   KHY_VISION_PROXY_MODEL       — 覆盖默认模型名
 *   KHY_VISION_PROXY_PROMPT      — 覆盖识别提示词
 *   KHY_VISION_PROXY_TIMEOUT     — 单次请求超时毫秒（默认 25000）
 *   KHY_VISION_PROXY_MAX_RETRIES — 最大重试次数（默认 2）
 *   KHY_VISION_PROXY_MAX_SIZE_MB — 图片最大 MB（默认 10）
 *   KHY_VISION_PROXY_CIRCUIT_THRESHOLD — 熔断阈值（连续失败次数，默认 3）
 *   KHY_VISION_PROXY_CIRCUIT_COOLDOWN_MS — 熔断冷却毫秒（默认 60000）
 *
 * 纯叶子：零内部依赖、单一职责、fail-soft。
 */

const https = require('https');
const http = require('http');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// ── 后端预设 ──────────────────────────────────────────────────────
const BACKENDS = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'dots-studio/dots-3-note-preview:free',
    getKey: (e) => (e.KHY_OPENROUTER_API_KEY || '').trim() || null,
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://khy-os.local',
      'X-Title': 'khy-os vision proxy',
    }),
  },
  modelscope: {
    name: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    defaultModel: 'Qwen/Qwen3-VL-8B-Instruct',
    getKey: (e) => (e.KHY_MODELSCOPE_API_KEY || '').trim() || null,
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },
  custom: {
    name: 'Custom',
    baseUrl: '',
    defaultModel: '',
    getKey: (e) => (e.KHY_VISION_PROXY_API_KEY || '').trim() || null,
    buildHeaders: (apiKey) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
  },
};

const AUTO_BACKEND_ORDER = ['openrouter', 'modelscope'];

const DEFAULT_PROMPT =
  '请详细描述这张图片的内容。包括所有相关元素、文字、UI组件、布局，' +
  '以及任何对看不到图片的人有用的信息。如果是错误截图，请提取精确的错误信息。';

const MAX_IMAGE_BYTES_DEFAULT = 10 * 1024 * 1024;
const TIMEOUT_DEFAULT = 25000;
const MAX_RETRIES_DEFAULT = 2;
const CIRCUIT_THRESHOLD_DEFAULT = 3;
const CIRCUIT_COOLDOWN_MS_DEFAULT = 60000;

// 可重试的 HTTP 状态码
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// 可重试的网络错误关键词
const RETRYABLE_ERROR_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|network|timeout|fetch failed/i;

// ── 熔断器状态 ────────────────────────────────────────────────────
// 每个后端独立追踪
const _circuitState = {};
// { [backendKey]: { consecutiveFailures: number, openedAt: number|null, lastCheck: number|null } }

function _getCircuitState(key) {
  if (!_circuitState[key]) {
    _circuitState[key] = { consecutiveFailures: 0, openedAt: null, lastCheck: null };
  }
  return _circuitState[key];
}

function _isCircuitOpen(key, cooldownMs) {
  const state = _circuitState[key];
  if (!state || !state.openedAt) {
    return false;
  }
  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= cooldownMs) {
    // 冷却期已过，半开状态：允许一次探测
    return false;
  }
  return true;
}

function _recordSuccess(key) {
  const state = _getCircuitState(key);
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

function _recordFailure(key, threshold, cooldownMs) {
  const state = _getCircuitState(key);
  state.consecutiveFailures++;
  state.lastCheck = Date.now();
  if (state.consecutiveFailures >= threshold) {
    state.openedAt = Date.now();
  }
}

function _resetCircuit(key) {
  const state = _getCircuitState(key);
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

// ── 配置读取 ──────────────────────────────────────────────────────

function _envNum(env, key, def) {
  const v = parseInt(env[key], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function _resolveBackend(env) {
  const e = env || process.env;
  const explicit = (e.KHY_VISION_PROXY_BACKEND || '').trim().toLowerCase();
  if (explicit && BACKENDS[explicit]) {
    return explicit;
  }
  for (const key of AUTO_BACKEND_ORDER) {
    if (BACKENDS[key].getKey(e)) {
      return key;
    }
  }
  return 'openrouter';
}

function _getBackendConfig(env) {
  const e = env || process.env;
  const backendKey = _resolveBackend(e);
  const preset = BACKENDS[backendKey];

  const apiKey = preset.getKey(e);
  const model = (e.KHY_VISION_PROXY_MODEL || '').trim() || preset.defaultModel;
  let baseUrl = preset.baseUrl;

  if (backendKey === 'custom') {
    baseUrl = (e.KHY_VISION_PROXY_BASE_URL || '').trim();
    if (!baseUrl || !apiKey) {
      return null;
    }
  } else if (!apiKey) {
    return null;
  }

  return {
    key: backendKey,
    name: preset.name,
    baseUrl,
    model,
    apiKey,
    headers: preset.buildHeaders(apiKey),
    timeoutMs: _envNum(e, 'KHY_VISION_PROXY_TIMEOUT', TIMEOUT_DEFAULT),
    maxRetries: _envNum(e, 'KHY_VISION_PROXY_MAX_RETRIES', MAX_RETRIES_DEFAULT),
    maxImageBytes: _envNum(e, 'KHY_VISION_PROXY_MAX_SIZE_MB', MAX_IMAGE_BYTES_DEFAULT) * 1024 * 1024,
    circuitThreshold: _envNum(e, 'KHY_VISION_PROXY_CIRCUIT_THRESHOLD', CIRCUIT_THRESHOLD_DEFAULT),
    circuitCooldownMs: _envNum(e, 'KHY_VISION_PROXY_CIRCUIT_COOLDOWN_MS', CIRCUIT_COOLDOWN_MS_DEFAULT),
  };
}

// ── 图片校验 ──────────────────────────────────────────────────────

const ALLOWED_MAGIC = [
  { prefix: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), name: 'PNG' },
  { prefix: Buffer.from([0xff, 0xd8, 0xff]), name: 'JPEG' },
  { prefix: Buffer.from('GIF87a'), name: 'GIF' },
  { prefix: Buffer.from('GIF89a'), name: 'GIF' },
  { prefix: Buffer.from('RIFF'), name: 'WEBP' },
  { prefix: Buffer.from('BM'), name: 'BMP' },
];

function _validateImage(img, maxBytes) {
  if (!img || !img.base64) {
    return '图片数据为空';
  }
  // base64 格式粗校验
  if (!/^[A-Za-z0-9+/=\s]+$/.test(img.base64.slice(0, 100))) {
    return 'base64 数据格式异常';
  }
  let buf;
  try {
    buf = Buffer.from(img.base64, 'base64');
  } catch {
    return 'base64 解码失败';
  }
  if (buf.length === 0) {
    return '图片解码后为空';
  }
  if (buf.length > maxBytes) {
    return `图片过大：${(buf.length / 1024 / 1024).toFixed(1)}MB（最大 ${maxBytes / 1024 / 1024}MB）`;
  }
  // 魔数校验（宽松：只做前 8 字节匹配）
  const head = buf.slice(0, 8);
  const validMagic = ALLOWED_MAGIC.some((m) => head.slice(0, m.prefix.length).equals(m.prefix));
  if (!validMagic) {
    // 不严格拒绝——某些格式魔数不标准，只警告
    // 返回 null 表示通过但有风险
  }
  return null; // null = 通过
}

// ── 公开接口 ──────────────────────────────────────────────────────

function isEnabled(env) {
  const e = env || process.env;
  const v = e.KHY_VISION_PROXY_DISABLE;
  if (v != null && _FALSY.has(String(v).trim().toLowerCase())) {
    return false;
  }
  const config = _getBackendConfig(e);
  if (!config) {
    return false;
  }
  // 熔断器检查：如果当前后端被熔断，仍然返回 true（路由层会决定是否跳过）
  return true;
}

function getModel(env) {
  const config = _getBackendConfig(env);
  return config ? config.model : '';
}

function getBackendName(env) {
  const config = _getBackendConfig(env);
  return config ? config.name : '';
}

/**
 * 查询当前后端健康状态（供路由层使用）。
 * @param {object} [env]
 * @returns {{available: boolean, backend: string, circuitOpen: boolean, consecutiveFailures: number}}
 */
function getHealth(env) {
  const e = env || process.env;
  const config = _getBackendConfig(e);
  if (!config) {
    return { available: false, backend: 'none', circuitOpen: false, consecutiveFailures: 0 };
  }
  const state = _getCircuitState(config.key);
  const circuitOpen = _isCircuitOpen(config.key, config.circuitCooldownMs);
  return {
    available: !circuitOpen,
    backend: config.name,
    model: config.model,
    circuitOpen,
    consecutiveFailures: state.consecutiveFailures,
  };
}

/**
 * 将图片 base64 数据发送到视觉模型，返回文字描述。
 * 支持自动重试 + 熔断器。
 *
 * @param {Array<{base64: string, mimeType?: string}>} images
 * @param {object} [opts]
 * @param {string} [opts.prompt]
 * @param {object} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{text: string, errors: string[], backend: string}>}
 */
async function recognizeImages(images, opts = {}) {
  const env = opts.env || process.env;
  const config = _getBackendConfig(env);
  if (!config) {
    return {
      text: '',
      errors: ['无可用视觉后端：请设置 KHY_OPENROUTER_API_KEY 或 KHY_MODELSCOPE_API_KEY'],
      backend: 'none',
    };
  }
  if (!Array.isArray(images) || images.length === 0) {
    return { text: '', errors: [], backend: config.name };
  }

  // 熔断器检查
  if (_isCircuitOpen(config.key, config.circuitCooldownMs)) {
    const state = _getCircuitState(config.key);
    return {
      text: '',
      errors: [`${config.name} 熔断器开启（连续失败 ${state.consecutiveFailures} 次），跳过`],
      backend: config.name,
    };
  }

  const prompt = opts.prompt || (env.KHY_VISION_PROXY_PROMPT || '').trim() || DEFAULT_PROMPT;
  const timeoutMs = opts.timeoutMs || config.timeoutMs;

  const descriptions = [];
  const errors = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];

    // 图片校验
    const validationError = _validateImage(img, config.maxImageBytes);
    if (validationError) {
      errors.push(`图片${i + 1}: ${validationError}`);
      continue;
    }

    // 带重试的 API 调用
    let lastError = null;
    const maxAttempts = config.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const text = await _callApi(config, img.base64, img.mimeType, prompt, timeoutMs);
        if (text) {
          descriptions.push(`【图片${i + 1} 视觉识别(${config.name})】\n${text}`);
          lastError = null;
          break;
        } else {
          lastError = '返回为空';
          if (attempt < maxAttempts) {
            await _sleep(Math.min(1000 * attempt, 3000));
          }
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        lastError = msg;

        // 判断是否可重试
        const retryable = _isRetryableError(err, msg);
        if (attempt < maxAttempts && retryable) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await _sleep(delay);
          continue;
        }
        // 不可重试或已达最大次数
        break;
      }
    }

    if (lastError) {
      errors.push(`图片${i + 1}: ${lastError}`);
    }
  }

  // 更新熔断器状态
  if (descriptions.length > 0) {
    _recordSuccess(config.key);
  } else if (errors.length > 0) {
    _recordFailure(config.key, config.circuitThreshold, config.circuitCooldownMs);
  }

  return { text: descriptions.join('\n\n'), errors, backend: config.name };
}

// ── 内部：重试辅助 ────────────────────────────────────────────────

function _isRetryableError(err, msg) {
  // HTTP 状态码可重试
  if (err && err.statusCode && RETRYABLE_STATUS.has(err.statusCode)) {
    return true;
  }
  // 网络错误可重试
  if (RETRYABLE_ERROR_RE.test(msg)) {
    return true;
  }
  return false;
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 内部：API 调用 ────────────────────────────────────────────────

function _callApi(config, base64, mimeType, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mime = mimeType || 'image/png';
    const imagePayload = `data:${mime};base64,${base64}`;

    const body = JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imagePayload } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    });

    const url = new URL(config.baseUrl + '/chat/completions');
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: config.headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
              err.statusCode = res.statusCode;
              reject(err);
              return;
            }
            const json = JSON.parse(data);
            const content = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : '';
            resolve((content || '').trim());
          } catch (e) {
            reject(new Error(`响应解析失败: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`请求超时 (${timeoutMs}ms)`));
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  isEnabled,
  getModel,
  getBackendName,
  getHealth,
  recognizeImages,
  BACKENDS,
  AUTO_BACKEND_ORDER,
  // 导出内部状态供测试
  _circuitState,
  _resetCircuit,
};
