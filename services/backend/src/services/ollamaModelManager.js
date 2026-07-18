/**
 * Ollama Model Manager — list, pull, delete, and recommend models
 * based on local hardware capabilities.
 *
 * Provides Ollama-style model management from within khy OS CLI.
 */
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, spawn, spawnSync } = require('child_process');

const { OLLAMA_HOST } = require('../constants/serviceDefaults');
const { withTempDir } = require('../utils/ephemeralTmp');
const TIMEOUT_MS = 15_000;
const GGUF_MAGIC = Buffer.from('GGUF');
const OLLAMA_BLOB_NAME_RE = /^sha256[-:][a-f0-9]{32,}$/i;
const MIN_LIKELY_GGUF_BLOB_SIZE = Math.max(
  16 * 1024 * 1024,
  parseInt(process.env.KHY_LOCAL_MIN_GGUF_BLOB_SIZE || String(64 * 1024 * 1024), 10) || (64 * 1024 * 1024)
);

function resolveOllamaBinary() {
  const envBin = String(process.env.OLLAMA_BIN || '').trim();
  if (envBin) return envBin;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(programFiles, 'Ollama', 'ollama.exe'),
      'ollama.exe',
      'ollama',
    ];
    for (const candidate of candidates) {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (fs.existsSync(candidate)) return candidate;
      } else {
        return candidate;
      }
    }
    return 'ollama.exe';
  }

  const candidates = ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama', 'ollama'];
  for (const candidate of candidates) {
    if (candidate.startsWith('/')) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return 'ollama';
}

const OLLAMA_BIN = resolveOllamaBinary();

function hasGgufMagic(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return bytesRead === 4 && Buffer.compare(buf, GGUF_MAGIC) === 0;
  } catch {
    return false;
  }
}

// Model recommendations by hardware tier
const RECOMMENDATIONS = {
  low: [    // < 8 GB RAM or < 4 GB VRAM
    { id: 'qwen2.5:3b', name: 'Qwen 2.5 3B', size: '2.0 GB', reason: '轻量级，适合低配机器' },
    { id: 'phi3:mini', name: 'Phi-3 Mini', size: '2.3 GB', reason: '微软小模型，推理快速' },
  ],
  medium: [  // 8-16 GB RAM or 4-8 GB VRAM
    { id: 'qwen3.5:4b', name: 'Qwen 3.5 4B', size: '3.2 GB', reason: '最新中文模型，推荐首选' },
    { id: 'qwen2.5:7b', name: 'Qwen 2.5 7B', size: '4.7 GB', reason: '中文优秀，经典选择' },
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
      hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
      port: url.port || 11434,
      path: `${url.pathname}${url.search || ''}`,
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

const delay = require('../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

function isLocalOllamaHost() {
  try {
    const host = new URL(OLLAMA_HOST);
    return ['localhost', '127.0.0.1', '::1'].includes(host.hostname);
  } catch {
    return true;
  }
}

function isOllamaBinaryAvailable() {
  try {
    const probe = spawnSync(OLLAMA_BIN, ['--version'], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

function startOllamaServe() {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(OLLAMA_BIN, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      resolve({ started: true, pid: child.pid || null });
    } catch (err) {
      reject(err);
    }
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
 * Ensure Ollama is running.
 * If autoStart is enabled and the local binary exists, start `ollama serve`
 * in the background and wait for the API to come online.
 */
async function ensureOllamaRunning(options = {}) {
  const {
    autoStart = true,
    waitMs = 8000,
    pollMs = 500,
  } = options;

  if (await isOllamaRunning()) {
    return { running: true, started: false, autoStarted: false, message: 'Ollama is already running' };
  }

  if (!autoStart) {
    return { running: false, started: false, autoStarted: false, error: 'Ollama is not running' };
  }

  if (!isLocalOllamaHost()) {
    return {
      running: false,
      started: false,
      autoStarted: false,
      error: `OLLAMA_HOST points to a remote endpoint (${OLLAMA_HOST})`,
    };
  }

  if (!isOllamaBinaryAvailable()) {
    return {
      running: false,
      started: false,
      autoStarted: false,
      error: 'ollama binary not found',
    };
  }

  try {
    await startOllamaServe();
  } catch (err) {
    return {
      running: false,
      started: false,
      autoStarted: false,
      error: err.message || String(err),
    };
  }

  const deadline = Date.now() + Math.max(1000, waitMs);
  while (Date.now() < deadline) {
    if (await isOllamaRunning()) {
      return { running: true, started: true, autoStarted: true, message: 'Ollama started successfully' };
    }
    await delay(Math.max(200, pollMs));
  }

  return {
    running: false,
    started: true,
    autoStarted: true,
    error: `Ollama did not respond within ${waitMs}ms`,
  };
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
 * Infer source type for Ollama import.
 * Supported:
 * - GGUF file
 * - Safetensors adapter file
 * - Safetensors model directory
 */
function inferImportSource(sourcePath) {
  const abs = path.resolve(String(sourcePath || '').trim());
  if (!fs.existsSync(abs)) {
    throw new Error(`Source path not found: ${abs}`);
  }
  const st = fs.statSync(abs);
  if (st.isFile()) {
    const lower = abs.toLowerCase();
    const basename = path.basename(abs).toLowerCase();
    if (lower.endsWith('.gguf')) return { kind: 'gguf', absPath: abs };
    if ((OLLAMA_BLOB_NAME_RE.test(basename) || path.extname(basename) === '')
      && st.size > MIN_LIKELY_GGUF_BLOB_SIZE
      && hasGgufMagic(abs)) {
      return { kind: 'gguf', absPath: abs, inferredFrom: 'ollama_blob' };
    }
    if (lower.endsWith('.safetensors')) return { kind: 'adapter', absPath: abs };
    throw new Error('Unsupported file type. Use .gguf, Ollama blob file, or .safetensors');
  }
  if (st.isDirectory()) {
    const files = fs.readdirSync(abs).map(n => n.toLowerCase());
    const hasSafetensors = files.some(f => f.endsWith('.safetensors'));
    const hasConfig = files.includes('config.json');
    if (hasSafetensors && hasConfig) return { kind: 'safetensors_model', absPath: abs };
    if (hasSafetensors) return { kind: 'safetensors_dir', absPath: abs };
    throw new Error('Directory does not look like a safetensors model (missing *.safetensors)');
  }
  throw new Error('Unsupported source path');
}

function sanitizeModelName(inputName, fallbackName = 'imported-model') {
  const raw = String(inputName || '').trim() || fallbackName;
  return raw.toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallbackName;
}

function toQuotedPosix(p) {
  return `"${String(p).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function buildModelfileFromSource(sourceMeta, options = {}) {
  const lines = [];
  if (sourceMeta.kind === 'gguf') {
    lines.push(`FROM ${toQuotedPosix(sourceMeta.absPath)}`);
  } else if (sourceMeta.kind === 'safetensors_model' || sourceMeta.kind === 'safetensors_dir') {
    lines.push(`FROM ${toQuotedPosix(sourceMeta.absPath)}`);
  } else if (sourceMeta.kind === 'adapter') {
    const base = String(options.base || '').trim();
    if (!base) {
      throw new Error('Adapter import requires --base model (e.g. qwen2.5:7b)');
    }
    lines.push(`FROM ${base}`);
    lines.push(`ADAPTER ${toQuotedPosix(sourceMeta.absPath)}`);
  } else {
    throw new Error(`Unsupported import kind: ${sourceMeta.kind}`);
  }

  if (options.systemPrompt) {
    const sys = String(options.systemPrompt).replace(/"/g, '\\"');
    lines.push(`SYSTEM "${sys}"`);
  }

  const temperature = Number(options.temperature);
  if (!Number.isNaN(temperature)) lines.push(`PARAMETER temperature ${temperature}`);
  const topP = Number(options.topP);
  if (!Number.isNaN(topP)) lines.push(`PARAMETER top_p ${topP}`);
  const numCtx = Number(options.numCtx);
  if (!Number.isNaN(numCtx)) lines.push(`PARAMETER num_ctx ${numCtx}`);

  return lines.join('\n') + '\n';
}

/**
 * Import local model files/directories into Ollama via temporary Modelfile.
 *
 * @param {string} sourcePath - local file/dir path
 * @param {string} modelName - target ollama model name
 * @param {object} [options]
 * @param {string} [options.base] - required when importing adapter safetensors
 * @param {string} [options.systemPrompt]
 * @param {number} [options.temperature]
 * @param {number} [options.topP]
 * @param {number} [options.numCtx]
 */
async function importModel(sourcePath, modelName, options = {}) {
  const source = inferImportSource(sourcePath);
  const target = sanitizeModelName(modelName, path.basename(source.absPath).replace(/\.[^.]+$/, ''));
  const modelfileText = buildModelfileFromSource(source, options);

  return withTempDir((scratchDir) => {
    const tmpModelfile = path.join(scratchDir, 'Modelfile');
    fs.writeFileSync(tmpModelfile, modelfileText, 'utf-8');

    try {
      const createResult = spawnSync(OLLAMA_BIN, ['create', target, '-f', tmpModelfile], {
        encoding: 'utf-8',
        timeout: 20 * 60 * 1000,
        stdio: 'pipe',
        windowsHide: true,
      });
      if (createResult.error || createResult.status !== 0) {
        const errText = String(createResult.error?.message || createResult.stderr || createResult.stdout || '').trim();
        return {
          success: false,
          model: target,
          source: source.absPath,
          sourceKind: source.kind,
          modelfile: modelfileText,
          error: errText || `ollama create failed (exit=${createResult.status})`,
        };
      }
      return {
        success: true,
        model: target,
        source: source.absPath,
        sourceKind: source.kind,
        modelfile: modelfileText,
        message: `Model imported: ${target}`,
      };
    } catch (err) {
      return {
        success: false,
        model: target,
        source: source.absPath,
        sourceKind: source.kind,
        modelfile: modelfileText,
        error: err.message || String(err),
      };
    }
  }, { prefix: 'ollama-import' });
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
  ensureOllamaRunning,
  listModels,
  pullModel,
  importModel,
  inferImportSource,
  buildModelfileFromSource,
  sanitizeModelName,
  deleteModel,
  detectHardware,
  getRecommendations,
  RECOMMENDATIONS,
};
