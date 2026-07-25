/**
 * NVIDIA NIM Model Manager — list and pull models from NVIDIA's
 * NIM (NVIDIA Inference Microservices) catalog.
 *
 * Supports:
 *   - NVIDIA API Catalog models (cloud inference)
 *   - Local NIM container models
 *   - Hardware detection for GPU-specific recommendations
 */
const https = require('https');
const { execSync } = require('child_process');
const { sanitizeOutgoingHeaders } = require('./gateway/adapters/ipAnonymizer');

const NIM_API_BASE = 'integrate.api.nvidia.com';
const TIMEOUT_MS = 30_000;

// Known NVIDIA NIM models
const NIM_CATALOG = [
  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B', size: '~40 GB', tier: 'ultra', category: 'general' },
  { id: 'nvidia/llama-3.1-nemotron-51b-instruct', name: 'Nemotron 51B', size: '~30 GB', tier: 'high', category: 'general' },
  { id: 'nvidia/nemotron-mini-4b-instruct', name: 'Nemotron Mini 4B', size: '~3 GB', tier: 'low', category: 'general' },
  { id: 'nvidia/mistral-nemo-minitron-8b-base', name: 'Minitron 8B', size: '~5 GB', tier: 'medium', category: 'general' },
  { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B (NIM)', size: '~5 GB', tier: 'medium', category: 'general' },
  { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B (NIM)', size: '~40 GB', tier: 'ultra', category: 'general' },
  { id: 'deepseek-ai/deepseek-r1-distill-qwen-7b', name: 'DeepSeek R1 Distill 7B', size: '~5 GB', tier: 'medium', category: 'reasoning' },
  { id: 'nvidia/usdcode-llama3.1-70b-instruct', name: 'USD Code 70B', size: '~40 GB', tier: 'ultra', category: 'code' },
];

/**
 * Check if NVIDIA API key is configured.
 */
function hasApiKey() {
  return !!(process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY);
}

/**
 * Get the API key.
 */
function getApiKey() {
  return process.env.NVIDIA_API_KEY || process.env.NGC_API_KEY || '';
}

/**
 * List available NIM models from catalog.
 */
function listCatalogModels(filterTier = null) {
  if (filterTier) {
    return NIM_CATALOG.filter(m => m.tier === filterTier);
  }
  return [...NIM_CATALOG];
}

/**
 * Detect local NVIDIA GPU capabilities.
 */
function detectNvidiaGpu() {
  try {
    const output = execSync(
      'nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    if (!output) return null;

    const lines = output.split('\n');
    const gpus = lines.map(line => {
      const [name, vramMB, driver, computeCap] = line.split(', ').map(s => s.trim());
      return {
        name,
        vramMB: parseInt(vramMB) || 0,
        vramGB: ((parseInt(vramMB) || 0) / 1024).toFixed(1),
        driver,
        computeCapability: computeCap,
      };
    });

    return { gpus, count: gpus.length, totalVramGB: gpus.reduce((acc, g) => acc + g.vramMB, 0) / 1024 };
  } catch { return null; }
}

/**
 * Generate a response using NVIDIA NIM API.
 */
function generate(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      resolve({
        success: false,
        content: 'NVIDIA API key not configured. Set NVIDIA_API_KEY env var.',
        provider: 'NVIDIA NIM',
        adapter: 'nvidia',
        attempts: [{ provider: 'NVIDIA', success: false, error: 'No API key' }],
      });
      return;
    }

    const model = options.model || 'nvidia/llama-3.1-nemotron-70b-instruct';
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature || 0.4,
      max_tokens: options.maxTokens || 2048,
      stream: false,
    });

    const req = https.request({
      hostname: NIM_API_BASE,
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: sanitizeOutgoingHeaders({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
              success: true,
              content: json.choices[0].message.content,
              provider: `NVIDIA NIM (${model.split('/').pop()})`,
              adapter: 'nvidia',
              model,
              attempts: [{ provider: 'NVIDIA', success: true }],
            });
          } else {
            resolve({
              success: false,
              content: json.error?.message || json.detail || 'Unknown error',
              provider: 'NVIDIA NIM',
              adapter: 'nvidia',
              attempts: [{ provider: 'NVIDIA', success: false, error: json.error?.message }],
            });
          }
        } catch (e) {
          resolve({
            success: false, content: e.message,
            provider: 'NVIDIA NIM', adapter: 'nvidia',
            attempts: [{ provider: 'NVIDIA', success: false, error: e.message }],
          });
        }
      });
    });

    req.on('error', (err) => resolve({
      success: false, content: err.message,
      provider: 'NVIDIA NIM', adapter: 'nvidia',
      attempts: [{ provider: 'NVIDIA', success: false, error: err.message }],
    }));
    req.on('timeout', () => { req.destroy(); resolve({
      success: false, content: 'Request timeout',
      provider: 'NVIDIA NIM', adapter: 'nvidia',
      attempts: [{ provider: 'NVIDIA', success: false, error: 'timeout' }],
    }); });
    req.write(body);
    req.end();
  });
}

/**
 * Get adapter status for gateway integration.
 */
function getStatus() {
  const gpu = detectNvidiaGpu();
  const key = hasApiKey();
  return {
    name: 'NVIDIA NIM',
    type: 'nvidia',
    available: key,
    detail: key
      ? `API Key 已配置` + (gpu ? ` · GPU: ${gpu.gpus[0].name} (${gpu.gpus[0].vramGB} GB)` : '')
      : '未配置 NVIDIA_API_KEY',
    gpu,
  };
}

function detect() { return hasApiKey(); }
function destroy() { /* stateless */ }

module.exports = {
  detect,
  generate,
  getStatus,
  destroy,
  hasApiKey,
  listCatalogModels,
  detectNvidiaGpu,
  NIM_CATALOG,
};
