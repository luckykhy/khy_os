/**
 * Ollama Model Manager — list, pull, delete, and recommend models
 * based on local hardware capabilities.
 *
 * Provides Ollama-style model management from within KHY-Quant CLI.
 */
const http = require('http');
const os = require('os');
const { execSync } = require('child_process');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const TIMEOUT_MS = 15_000;

// Model recommendations by hardware tier
const RECOMMENDATIONS = {
  low: [    // < 8 GB RAM or < 4 GB VRAM
    { id: 'qwen2.5:3b', name: 'Qwen 2.5 3B', size: '2.0 GB', reason: '轻量级，适合低配机器' },
    { id: 'phi3:mini', name: 'Phi-3 Mini', size: '2.3 GB', reason: '微软小模型，推理快速' },
  ],
  medium: [  // 8-16 GB RAM or 4-8 GB VRAM
    { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', size: '4.7 GB', reason: '中文优秀，推荐首选' },
    { id: 'llama3.1:8b', name: 'Llama 3.1 8B', size: '4.7 GB', reason: 'Meta 开源，英文强' },
    { id: 'deepseek-coder-v2:lite', name: 'DeepSeek Coder V2 Lite', size: '8.9 GB', reason: '代码分析利器' },
  ],
  high: [   // 16-32 GB RAM or 8-16 GB VRAM
    { id: 'qwen2.5:14b', name: 'Qwen 2.5 14B', size: '9.0 GB', reason: '中文最佳性价比' },
    { id: 'deepseek-v3:latest', name: 'DeepSeek V3', size: '16 GB', reason: '最强中文开源模型' },
    { id: 'codellama:13b', name: 'Code Llama 13B', size: '7.4 GB', reason: '专业代码模型' },
  ],
  ultra: [  // > 32 GB RAM or > 16 GB VRAM
    { id: 'qwen2.5:32b', name: 'Qwen 2.5 32B', size: '20 GB', reason: '中文顶级，逼近商用' },
    { id: 'llama3.1:70b', name: 'Llama 3.1 70B', size: '39 GB', reason: '旗舰级开源' },
    { id: 'deepseek-v3:671b', name: 'DeepSeek V3 671B', size: '404 GB', reason: '仅限超大内存服务器' },
  ],
};

/**
 * JSON request to Ollama API.
 */
function ollamaRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, OLLAMA_HOST);
    const options = {
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama API timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Check if Ollama is running.
 */
async function isOllamaRunning() {
  try {
    const res = await ollamaRequest('GET', '/api/tags');
    return res.status === 200;
  } catch { return false; }
}

/**
 * List installed models.
 */
async function listModels() {
  const res = await ollamaRequest('GET', '/api/tags');
  if (res.status !== 200) throw new Error('Failed to list models');
  return (res.data.models || []).map(m => ({
    name: m.name,
    size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : 'unknown',
    modified: m.modified_at,
    family: m.details?.family || 'unknown',
    paramSize: m.details?.parameter_size || '',
    quantization: m.details?.quantization_level || '',
  }));
}

/**
 * Pull (download) a model. Returns a stream for progress tracking.
 */
function pullModel(modelName, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/pull', OLLAMA_HOST);
    const body = JSON.stringify({ name: modelName, stream: true });

    const req = http.request({
      hostname: url.hostname,
      port: url.port || 11434,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 600_000, // 10 min for large downloads
    }, (res) => {
      let lastStatus = '';
      res.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.status) {
              lastStatus = json.status;
              if (onProgress) {
                onProgress({
                  status: json.status,
                  completed: json.completed || 0,
                  total: json.total || 0,
                  percent: json.total ? Math.round((json.completed / json.total) * 100) : 0,
                });
              }
            }
            if (json.error) {
              reject(new Error(json.error));
              return;
            }
          } catch { /* partial chunk */ }
        }
      });
      res.on('end', () => resolve({ success: true, status: lastStatus }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Delete a model.
 */
async function deleteModel(modelName) {
  const res = await ollamaRequest('DELETE', '/api/delete', { name: modelName });
  return res.status === 200;
}

/**
 * Detect hardware capabilities and return tier + details.
 */
function detectHardware() {
  const totalRamGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeRamGB = Math.round(os.freemem() / (1024 * 1024 * 1024));
  const cpuCount = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'unknown';

  // Try to detect GPU VRAM
  let gpuInfo = null;
  try {
    if (process.platform === 'linux') {
      const nvidiaSmi = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (nvidiaSmi) {
        const [name, vram] = nvidiaSmi.split(', ');
        gpuInfo = { name: name.trim(), vramMB: parseInt(vram) || 0 };
      }
    } else if (process.platform === 'win32') {
      const nvidiaSmi = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>nul', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (nvidiaSmi) {
        const [name, vram] = nvidiaSmi.split(', ');
        gpuInfo = { name: name.trim(), vramMB: parseInt(vram) || 0 };
      }
    }
  } catch { /* no NVIDIA GPU or nvidia-smi not available */ }

  // Determine tier
  const vramGB = gpuInfo ? gpuInfo.vramMB / 1024 : 0;
  let tier;
  if (totalRamGB >= 32 || vramGB >= 16) tier = 'ultra';
  else if (totalRamGB >= 16 || vramGB >= 8) tier = 'high';
  else if (totalRamGB >= 8 || vramGB >= 4) tier = 'medium';
  else tier = 'low';

  return {
    tier,
    totalRamGB,
    freeRamGB,
    cpuCount,
    cpuModel,
    gpu: gpuInfo,
  };
}

/**
 * Get hardware-based model recommendations.
 */
function getRecommendations() {
  const hw = detectHardware();
  return {
    hardware: hw,
    recommended: RECOMMENDATIONS[hw.tier] || RECOMMENDATIONS.medium,
    allTiers: RECOMMENDATIONS,
  };
}

module.exports = {
  isOllamaRunning,
  listModels,
  pullModel,
  deleteModel,
  detectHardware,
  getRecommendations,
  RECOMMENDATIONS,
};
