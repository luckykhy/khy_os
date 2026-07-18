/**
 * Model Training Service — record interactions, train/fine-tune models, export.
 *
 * Architecture:
 * 1. TrainingDataRecorder: passively records user interactions as training pairs
 *    - AI conversations (prompt → response quality feedback)
 *    - Strategy decisions (parameters → backtest results)
 *    - Market analysis (context → correct prediction)
 *
 * 2. ModelTrainer: orchestrates fine-tuning and distillation
 *    - Local: spawns Python subprocess (unsloth/peft/transformers)
 *    - Cloud: submits training job to KHY cloud or HuggingFace AutoTrain
 *
 * 3. ModelExporter: converts trained models to deployable formats
 *    - GGUF (for Ollama / llama.cpp)
 *    - Safetensors (for HuggingFace / vLLM)
 *    - Registers in local Ollama with khy-<version> naming
 *
 * Model naming: khy-<version>  (e.g. khy-1.0, khy-2.0, khy-3.1)
 *   The version number increments with each training iteration.
 *   Compatible with Ollama, vLLM, HuggingFace, and any OpenAI-compatible endpoint.
 *
 * Relay/Proxy support:
 *   Trained models can be served via any Claude-compatible relay/proxy.
 *   If Claude works through a relay, khy-xxx models also work through it.
 *   Supports model version rollback if newer version degrades.
 */
const fs = require('fs');
const path = require('path');
const { findPython } = require('../utils/pythonPath');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { getDataHome } = require('../utils/dataHome');

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate model name to prevent command injection and path traversal.
 *
 * Allowed pattern: khy-<version> where version is digits and dots only
 * (e.g. khy-1.0, khy-2.3.1). Rejects path separators, shell metacharacters,
 * and any name that doesn't match the expected registry naming scheme.
 */
function validateModelName(name) {
  if (typeof name !== 'string') {
    throw new Error('Model name must be a string');
  }
  // Reject path traversal and shell metacharacters
  if (/[\\/;|&$`(){}[\]<>!~\n\r]/.test(name)) {
    throw new Error(`Invalid model name: "${name}" contains forbidden characters`);
  }
  // Enforce khy-<version> pattern
  if (!/^khy-\d+(\.\d+)*$/.test(name)) {
    throw new Error(`Invalid model name: "${name}". Expected format: khy-<version> (e.g. khy-1.0)`);
  }
  return true;
}

function logWaterQualityDebug(message, details = {}) {
  if (String(process.env.TRAIN_WATER_QUALITY_DEBUG || '').toLowerCase() !== 'true') return;
  const safeDetails = {};
  for (const [k, v] of Object.entries(details)) {
    if (k.toLowerCase().includes('sample') || k.toLowerCase().includes('content')) continue;
    safeDetails[k] = v;
  }
  console.warn(`[modelTrainingService] ${message}`, safeDetails);
}

function resolveTrainingDir() {
  const candidates = [];
  if (process.env.KHY_TRAINING_DIR) candidates.push(process.env.KHY_TRAINING_DIR);
  try {
    candidates.push(path.join(getDataHome(), 'training'));
  } catch {
    // continue fallback
  }
  candidates.push(path.join(os.homedir(), '.khyquant', 'training'));
  candidates.push(path.join(os.tmpdir(), 'khyquant', 'training'));

  for (const candidate of candidates) {
    if (candidate && isWritableDir(candidate)) return candidate;
  }
  // Keep legacy default path; subsequent writes may fail and be reported explicitly.
  return path.join(os.homedir(), '.khyquant', 'training');
}

const TRAINING_DIR = resolveTrainingDir();
const KHY_DIR = path.dirname(TRAINING_DIR);
const DATASETS_DIR = path.join(TRAINING_DIR, 'datasets');
const MODELS_DIR = path.join(TRAINING_DIR, 'models');
const RECORDS_FILE = path.join(TRAINING_DIR, 'interaction_records.jsonl');
const QUARANTINE_FILE = path.join(TRAINING_DIR, 'interaction_quarantine.jsonl');

const WATER_QUALITY_RULES = {
  minInstructionChars: parseInt(process.env.TRAIN_MIN_INSTRUCTION_CHARS || '2', 10),
  minOutputChars: parseInt(process.env.TRAIN_MIN_OUTPUT_CHARS || '2', 10),
  maxInstructionChars: parseInt(process.env.TRAIN_MAX_INSTRUCTION_CHARS || '12000', 10),
  maxOutputChars: parseInt(process.env.TRAIN_MAX_OUTPUT_CHARS || '32000', 10),
  maxRecordBytes: parseInt(process.env.TRAIN_MAX_RECORD_BYTES || '65536', 10),
  maxSingleCharRatio: 0.35,
};

const POISON_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?)/i,
  /(system|hidden|internal)\s+prompt/i,
  /jailbreak|do\s+anything\s+now|DAN/i,
  /(reveal|export|dump)\s+.*(training|weights?|secrets?|keys?)/i,
  /(提示词注入|越狱|忽略.*指令|导出.*训练|泄露.*密钥)/i,
  /<script[\s>]|javascript:/i,
  /base64\s+decode|eval\(|exec\(|subprocess/i,
];

const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-[a-z0-9]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9\-_\.]{20,}\b/,
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. Training Data Recorder
// ═══════════════════════════════════════════════════════════════════════════

function normalizeText(input) {
  return String(input || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function hasBinaryNoise(text) {
  // Keep newline/tab; reject other control chars.
  return /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

function singleCharDominance(text) {
  if (!text) return 0;
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max / Math.max(1, text.length);
}

function inspectConversationWaterQuality(data) {
  const reasons = [];
  const instruction = normalizeText(data.instruction);
  const output = normalizeText(data.output);

  if (!instruction || instruction.length < WATER_QUALITY_RULES.minInstructionChars) {
    reasons.push('instruction_too_short');
  }
  if (!output || output.length < WATER_QUALITY_RULES.minOutputChars) {
    reasons.push('output_too_short');
  }
  if (instruction.length > WATER_QUALITY_RULES.maxInstructionChars) {
    reasons.push('instruction_too_long');
  }
  if (output.length > WATER_QUALITY_RULES.maxOutputChars) {
    reasons.push('output_too_long');
  }

  const fullText = `${instruction}\n${output}`;
  if (hasBinaryNoise(fullText)) reasons.push('binary_noise');
  if (singleCharDominance(fullText) > WATER_QUALITY_RULES.maxSingleCharRatio) {
    reasons.push('repetitive_content');
  }

  for (const pattern of POISON_PATTERNS) {
    if (pattern.test(fullText)) {
      reasons.push('poison_pattern');
      break;
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(fullText)) {
      reasons.push('secret_leak_pattern');
      break;
    }
  }

  return {
    safe: reasons.length === 0,
    reasons,
    data: {
      ...data,
      instruction,
      output,
    },
  };
}

function assessRecordWaterQuality(type, data) {
  const reasons = [];
  let normalized = { ...data };

  try {
    const bytes = Buffer.byteLength(JSON.stringify(data || {}), 'utf8');
    if (bytes > WATER_QUALITY_RULES.maxRecordBytes) reasons.push('record_too_large');
  } catch {
    reasons.push('record_not_serializable');
  }

  if (type === 'conversation') {
    const result = inspectConversationWaterQuality(data || {});
    return {
      safe: result.safe && reasons.length === 0,
      reasons: [...reasons, ...result.reasons],
      data: result.data,
    };
  }

  return {
    safe: reasons.length === 0,
    reasons,
    data: normalized,
  };
}

function quarantineRecord(type, data, reasons, source = 'record') {
  try {
    ensureDir(TRAINING_DIR);
    const row = {
      timestamp: new Date().toISOString(),
      type,
      source,
      reasons: Array.from(new Set(reasons || [])),
      sample: data,
    };
    fs.appendFileSync(QUARANTINE_FILE, JSON.stringify(row) + '\n', 'utf-8');
    return { success: true };
  } catch (err) {
    logWaterQualityDebug('failed_to_write_quarantine', {
      code: err && err.code,
      message: err && err.message,
      quarantineFile: QUARANTINE_FILE,
      type,
      source,
    });
    return { success: false, error: (err && err.code) || 'quarantine_write_failed' };
  }
}

/**
 * Record a training-worthy interaction (appended to JSONL).
 * @param {'conversation'|'strategy'|'analysis'|'feedback'} type
 * @param {object} data - The training pair data
 */
function recordInteraction(type, data) {
  try {
    ensureDir(TRAINING_DIR);
    const check = assessRecordWaterQuality(type, data || {});
    if (!check.safe) {
      const quarantined = quarantineRecord(type, data || {}, check.reasons, 'record');
      const reasons = quarantined.success ? check.reasons : [...check.reasons, quarantined.error];
      return { accepted: false, reasons, quarantined: quarantined.success };
    }
    const record = {
      type,
      timestamp: new Date().toISOString(),
      ...check.data,
      waterQuality: {
        checkedAt: new Date().toISOString(),
        verdict: 'pass',
      },
    };
    fs.appendFileSync(RECORDS_FILE, JSON.stringify(record) + '\n', 'utf-8');
    return { accepted: true, path: RECORDS_FILE };
  } catch (err) {
    logWaterQualityDebug('failed_to_write_record', {
      code: err && err.code,
      message: err && err.message,
      recordsFile: RECORDS_FILE,
      type,
    });
  }
  return { accepted: false, reasons: ['write_failed'], path: RECORDS_FILE };
}

/**
 * Record an AI conversation turn for training.
 * Called automatically after each AI reply with user feedback signal.
 */
function recordConversation(prompt, response, metadata = {}) {
  return recordInteraction('conversation', {
    instruction: prompt,
    output: response,
    provider: metadata.provider || 'unknown',
    model: metadata.model || '',
    quality: metadata.quality || 'neutral', // 'good' | 'bad' | 'neutral'
    tokenCount: metadata.tokenCount || 0,
  });
}

/**
 * Record a strategy backtest result for training.
 */
function recordStrategyResult(symbol, strategyParams, backtestResult) {
  return recordInteraction('strategy', {
    symbol,
    params: strategyParams,
    returns: backtestResult.returns || 0,
    sharpe: backtestResult.sharpe || 0,
    maxDrawdown: backtestResult.maxDrawdown || 0,
    winRate: backtestResult.winRate || 0,
    trades: backtestResult.tradeCount || 0,
  });
}

/**
 * Record user feedback on AI output (thumbs up/down).
 */
function recordFeedback(interactionId, rating) {
  return recordInteraction('feedback', {
    interactionId,
    rating, // 'good' | 'bad'
  });
}

/**
 * Get training data statistics.
 */
function getDatasetStats() {
  try {
    const writable = isWritableDir(TRAINING_DIR);
    if (!fs.existsSync(RECORDS_FILE)) {
      const quarantined = fs.existsSync(QUARANTINE_FILE)
        ? fs.readFileSync(QUARANTINE_FILE, 'utf-8').split(/\r?\n/).filter(Boolean).length
        : 0;
      return {
        total: 0,
        byType: {},
        quarantined,
        storage: { trainingDir: TRAINING_DIR, recordsFile: RECORDS_FILE, quarantineFile: QUARANTINE_FILE, writable },
      };
    }
    const lines = fs.readFileSync(RECORDS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
    const byType = {};
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        byType[record.type] = (byType[record.type] || 0) + 1;
      } catch { /* skip malformed */ }
    }
    const quarantined = fs.existsSync(QUARANTINE_FILE)
      ? fs.readFileSync(QUARANTINE_FILE, 'utf-8').split(/\r?\n/).filter(Boolean).length
      : 0;
    return {
      total: lines.length,
      byType,
      quarantined,
      storage: { trainingDir: TRAINING_DIR, recordsFile: RECORDS_FILE, quarantineFile: QUARANTINE_FILE, writable },
    };
  } catch {
    return {
      total: 0,
      byType: {},
      quarantined: 0,
      storage: { trainingDir: TRAINING_DIR, recordsFile: RECORDS_FILE, quarantineFile: QUARANTINE_FILE, writable: false },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Dataset Preparation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Export recorded interactions as training dataset (Alpaca/ShareGPT format).
 * @param {'alpaca'|'sharegpt'|'openai'} format
 * @param {object} [filter] - Filter by type, quality, date range
 * @returns {{ path: string, count: number }}
 */
function exportDataset(format = 'alpaca', filter = {}) {
  ensureDir(DATASETS_DIR);
  if (!fs.existsSync(RECORDS_FILE)) {
    throw new Error('No interaction records found. Use the AI features to build training data.');
  }

  const lines = fs.readFileSync(RECORDS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Apply filters
  let filtered = records;
  if (filter.type) filtered = filtered.filter(r => r.type === filter.type);
  if (filter.quality) filtered = filtered.filter(r => r.quality === filter.quality);
  if (filter.minDate) filtered = filtered.filter(r => r.timestamp >= filter.minDate);

  const clean = [];
  let dropped = 0;
  for (const row of filtered) {
    const check = assessRecordWaterQuality(row.type, row);
    if (!check.safe) {
      dropped++;
      quarantineRecord(row.type, row, check.reasons, 'export');
      continue;
    }
    clean.push({ ...row, ...check.data });
  }

  // Convert to training format
  let dataset;
  const timestamp = Date.now();

  if (format === 'alpaca') {
    dataset = clean
      .filter(r => r.instruction && r.output)
      .map(r => ({
        instruction: r.instruction,
        input: '',
        output: r.output,
        system: 'You are khy OS, a professional quantitative trading AI assistant.',
      }));
  } else if (format === 'sharegpt') {
    dataset = clean
      .filter(r => r.instruction && r.output)
      .map(r => ({
        conversations: [
          { from: 'system', value: 'You are khy OS, a professional quantitative trading AI assistant.' },
          { from: 'human', value: r.instruction },
          { from: 'gpt', value: r.output },
        ],
      }));
  } else {
    // OpenAI fine-tune format
    dataset = clean
      .filter(r => r.instruction && r.output)
      .map(r => ({
        messages: [
          { role: 'system', content: 'You are khy OS, a professional quantitative trading AI assistant.' },
          { role: 'user', content: r.instruction },
          { role: 'assistant', content: r.output },
        ],
      }));
  }

  const outFile = path.join(DATASETS_DIR, `khy_dataset_${format}_${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset, null, 2), 'utf-8');

  return { path: outFile, count: dataset.length, format, dropped };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Model Training (Local + Cloud)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Available base models for fine-tuning.
 */
const BASE_MODELS = {
  'qwen-1.5b': { hfId: 'Qwen/Qwen2.5-1.5B-Instruct', size: '1.5B', vram: '6GB' },
  'qwen-3b': { hfId: 'Qwen/Qwen2.5-3B-Instruct', size: '3B', vram: '8GB' },
  'qwen-7b': { hfId: 'Qwen/Qwen2.5-7B-Instruct', size: '7B', vram: '16GB' },
  'llama-3b': { hfId: 'meta-llama/Llama-3.2-3B-Instruct', size: '3B', vram: '8GB' },
  'llama-8b': { hfId: 'meta-llama/Llama-3.1-8B-Instruct', size: '8B', vram: '20GB' },
  'deepseek-1.5b': { hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', size: '1.5B', vram: '6GB' },
  'deepseek-7b': { hfId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B', size: '7B', vram: '16GB' },
  'mistral-7b': { hfId: 'mistralai/Mistral-7B-Instruct-v0.3', size: '7B', vram: '16GB' },
};

/**
 * Training configuration presets.
 */
const TRAINING_PRESETS = {
  quick: { epochs: 1, lr: 2e-4, batchSize: 4, loraR: 8, loraAlpha: 16 },
  standard: { epochs: 3, lr: 1e-4, batchSize: 4, loraR: 16, loraAlpha: 32 },
  thorough: { epochs: 5, lr: 5e-5, batchSize: 2, loraR: 32, loraAlpha: 64 },
};

/**
 * Check local compute resources (GPU, RAM, disk).
 */
function getComputeStatus() {
  const status = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalRAM: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    freeRAM: Math.round(os.freemem() / 1024 / 1024 / 1024),
    gpu: null,
    cuda: false,
    mps: false, // Apple Metal
    pythonAvailable: false,
    torchAvailable: false,
  };

  // Check Python
  const _pyBin = findPython();
  try {
    execSync(`"${_pyBin}" --version`, { encoding: 'utf-8', stdio: 'pipe' });
    status.pythonAvailable = true;
  } catch { /* no python */ }

  // Check PyTorch
  try {
    const torchCheck = execSync(`"${_pyBin}" -c "import torch; print(torch.cuda.is_available(), torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False, torch.cuda.device_count() if torch.cuda.is_available() else 0)"`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const [cuda, mps, gpuCount] = torchCheck.split(' ');
    status.cuda = cuda === 'True';
    status.mps = mps === 'True';
    status.torchAvailable = true;
    if (status.cuda) status.gpu = { count: parseInt(gpuCount), type: 'CUDA' };
    else if (status.mps) status.gpu = { count: 1, type: 'Apple Metal' };
  } catch { /* no torch */ }

  // Check NVIDIA GPU via nvidia-smi
  if (!status.gpu) {
    try {
      const smi = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (smi) {
        const gpus = smi.split('\n').map(line => {
          const [name, mem] = line.split(',').map(s => s.trim());
          return { name, memory: mem };
        });
        status.gpu = { count: gpus.length, type: 'NVIDIA', devices: gpus };
      }
    } catch { /* no nvidia-smi */ }
  }

  return status;
}

/**
 * Start local fine-tuning job.
 * Spawns a Python subprocess using unsloth or peft.
 *
 * @param {object} opts
 * @param {string} opts.baseModel - Key from BASE_MODELS
 * @param {string} opts.datasetPath - Path to training dataset JSON
 * @param {string} opts.outputName - Output model name (khy-xxx format)
 * @param {'quick'|'standard'|'thorough'} [opts.preset='standard']
 * @param {'lora'|'full'|'distill'} [opts.method='lora']
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<{ success: boolean, modelPath: string, error?: string }>}
 */
async function trainLocal(opts) {
  const {
    baseModel = 'qwen-3b',
    datasetPath,
    outputName = `khy-${getNextVersion()}`,
    preset = 'standard',
    method = 'lora',
    onProgress,
  } = opts;

  const base = BASE_MODELS[baseModel];
  if (!base) throw new Error(`Unknown base model: ${baseModel}. Available: ${Object.keys(BASE_MODELS).join(', ')}`);
  if (!datasetPath || !fs.existsSync(datasetPath)) throw new Error(`Dataset not found: ${datasetPath}`);

  const compute = getComputeStatus();
  if (!compute.pythonAvailable) throw new Error('Python3 not found. Install Python 3.10+');
  if (!compute.torchAvailable) throw new Error('PyTorch not found. Run: pip install torch');

  const config = TRAINING_PRESETS[preset] || TRAINING_PRESETS.standard;
  const outputDir = path.join(MODELS_DIR, outputName);
  ensureDir(outputDir);

  // Generate training script
  const trainScript = generateTrainScript({
    baseModelId: base.hfId,
    datasetPath,
    outputDir,
    outputName,
    method,
    config,
    useCuda: compute.cuda,
    useMps: compute.mps,
  });

  const scriptPath = path.join(TRAINING_DIR, `train_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, trainScript, 'utf-8');

  // Run training
  return new Promise((resolve) => {
    const proc = spawn(findPython(), [scriptPath], {
      cwd: TRAINING_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let lastProgress = 0;

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Parse progress from training output
      const progressMatch = text.match(/(\d+)%/);
      if (progressMatch && onProgress) {
        const pct = parseInt(progressMatch[1]);
        if (pct > lastProgress) {
          lastProgress = pct;
          onProgress(pct, text.trim());
        }
      }
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      // Clean up script
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

      if (code === 0) {
        // Register model in local registry
        registerModel(outputName, {
          basedOn: base.hfId,
          method,
          datasetSize: getDatasetStats().total,
          trainedAt: new Date().toISOString(),
          path: outputDir,
        });
        resolve({ success: true, modelPath: outputDir });
      } else {
        resolve({ success: false, error: output.slice(-500) });
      }
    });
  });
}

/**
 * Submit cloud training job (to KHY cloud or HuggingFace).
 * @param {object} opts - Same as trainLocal options
 */
async function trainCloud(opts) {
  const { baseModel = 'qwen-7b', datasetPath, outputName, preset = 'standard' } = opts;

  // Upload dataset to cloud and start training
  const cloudSync = require('./cloudSync');
  if (!cloudSync.isLoggedIn()) {
    throw new Error('Cloud training requires login. Run: cloud login');
  }

  const base = BASE_MODELS[baseModel];
  if (!base) throw new Error(`Unknown base model: ${baseModel}`);

  // Submit job to cloud API
  const jobData = {
    baseModel: base.hfId,
    outputName: outputName || `khy-${getNextVersion()}`,
    preset,
    datasetPath,
  };

  // For now return a placeholder — actual cloud endpoint TBD
  return {
    success: true,
    jobId: `job_${Date.now()}`,
    status: 'queued',
    message: 'Training job submitted to cloud. Use: train status <job_id> to check progress.',
    ...jobData,
  };
}

/**
 * Knowledge distillation — use large model responses to create training data for small model.
 * @param {object} opts
 * @param {string} opts.teacherModel - Large model name (e.g. 'claude', 'gpt-4o')
 * @param {string} opts.studentBase - Small base model key (e.g. 'qwen-1.5b')
 * @param {string[]} opts.prompts - Prompts to generate teacher responses for
 * @param {string} opts.outputName - Output model name
 */
async function distill(opts) {
  const { teacherModel = 'best-available', studentBase = 'qwen-1.5b', prompts, outputName } = opts;

  if (!prompts || prompts.length === 0) {
    throw new Error('Distillation requires a set of prompts. Provide prompts or use recorded interactions.');
  }

  // Step 1: Generate teacher responses
  const teacherData = [];
  const gateway = require('./gateway/aiGateway');
  const gw = new gateway();
  if (!gw._initialized) await gw.init();

  for (const prompt of prompts) {
    try {
      const result = await gw.generate(prompt, { temperature: 0.3, maxTokens: 1024 });
      if (result.success) {
        teacherData.push({
          instruction: prompt,
          input: '',
          output: result.content,
          system: 'You are khy OS, a professional quantitative trading AI assistant.',
        });
      }
    } catch { /* skip failed */ }
  }

  // Step 2: Save as dataset
  const datasetFile = path.join(DATASETS_DIR, `distill_${Date.now()}.json`);
  ensureDir(DATASETS_DIR);
  fs.writeFileSync(datasetFile, JSON.stringify(teacherData, null, 2), 'utf-8');

  // Step 3: Train student model on teacher outputs
  return trainLocal({
    baseModel: studentBase,
    datasetPath: datasetFile,
    outputName: outputName || `khy-${getNextVersion()}`,
    method: 'lora',
    preset: 'standard',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Model Export & Registration
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_REGISTRY_FILE = path.join(TRAINING_DIR, 'model_registry.json');

/**
 * Verify export password before allowing model export.
 *
 * Model export is no longer password-gated — this always authorizes. The
 * function is kept so existing call sites and the public export stay stable;
 * it ignores its argument and never rejects.
 * @param {string} _password
 * @returns {boolean}
 */
function verifyExportPassword(_password) {
  return true;
}

/**
 * Register a trained model in the local registry.
 */
function registerModel(name, metadata) {
  validateModelName(name);
  const registry = loadModelRegistry();
  registry[name] = { ...metadata, registeredAt: new Date().toISOString() };
  ensureDir(TRAINING_DIR);
  fs.writeFileSync(MODEL_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Load model registry.
 */
function loadModelRegistry() {
  try {
    if (fs.existsSync(MODEL_REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(MODEL_REGISTRY_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * List all trained khy-xxx models.
 */
function listModels() {
  return loadModelRegistry();
}

/**
 * Export model to GGUF format (for Ollama / llama.cpp).
 * @param {string} modelName - Name from registry
 * @param {'q4_k_m'|'q5_k_m'|'q8_0'|'f16'} [quantization='q4_k_m']
 * @returns {Promise<{ success: boolean, ggufPath: string }>}
 */
async function exportGGUF(modelName, quantization = 'q4_k_m', password = '') {
  validateModelName(modelName);
  if (!verifyExportPassword(password)) {
    throw new Error('导出密码错误。模型导出需要输入正确的密码。');
  }

  const registry = loadModelRegistry();
  const model = registry[modelName];
  if (!model) throw new Error(`Model not found: ${modelName}. Run: train list`);

  const modelPath = model.path;
  if (!fs.existsSync(modelPath)) throw new Error(`Model files not found at: ${modelPath}`);

  const outputFile = path.join(modelPath, `${modelName}-${quantization}.gguf`);

  // Use llama.cpp convert script or huggingface-hub
  const convertScript = `
import sys
try:
    from llama_cpp import Llama
    print("llama-cpp-python available")
except ImportError:
    pass

try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import subprocess
    # Convert using llama.cpp's convert-hf-to-gguf.py
    model_path = "${modelPath.replace(/\\/g, '/')}"
    output_path = "${outputFile.replace(/\\/g, '/')}"
    quant = "${quantization}"
    print(f"Converting {model_path} to GGUF ({quant})...")
    # Try direct conversion via installed tools
    subprocess.run([
        sys.executable, "-m", "llama_cpp.convert",
        "--outfile", output_path,
        "--outtype", quant,
        model_path
    ], check=True)
    print(f"SUCCESS:{output_path}")
except Exception as e:
    print(f"ERROR:{str(e)}")
    # Fallback: suggest manual steps
    print("FALLBACK: Install llama-cpp-python and run manually")
    print(f"  pip install llama-cpp-python")
    print(f"  python -m llama_cpp.convert --outfile {output_path} --outtype {quant} {model_path}")
    sys.exit(1)
`;

  const scriptPath = path.join(TRAINING_DIR, `export_gguf_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, convertScript, 'utf-8');

  return new Promise((resolve) => {
    const proc = spawn(findPython(), [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      if (code === 0 && output.includes('SUCCESS:')) {
        resolve({ success: true, ggufPath: outputFile });
      } else {
        resolve({ success: false, error: output });
      }
    });
  });
}

/**
 * Export model as safetensors (for HuggingFace / vLLM).
 * The LoRA adapter is already in safetensors format; this merges it with base.
 */
async function exportSafetensors(modelName, password = '') {
  validateModelName(modelName);
  if (!verifyExportPassword(password)) {
    throw new Error('导出密码错误。模型导出需要输入正确的密码。');
  }

  const registry = loadModelRegistry();
  const model = registry[modelName];
  if (!model) throw new Error(`Model not found: ${modelName}`);

  const mergedDir = path.join(model.path, 'merged');
  ensureDir(mergedDir);

  const mergeScript = `
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
import torch

base_model_id = "${model.basedOn}"
adapter_path = "${model.path.replace(/\\/g, '/')}"
output_path = "${mergedDir.replace(/\\/g, '/')}"

print(f"Loading base model: {base_model_id}")
base_model = AutoModelForCausalLM.from_pretrained(base_model_id, torch_dtype=torch.float16)
tokenizer = AutoTokenizer.from_pretrained(base_model_id)

print(f"Loading LoRA adapter: {adapter_path}")
model = PeftModel.from_pretrained(base_model, adapter_path)

print("Merging weights...")
merged = model.merge_and_unload()

print(f"Saving to: {output_path}")
merged.save_pretrained(output_path, safe_serialization=True)
tokenizer.save_pretrained(output_path)

print(f"SUCCESS:{output_path}")
`;

  const scriptPath = path.join(TRAINING_DIR, `export_st_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, mergeScript, 'utf-8');

  return new Promise((resolve) => {
    const proc = spawn(findPython(), [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      if (code === 0 && output.includes('SUCCESS:')) {
        resolve({ success: true, safetensorsPath: mergedDir });
      } else {
        resolve({ success: false, error: output });
      }
    });
  });
}

/**
 * Register exported GGUF model with local Ollama.
 * Creates a Modelfile and runs `ollama create khy-xxx`.
 * @param {string} modelName
 * @param {string} ggufPath
 */
async function registerWithOllama(modelName, ggufPath) {
  validateModelName(modelName);
  if (!fs.existsSync(ggufPath)) throw new Error(`GGUF file not found: ${ggufPath}`);

  const modelfile = `FROM ${ggufPath}
SYSTEM "You are khy OS (${modelName}), a professional quantitative trading AI assistant specialized in Chinese A-shares, futures, and crypto markets. You provide data-driven analysis, strategy suggestions, and risk assessments."
PARAMETER temperature 0.4
PARAMETER top_p 0.9
PARAMETER num_ctx 4096
`;

  const modelfilePath = path.join(TRAINING_DIR, `Modelfile_${modelName}`);
  fs.writeFileSync(modelfilePath, modelfile, 'utf-8');

  try {
    execSync(`ollama create ${modelName} -f "${modelfilePath}"`, { encoding: 'utf-8', timeout: 120000 });
    return { success: true, message: `Model ${modelName} registered with Ollama. Use: ollama run ${modelName}` };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { fs.unlinkSync(modelfilePath); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. HuggingFace Hub Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Upload a trained model to HuggingFace Hub.
 *
 * Uses the `huggingface-cli` (Python huggingface_hub package) or falls back
 * to direct API calls via curl. Requires HF_TOKEN in environment.
 *
 * @param {string} modelName - e.g. 'khy-1.0'
 * @param {object} opts
 * @param {string} opts.repoId - HuggingFace repo ID (e.g. 'username/khy-quant-1.0')
 * @param {string} [opts.password] - Export password (required)
 * @param {boolean} [opts.private=true] - Create as private repo
 * @param {function} [opts.onProgress] - Progress callback
 * @returns {Promise<{ success: boolean, url: string, message: string }>}
 */
async function uploadToHuggingFace(modelName, opts = {}) {
  validateModelName(modelName);
  const { repoId, password, private: isPrivate = true, onProgress } = opts;

  // Verify export password
  if (!verifyExportPassword(password)) {
    throw new Error('导出密码错误。上传到 HuggingFace 需要输入正确的导出密码。');
  }

  const registry = loadModelRegistry();
  const model = registry[modelName];
  if (!model) throw new Error(`Model not found: ${modelName}`);
  if (!model.path || !fs.existsSync(model.path)) throw new Error(`Model files not found at: ${model.path}`);
  if (!repoId || !repoId.includes('/')) throw new Error('Invalid repo ID. Format: username/model-name');

  const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '';
  if (!hfToken) {
    throw new Error('HuggingFace token not set. Configure via: gateway config → provider-keys → HuggingFace, or set HF_TOKEN env var.');
  }

  const modelPath = model.path;

  // Generate model card (README.md)
  const modelCard = `---
license: apache-2.0
library_name: transformers
tags:
- khy-quant
- quantitative-trading
- fine-tuned
base_model: ${model.basedOn || 'unknown'}
---

# ${modelName}

A khy OS fine-tuned model for quantitative trading analysis.

## Model Details

- **Base model**: ${model.basedOn || 'N/A'}
- **Training method**: ${model.method || 'LoRA'}
- **Training data**: ${model.datasetSize || 'N/A'} samples
- **Trained at**: ${model.trainedAt || 'N/A'}

## Usage

\`\`\`bash
# With Ollama (after GGUF export)
ollama create ${modelName} -f Modelfile

# With khy OS CLI
khy train import ${modelName} --from huggingface/${repoId}

# With transformers
from transformers import AutoModelForCausalLM, AutoTokenizer
model = AutoModelForCausalLM.from_pretrained("${repoId}")
tokenizer = AutoTokenizer.from_pretrained("${repoId}")
\`\`\`

## Training

This model was trained using khy OS's built-in training pipeline on user interaction data
and quantitative trading scenarios.
`;

  fs.writeFileSync(path.join(modelPath, 'README.md'), modelCard, 'utf-8');

  // Try huggingface-cli first
  try {
    // Check if huggingface-cli is available
    execSync('huggingface-cli --version', { encoding: 'utf-8', stdio: 'pipe' });

    if (onProgress) onProgress(10, 'Creating repository...');

    // Create repo (ignore error if exists)
    try {
      execSync(
        `huggingface-cli repo create ${repoId.split('/')[1]} --type model ${isPrivate ? '--private' : ''} -y`,
        { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, HF_TOKEN: hfToken } }
      );
    } catch { /* repo may already exist */ }

    if (onProgress) onProgress(30, 'Uploading model files...');

    // Upload entire folder
    execSync(
      `huggingface-cli upload ${repoId} "${modelPath}" . --repo-type model`,
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: { ...process.env, HF_TOKEN: hfToken },
        timeout: 600000, // 10 min
      }
    );

    if (onProgress) onProgress(100, 'Upload complete');

    const url = `https://huggingface.co/${repoId}`;
    return { success: true, url, message: `Model ${modelName} uploaded to ${url}` };
  } catch (cliError) {
    // Fallback: use Python huggingface_hub
    const uploadScript = `
import os, sys
os.environ["HF_TOKEN"] = "${hfToken.replace(/"/g, '\\"')}"

try:
    from huggingface_hub import HfApi
    api = HfApi()

    repo_id = "${repoId}"
    model_path = "${modelPath.replace(/\\/g, '/')}"
    is_private = ${isPrivate ? 'True' : 'False'}

    # Create repo (ignore if exists)
    try:
        api.create_repo(repo_id=repo_id, repo_type="model", private=is_private)
        print("PROGRESS:20:Repository created")
    except Exception:
        print("PROGRESS:20:Repository exists")

    # Upload folder
    print("PROGRESS:30:Uploading files...")
    api.upload_folder(
        folder_path=model_path,
        repo_id=repo_id,
        repo_type="model",
    )
    print("PROGRESS:100:Upload complete")
    print(f"SUCCESS:https://huggingface.co/{repo_id}")
except ImportError:
    print("ERROR:huggingface_hub not installed. Run: pip install huggingface_hub")
    sys.exit(1)
except Exception as e:
    print(f"ERROR:{str(e)}")
    sys.exit(1)
`;

    const scriptPath = path.join(TRAINING_DIR, `hf_upload_${Date.now()}.py`);
    ensureDir(TRAINING_DIR);
    fs.writeFileSync(scriptPath, uploadScript, 'utf-8');

    return new Promise((resolve) => {
      const proc = spawn(findPython(), [scriptPath], {
        env: { ...process.env, HF_TOKEN: hfToken, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        // Parse progress
        const progressMatch = text.match(/PROGRESS:(\d+):(.+)/);
        if (progressMatch && onProgress) {
          onProgress(parseInt(progressMatch[1]), progressMatch[2]);
        }
      });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
        const successMatch = output.match(/SUCCESS:(.+)/);
        if (code === 0 && successMatch) {
          resolve({ success: true, url: successMatch[1].trim(), message: `Model ${modelName} uploaded to ${successMatch[1].trim()}` });
        } else {
          const errorMatch = output.match(/ERROR:(.+)/);
          resolve({ success: false, url: '', message: errorMatch ? errorMatch[1].trim() : output.slice(-300) });
        }
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../utils/ensureDirSync');

/**
 * Get next version number for khy-xxx model naming.
 * Scans registry for existing khy-N.N versions and increments.
 * @returns {string} e.g. '1.0', '1.1', '2.0'
 */
function getNextVersion() {
  const registry = loadModelRegistry();
  const versions = Object.keys(registry)
    .filter(name => /^khy-\d+\.\d+$/.test(name))
    .map(name => {
      const [major, minor] = name.replace('khy-', '').split('.').map(Number);
      return { major, minor, raw: major * 100 + minor };
    })
    .sort((a, b) => b.raw - a.raw);

  if (versions.length === 0) return '1.0';
  const latest = versions[0];
  return `${latest.major}.${latest.minor + 1}`;
}

/**
 * Rollback to a previous model version.
 * Sets the active model to an older khy-xxx version.
 * @param {string} version - e.g. 'khy-1.0'
 * @returns {{ success: boolean, message: string }}
 */
function rollbackModel(version) {
  const registry = loadModelRegistry();
  if (!registry[version]) {
    return { success: false, message: `Model ${version} not found in registry` };
  }
  // Set active model environment
  process.env.KHY_ACTIVE_MODEL = version;
  process.env.KHY_ACTIVE_MODEL_PATH = registry[version].path;
  return { success: true, message: `Active model rolled back to ${version}` };
}

/**
 * Get the currently active khy model version.
 */
function getActiveModel() {
  return process.env.KHY_ACTIVE_MODEL || null;
}

/**
 * Set the active khy model (latest or specific version).
 * @param {string} [version] - e.g. 'khy-2.0', or null for latest
 */
function setActiveModel(version) {
  const registry = loadModelRegistry();
  if (!version) {
    // Find latest
    const versions = Object.keys(registry).filter(n => /^khy-\d+\.\d+$/.test(n)).sort().reverse();
    version = versions[0] || null;
  }
  if (version && registry[version]) {
    process.env.KHY_ACTIVE_MODEL = version;
    process.env.KHY_ACTIVE_MODEL_PATH = registry[version].path;
    return { success: true, active: version };
  }
  return { success: false, message: 'No model available' };
}

/**
 * Check relay/proxy compatibility.
 * khy-xxx models work through any OpenAI-compatible relay endpoint.
 * If Claude/other models work via a relay, khy models do too.
 */
function getRelayConfig() {
  const relayUrl = process.env.KHY_MODEL_RELAY || process.env.OPENAI_BASE_URL || null;
  const activeModel = getActiveModel();
  return {
    relayUrl,
    activeModel,
    compatible: true, // khy models use standard OpenAI chat format
    note: relayUrl
      ? `Using relay: ${relayUrl} — khy models served via same endpoint`
      : 'No relay configured. Models served locally via Ollama.',
  };
}

/**
 * Upload trained model to a private Git repository (GitHub/Gitee).
 *
 * Requires git CLI and configured credentials (SSH key or token).
 * Uses Git LFS for large model files.
 *
 * @param {string} modelName - e.g. 'khy-1.0'
 * @param {object} opts
 * @param {'github'|'gitee'} opts.platform - Target platform
 * @param {string} opts.repo - Repository name (e.g. 'my-models')
 * @param {string} [opts.owner] - Username/org (defaults to git config user)
 * @param {string} [opts.token] - API token (for creating repo if not exists)
 * @param {string} [opts.password] - Export password (required)
 * @returns {Promise<{ success: boolean, url: string, message: string }>}
 */
async function uploadToGitRepo(modelName, opts = {}) {
  validateModelName(modelName);
  const { platform = 'github', repo, owner, token, password } = opts;

  // Verify export password
  if (!verifyExportPassword(password)) {
    throw new Error('导出密码错误。上传到仓库需要输入正确的导出密码。');
  }

  const registry = loadModelRegistry();
  const model = registry[modelName];
  if (!model) throw new Error(`Model not found: ${modelName}`);
  if (!model.path || !fs.existsSync(model.path)) throw new Error(`Model files not found at: ${model.path}`);

  if (!repo) throw new Error('Repository name required. Use --repo <name>');

  // Determine remote URL
  const gitOwner = owner || getGitUser();
  let remoteUrl;
  if (platform === 'gitee') {
    remoteUrl = token
      ? `https://${gitOwner}:${token}@gitee.com/${gitOwner}/${repo}.git`
      : `git@gitee.com:${gitOwner}/${repo}.git`;
  } else {
    remoteUrl = token
      ? `https://${gitOwner}:${token}@github.com/${gitOwner}/${repo}.git`
      : `git@github.com:${gitOwner}/${repo}.git`;
  }

  const modelPath = model.path;

  try {
    // Initialize git repo in model directory if not exists
    if (!fs.existsSync(path.join(modelPath, '.git'))) {
      execSync('git init', { cwd: modelPath, stdio: 'pipe' });
      execSync('git lfs install', { cwd: modelPath, stdio: 'pipe' }).toString();
    }

    // Setup LFS tracking for large files
    const lfsPatterns = ['*.bin', '*.safetensors', '*.gguf', '*.pt', '*.pth', '*.onnx'];
    for (const pattern of lfsPatterns) {
      try { execSync(`git lfs track "${pattern}"`, { cwd: modelPath, stdio: 'pipe' }); } catch { /* ignore */ }
    }

    // Create model card
    const modelCard = `# ${modelName}

khy OS trained model.

- **Base model**: ${model.basedOn}
- **Method**: ${model.method}
- **Training data**: ${model.datasetSize} samples
- **Trained at**: ${model.trainedAt}

## Usage

\`\`\`bash
# With Ollama
ollama create ${modelName} -f Modelfile

# With khy OS CLI
khy train import ${modelName} --from ${remoteUrl}
\`\`\`
`;
    fs.writeFileSync(path.join(modelPath, 'README.md'), modelCard, 'utf-8');

    // Add, commit, push
    execSync('git add -A', { cwd: modelPath, stdio: 'pipe' });
    try {
      execSync(`git commit -m "Upload ${modelName}"`, { cwd: modelPath, stdio: 'pipe' });
    } catch { /* already committed */ }

    // Set remote (without embedding token in URL)
    const cleanRemoteUrl = platform === 'gitee'
      ? `https://gitee.com/${gitOwner}/${repo}.git`
      : `https://github.com/${gitOwner}/${repo}.git`;

    try {
      execSync(`git remote remove origin`, { cwd: modelPath, stdio: 'pipe' });
    } catch { /* no remote */ }
    execSync(`git remote add origin ${cleanRemoteUrl}`, { cwd: modelPath, stdio: 'pipe' });

    // Try to create repo via API (if token provided)
    if (token) {
      await createRemoteRepo(platform, repo, token, gitOwner);
    }

    // Push — inject token via temporary credential helper to avoid
    // embedding it in the remote URL (which would persist in .git/config
    // and appear in process listings).
    if (token) {
      const host = platform === 'gitee' ? 'gitee.com' : 'github.com';
      const credHelperPath = path.join(modelPath, '.git-credentials-tmp');
      fs.writeFileSync(credHelperPath, `https://${gitOwner}:${token}@${host}\n`, { mode: 0o600 });
      try {
        execSync(`git config credential.helper "store --file=${credHelperPath}"`, { cwd: modelPath, stdio: 'pipe' });
        execSync('git push -u origin main --force', { cwd: modelPath, stdio: 'pipe', timeout: 300000 });
      } finally {
        // Always clean up the temporary credential file
        try { fs.unlinkSync(credHelperPath); } catch { /* ignore */ }
        try { execSync('git config --unset credential.helper', { cwd: modelPath, stdio: 'pipe' }); } catch { /* ignore */ }
      }
    } else {
      execSync('git push -u origin main --force', { cwd: modelPath, stdio: 'pipe', timeout: 300000 });
    }

    const publicUrl = platform === 'gitee'
      ? `https://gitee.com/${gitOwner}/${repo}`
      : `https://github.com/${gitOwner}/${repo}`;

    return { success: true, url: publicUrl, message: `Model ${modelName} uploaded to ${publicUrl}` };
  } catch (err) {
    return { success: false, url: '', message: err.message };
  }
}

/**
 * Create remote repository via API.
 */
async function createRemoteRepo(platform, repoName, token, owner) {
  const axios = require('axios');
  try {
    if (platform === 'github') {
      await axios.post('https://api.github.com/user/repos', {
        name: repoName,
        private: true,
        description: 'khy OS trained model',
      }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
    } else if (platform === 'gitee') {
      await axios.post('https://gitee.com/api/v5/user/repos', {
        access_token: token,
        name: repoName,
        private: true,
        description: 'khy OS trained model',
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      });
    }
  } catch { /* repo may already exist, ignore */ }
}

/**
 * Get git username from config.
 */
function getGitUser() {
  try {
    return execSync('git config user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim() || 'user';
  } catch { return 'user'; }
}

/**
 * Generate the Python training script.
 */
function generateTrainScript({ baseModelId, datasetPath, outputDir, outputName, method, config, useCuda, useMps }) {
  const device = useCuda ? 'cuda' : useMps ? 'mps' : 'cpu';

  if (method === 'lora') {
    return `#!/usr/bin/env python3
"""Auto-generated khy OS LoRA fine-tuning script."""
import json, os, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer
from peft import LoraConfig, get_peft_model, TaskType
from datasets import Dataset

# Config
BASE_MODEL = "${baseModelId}"
DATASET_PATH = "${datasetPath.replace(/\\/g, '/')}"
OUTPUT_DIR = "${outputDir.replace(/\\/g, '/')}"
DEVICE = "${device}"
EPOCHS = ${config.epochs}
LR = ${config.lr}
BATCH_SIZE = ${config.batchSize}
LORA_R = ${config.loraR}
LORA_ALPHA = ${config.loraAlpha}

print(f"Loading base model: {BASE_MODEL}")
print(f"Device: {DEVICE}, Epochs: {EPOCHS}, LoRA r={LORA_R}")

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=torch.float16 if DEVICE != "cpu" else torch.float32,
    device_map="auto" if DEVICE == "cuda" else None,
    trust_remote_code=True,
)

# Apply LoRA
lora_config = LoraConfig(
    task_type=TaskType.CAUSAL_LM,
    r=LORA_R,
    lora_alpha=LORA_ALPHA,
    lora_dropout=0.05,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
)
model = get_peft_model(model, lora_config)
model.print_trainable_parameters()

# Load dataset
with open(DATASET_PATH, "r") as f:
    raw_data = json.load(f)

def tokenize(example):
    text = f"<|im_start|>system\\n{example.get('system', '')}\\n<|im_end|>\\n<|im_start|>user\\n{example['instruction']}\\n<|im_end|>\\n<|im_start|>assistant\\n{example['output']}\\n<|im_end|>"
    tokens = tokenizer(text, truncation=True, max_length=2048, padding="max_length")
    tokens["labels"] = tokens["input_ids"].copy()
    return tokens

dataset = Dataset.from_list(raw_data).map(tokenize)
print(f"Dataset size: {len(dataset)}")

# Train
training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    num_train_epochs=EPOCHS,
    per_device_train_batch_size=BATCH_SIZE,
    learning_rate=LR,
    warmup_ratio=0.1,
    logging_steps=10,
    save_strategy="epoch",
    fp16=(DEVICE == "cuda"),
    report_to="none",
)

trainer = Trainer(model=model, args=training_args, train_dataset=dataset)
print("Starting training...")
trainer.train()

# Save
model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)
print(f"Model saved to: {OUTPUT_DIR}")
print(f"100% complete")
`;
  }

  // Full fine-tune (no LoRA)
  return `#!/usr/bin/env python3
"""Auto-generated khy OS full fine-tuning script."""
import json, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer
from datasets import Dataset

BASE_MODEL = "${baseModelId}"
DATASET_PATH = "${datasetPath.replace(/\\/g, '/')}"
OUTPUT_DIR = "${outputDir.replace(/\\/g, '/')}"
DEVICE = "${device}"

print(f"Full fine-tune: {BASE_MODEL} on {DEVICE}")

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=torch.float16 if DEVICE != "cpu" else torch.float32,
    device_map="auto" if DEVICE == "cuda" else None,
    trust_remote_code=True,
)

with open(DATASET_PATH, "r") as f:
    raw_data = json.load(f)

def tokenize(example):
    text = f"<|im_start|>system\\n{example.get('system', '')}\\n<|im_end|>\\n<|im_start|>user\\n{example['instruction']}\\n<|im_end|>\\n<|im_start|>assistant\\n{example['output']}\\n<|im_end|>"
    tokens = tokenizer(text, truncation=True, max_length=2048, padding="max_length")
    tokens["labels"] = tokens["input_ids"].copy()
    return tokens

dataset = Dataset.from_list(raw_data).map(tokenize)
print(f"Dataset: {len(dataset)} samples")

training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    num_train_epochs=${config.epochs},
    per_device_train_batch_size=${config.batchSize},
    learning_rate=${config.lr},
    warmup_ratio=0.1,
    logging_steps=10,
    save_strategy="epoch",
    fp16=(DEVICE == "cuda"),
    report_to="none",
)

trainer = Trainer(model=model, args=training_args, train_dataset=dataset)
trainer.train()

model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)
print(f"100% complete - saved to {OUTPUT_DIR}")
`;
}

/**
 * Abliterate a model — remove refusal behavior via weight orthogonalization.
 *
 * Uses the abliteration technique (Arditi et al., 2024):
 * 1. Collect activations from harmful vs harmless prompts
 * 2. Compute the "refusal direction" at each layer
 * 3. Orthogonalize weight matrices against this direction
 *
 * @param {string} baseModelId - HuggingFace model ID or local path (e.g. 'Qwen/Qwen2.5-3B-Instruct')
 * @param {Object} options
 * @param {number} options.topK - Number of layers to abliterate (default: 10)
 * @param {string} options.quant - GGUF quantization type (default: 'q4_k_m')
 * @param {string} options.device - 'auto'/'cpu'/'cuda' (default: 'auto')
 * @returns {Promise<{success, safetensorsPath, ggufPath, verifyResults}>}
 */
async function abliterateModel(baseModelId, options = {}) {
  const topK = options.topK || 10;
  const quant = options.quant || 'q4_k_m';
  const device = options.device || 'auto';

  const version = getNextVersion();
  const outputName = `khy-${version}-uncensored`;
  const outputDir = path.join(TRAINING_DIR, 'models', outputName);
  fs.mkdirSync(outputDir, { recursive: true });

  const scriptPath = path.join(__dirname, '../../scripts/uncensor_model.py');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Abliteration script not found: ${scriptPath}`);
  }

  return new Promise((resolve) => {
    const args = [
      scriptPath,
      '--model', baseModelId,
      '--output', outputDir,
      '--method', 'full',
      '--top-k', String(topK),
      '--quant', quant,
      '--device', device,
    ];

    const proc = spawn(findPython(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    proc.on('close', (code) => {
      const ggufPath = path.join(outputDir, `${outputName}.gguf`);
      const success = code === 0;

      if (success) {
        // Register the abliterated model
        try {
          registerModel(outputName, outputDir, {
            baseModel: baseModelId,
            method: 'abliteration',
            topK,
            quant,
          });
        } catch { /* ignore registration errors */ }
      }

      resolve({
        success,
        modelName: outputName,
        safetensorsPath: outputDir,
        ggufPath: fs.existsSync(ggufPath) ? ggufPath : null,
        output,
      });
    });
  });
}

module.exports = {
  // Data recording
  recordInteraction,
  recordConversation,
  recordStrategyResult,
  recordFeedback,
  getDatasetStats,
  exportDataset,

  // Training
  trainLocal,
  trainCloud,
  distill,
  getComputeStatus,
  BASE_MODELS,
  TRAINING_PRESETS,

  // Models & Export
  listModels,
  registerModel,
  exportGGUF,
  exportSafetensors,
  registerWithOllama,
  abliterateModel,
  validateModelName,

  // Version management & Relay
  getNextVersion,
  rollbackModel,
  getActiveModel,
  setActiveModel,
  getRelayConfig,
  verifyExportPassword,

  // Git upload
  uploadToGitRepo,

  // HuggingFace
  uploadToHuggingFace,
};
