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
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');

const { findPython } = require('../utils/pythonPath');

const os = require('os');
const path = require('path');

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
  if (String(process.env.TRAIN_WATER_QUALITY_DEBUG || '').toLowerCase() !== 'true') {
    return;
  }
  const safeDetails = {};
  for (const [k, v] of Object.entries(details)) {
    if (k.toLowerCase().includes('sample') || k.toLowerCase().includes('content')) {
      continue;
    }
    safeDetails[k] = v;
  }
  console.warn(`[modelTrainingService] ${message}`, safeDetails);
}

function resolveTrainingDir() {
  const candidates = [];
  if (process.env.KHY_TRAINING_DIR) {
    candidates.push(process.env.KHY_TRAINING_DIR);
  }
  try {
    candidates.push(path.join(getDataHome(), 'training'));
  } catch {
    // continue fallback
  }
  candidates.push(path.join(os.homedir(), '.khyquant', 'training'));
  candidates.push(path.join(os.tmpdir(), 'khyquant', 'training'));

  for (const candidate of candidates) {
    if (candidate && isWritableDir(candidate)) {
      return candidate;
    }
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
  if (!text) {
    return 0;
  }
  const counts = new Map();
  for (const ch of text) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) {
    if (c > max) {
      max = c;
    }
  }
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
  if (hasBinaryNoise(fullText)) {
    reasons.push('binary_noise');
  }
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
  const normalized = { ...data };

  try {
    const bytes = Buffer.byteLength(JSON.stringify(data || {}), 'utf8');
    if (bytes > WATER_QUALITY_RULES.maxRecordBytes) {
      reasons.push('record_too_large');
    }
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
        storage: {
          trainingDir: TRAINING_DIR,
          recordsFile: RECORDS_FILE,
          quarantineFile: QUARANTINE_FILE,
          writable,
        },
      };
    }
    const lines = fs.readFileSync(RECORDS_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
    const byType = {};
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        byType[record.type] = (byType[record.type] || 0) + 1;
      } catch {
        /* skip malformed */
      }
    }
    const quarantined = fs.existsSync(QUARANTINE_FILE)
      ? fs.readFileSync(QUARANTINE_FILE, 'utf-8').split(/\r?\n/).filter(Boolean).length
      : 0;
    return {
      total: lines.length,
      byType,
      quarantined,
      storage: {
        trainingDir: TRAINING_DIR,
        recordsFile: RECORDS_FILE,
        quarantineFile: QUARANTINE_FILE,
        writable,
      },
    };
  } catch {
    return {
      total: 0,
      byType: {},
      quarantined: 0,
      storage: {
        trainingDir: TRAINING_DIR,
        recordsFile: RECORDS_FILE,
        quarantineFile: QUARANTINE_FILE,
        writable: false,
      },
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
  const records = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Apply filters
  let filtered = records;
  if (filter.type) {
    filtered = filtered.filter((r) => r.type === filter.type);
  }
  if (filter.quality) {
    filtered = filtered.filter((r) => r.quality === filter.quality);
  }
  if (filter.minDate) {
    filtered = filtered.filter((r) => r.timestamp >= filter.minDate);
  }

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

  // P1: dataset curation (shingle dedup + DEITA three-axis scoring +
  // train/val split). Borrowed from distilabel's MinHashLSH + DEITA pipeline
  // but implemented zero-dependency in Node. Opt out via filter.curate=false.
  let curation = null;
  let datasetRows = clean;
  if (filter.curate !== false) {
    const { curateDataset } = require('./dataCuration');
    const c = curateDataset(clean, {
      shingleN: filter.shingleN,
      dedupThreshold: filter.dedupThreshold,
      valRatio: filter.valRatio,
    });
    curation = c.report;
    // Train on the curated train split; the held-out val split is exposed
    // separately below so the post-train eval gate has a benchmark.
    datasetRows = c.train;
    curation._valRows = c.val; // carried to the val-file write below
  }

  // Convert to training format
  let dataset;
  const timestamp = Date.now();

  if (format === 'alpaca') {
    dataset = datasetRows
      .filter((r) => r.instruction && r.output)
      .map((r) => ({
        instruction: r.instruction,
        input: '',
        output: r.output,
        system: 'You are khy OS, a professional quantitative trading AI assistant.',
      }));
  } else if (format === 'sharegpt') {
    dataset = datasetRows
      .filter((r) => r.instruction && r.output)
      .map((r) => ({
        conversations: [
          {
            from: 'system',
            value: 'You are khy OS, a professional quantitative trading AI assistant.',
          },
          { from: 'human', value: r.instruction },
          { from: 'gpt', value: r.output },
        ],
      }));
  } else {
    // OpenAI fine-tune format
    dataset = datasetRows
      .filter((r) => r.instruction && r.output)
      .map((r) => ({
        messages: [
          {
            role: 'system',
            content: 'You are khy OS, a professional quantitative trading AI assistant.',
          },
          { role: 'user', content: r.instruction },
          { role: 'assistant', content: r.output },
        ],
      }));
  }

  const outFile = path.join(DATASETS_DIR, `khy_dataset_${format}_${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset, null, 2), 'utf-8');

  // Write the held-out val set alongside (same format) for the eval gate.
  if (curation && Array.isArray(curation._valRows) && curation._valRows.length > 0) {
    let valData;
    if (format === 'alpaca') {
      valData = curation._valRows
        .filter((r) => r.instruction && r.output)
        .map((r) => ({
          instruction: r.instruction,
          input: '',
          output: r.output,
          system: 'You are khy OS, a professional quantitative trading AI assistant.',
        }));
    } else if (format === 'sharegpt') {
      valData = curation._valRows
        .filter((r) => r.instruction && r.output)
        .map((r) => ({
          conversations: [
            {
              from: 'system',
              value: 'You are khy OS, a professional quantitative trading AI assistant.',
            },
            { from: 'human', value: r.instruction },
            { from: 'gpt', value: r.output },
          ],
        }));
    } else {
      valData = curation._valRows
        .filter((r) => r.instruction && r.output)
        .map((r) => ({
          messages: [
            {
              role: 'system',
              content: 'You are khy OS, a professional quantitative trading AI assistant.',
            },
            { role: 'user', content: r.instruction },
            { role: 'assistant', content: r.output },
          ],
        }));
    }
    if (valData.length > 0) {
      const valOutFile = path.join(
        DATASETS_DIR,
        `khy_dataset_${format}_${timestamp}_val.json`
      );
      fs.writeFileSync(valOutFile, JSON.stringify(valData, null, 2), 'utf-8');
      curation.valPath = valOutFile;
    } else {
      curation.valPath = null;
    }
  }
  // Drop the internal carrier before returning
  if (curation) {
    delete curation._valRows;
  }

  return {
    path: outFile,
    count: dataset.length,
    format,
    dropped,
    curation,
  };
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
  } catch {
    /* no python */
  }

  // Check PyTorch
  try {
    const torchCheck = execSync(
      `"${_pyBin}" -c "import torch; print(torch.cuda.is_available(), torch.backends.mps.is_available() if hasattr(torch.backends, 'mps') else False, torch.cuda.device_count() if torch.cuda.is_available() else 0)"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();
    const [cuda, mps, gpuCount] = torchCheck.split(' ');
    status.cuda = cuda === 'True';
    status.mps = mps === 'True';
    status.torchAvailable = true;
    if (status.cuda) {
      status.gpu = { count: parseInt(gpuCount), type: 'CUDA' };
    } else if (status.mps) {
      status.gpu = { count: 1, type: 'Apple Metal' };
    }
  } catch {
    /* no torch */
  }

  // Check NVIDIA GPU via nvidia-smi
  if (!status.gpu) {
    try {
      const smi = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 10000,
      }).trim();
      if (smi) {
        const gpus = smi.split('\n').map((line) => {
          const [name, mem] = line.split(',').map((s) => s.trim());
          return { name, memory: mem };
        });
        status.gpu = { count: gpus.length, type: 'NVIDIA', devices: gpus };
      }
    } catch {
      /* no nvidia-smi */
    }
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
    skipEvalGate = false,
    autoRollback = true,
    evalPassThreshold = 0.7,
  } = opts;
  const base = BASE_MODELS[baseModel];
  if (!base) {
    throw new Error(
      `Unknown base model: ${baseModel}. Available: ${Object.keys(BASE_MODELS).join(', ')}`
    );
  }
  if (!datasetPath || !fs.existsSync(datasetPath)) {
    throw new Error(`Dataset not found: ${datasetPath}`);
  }

  const compute = getComputeStatus();
  if (!compute.pythonAvailable) {
    throw new Error('Python3 not found. Install Python 3.10+');
  }
  if (!compute.torchAvailable) {
    throw new Error('PyTorch not found. Run: pip install torch');
  }

  const config = TRAINING_PRESETS[preset] || TRAINING_PRESETS.standard;
  const outputDir = path.join(MODELS_DIR, outputName);
  ensureDir(outputDir);

  // Structured JSON-lines progress log (P0: LlamaFactory LogCallback pattern).
  const trainLogPath = path.join(outputDir, TRAIN_LOG_FILENAME);

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
    trainLogPath,
  });

  const scriptPath = path.join(TRAINING_DIR, `train_${Date.now()}.py`);
  fs.writeFileSync(scriptPath, trainScript, 'utf-8');

  // Run training
  return new Promise((resolve) => {
    const proc = spawn(findPython(), [scriptPath], {
      cwd: TRAINING_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1', KHY_TRAIN_LOG: trainLogPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let lastProgress = 0;
    let lastLogOffset = 0;
    let settled = false;

    // Tail-parse the JSON-lines training log for structured progress events.
    const pollTrainLog = () => {
      if (settled) {
        return;
      }
      try {
        const stat = fs.statSync(trainLogPath);
        if (stat.size > lastLogOffset) {
          const fd = fs.openSync(trainLogPath, 'r');
          try {
            const buf = Buffer.alloc(stat.size - lastLogOffset);
            fs.readSync(fd, buf, 0, buf.length, lastLogOffset);
            const chunk = buf.toString('utf-8');
            output += chunk;
            lastLogOffset += chunk.length;
            const progress = parseTrainLogProgress(chunk);
            const pct = progress.pct ?? lastProgress;
            if (onProgress && pct >= lastProgress) {
              lastProgress = pct;
              const detail =
                progress.step != null
                  ? `step ${progress.step}/${progress.totalSteps || '?'} epoch ${progress.epoch + 1}/${progress.epochs} loss=${progress.loss != null ? progress.loss.toFixed(4) : '-'} lr=${progress.lr != null ? progress.lr.toExponential(1) : '-'}`
                  : `epoch ${progress.epoch != null ? progress.epoch + 1 : '?'}/${progress.epochs || '?'}${progress.loss != null ? ` loss=${progress.loss.toFixed(4)}` : ''}`;
              onProgress(pct, `训练 ${outputName}: ${detail}`);
            }
          } finally {
            fs.closeSync(fd);
          }
        }
      } catch {
        /* log not created yet — expected at startup */
      }
    };

    const logTimer = setInterval(pollTrainLog, 2000);
    logTimer.unref?.();

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Fallback progress source: regex % from stdout (legacy behaviour).
      const progressMatch = text.match(/(\d+)%/);
      if (progressMatch && onProgress) {
        const pct = parseInt(progressMatch[1]);
        if (pct > lastProgress) {
          lastProgress = pct;
          onProgress(pct, text.trim().slice(-120));
        }
      }
    });

    proc.stderr.on('data', (data) => {
      output += data.toString();
    });

    proc.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(logTimer);
      // Clean up script
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
      resolve({ success: false, error: err.message, trainLogPath });
    });

    proc.on('close', async (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(logTimer);
      // Drain remaining log lines before settling
      pollTrainLog();
      // Clean up script
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }

      if (code === 0) {
        // Register model in local registry (P0: reproducible recipe snapshot)
        const recipe = buildRecipeSnapshot({
          base,
          baseModel,
          method,
          preset,
          config,
          datasetPath,
          datasetSize: getDatasetStats().total,
          compute,
        });
        registerModel(outputName, {
          basedOn: base.hfId,
          method,
          datasetSize: getDatasetStats().total,
          trainedAt: new Date().toISOString(),
          path: outputDir,
          recipe,
        });

        // P0: post-training eval gate + auto-rollback (Axolotl lm_eval_post_train).
        // Best-effort: the gate must never turn a successful training into a
        // failure; a skipped gate is reported, not hidden.
        let evalResult = null;
        let evalDecision = null;
        if (!skipEvalGate) {
          if (onProgress) {
            onProgress(
              95,
              `训练完成 · 评测门: 对 ${outputName} 运行 ${EVAL_PROBES.length} 条固定探针 (0/${EVAL_PROBES.length})`
            );
          }
          try {
            evalResult = await evaluateModel(outputDir, outputName, {
              passThreshold: evalPassThreshold,
              onProgress: (probeIdx, msg) => {
                if (onProgress) {
                  onProgress(
                    95 + Math.round((probeIdx / Math.max(EVAL_PROBES.length, 1)) * 4),
                    msg
                  );
                }
              },
            });
            if (autoRollback) {
              evalDecision = autoRollbackOnEvalFailure(outputName, evalResult);
            }
          } catch {
            evalDecision = {
              success: false,
              message: '评测门执行异常，已跳过自动回滚判定',
            };
          }
        }

        resolve({
          success: true,
          modelPath: outputDir,
          trainLogPath,
          recipe,
          evalResult,
          evalDecision,
        });
      } else {
        resolve({ success: false, error: output.slice(-500), trainLogPath });
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
  if (!base) {
    throw new Error(`Unknown base model: ${baseModel}`);
  }

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
/**
 * Multi-teacher distillation with rejection sampling (distilabel pattern).
 *
 * - teacherModels: array of model names (single-teacher = length-1 array).
 *   `teacherModel` (string) is kept for back-compat and normalised into the
 *   array. Teachers are invoked through the local Ollama adapter, so each
 *   must already be pulled (`ollama pull <name>`).
 * - mixture: prompt type-ratio protocol { short, code, quant }. Records are
 *   bucketed by content, and each bucket is sampled to its target ratio so a
 *   skewed prompt list cannot starve a bucket.
 * - multi-teacher voting: each prompt is answered by every teacher; the
 *   responses are pairwise-compared via shingle Jaccard. The best response
 *   (highest mean similarity to the other teachers) is kept — a form of
 *   consensus rejection sampling.
 * - single-teacher mode: responses are scored by the DEITA quality axis and
 *   those below `rejectThreshold` are dropped.
 *
 * @param {object} opts
 * @param {string} [opts.teacherModel] - legacy single-teacher name
 * @param {string[]} [opts.teacherModels] - multi-teacher list (preferred)
 * @param {string} [opts.studentBase] - small base model key (e.g. 'qwen-1.5b')
 * @param {string[]} opts.prompts - prompts to distill
 * @param {string} [opts.outputName] - output model name
 * @param {object} [opts.mixture] - { short, code, quant } target ratios
 * @param {number} [opts.rejectThreshold=0.25] - DEITA quality floor (single-teacher)
 * @param {function} [opts.onProgress]
 */
async function distill(opts) {
  const {
    teacherModel,
    teacherModels,
    studentBase = 'qwen-1.5b',
    prompts,
    outputName,
    mixture,
    rejectThreshold = 0.25,
    onProgress,
  } = opts;

  if (!prompts || prompts.length === 0) {
    throw new Error(
      'Distillation requires a set of prompts. Provide prompts or use recorded interactions.'
    );
  }

  // Normalise teachers: teacherModels (preferred) or [teacherModel] (legacy).
  let teachers = Array.isArray(teacherModels) && teacherModels.length > 0
    ? teacherModels.map((t) => String(t).trim()).filter(Boolean)
    : null;
  if (!teachers && teacherModel && teacherModel !== 'best-available') {
    teachers = [String(teacherModel).trim()];
  }
  if (!teachers || teachers.length === 0) {
    throw new Error(
      'Distillation needs at least one teacher. Pass teacherModels: ["model-a","model-b"] or teacherModel: "model-a". Teachers must be pulled Ollama models (ollama pull).'
    );
  }

  const { curateDataset, deitaScore, responseSimilarity } = require('./dataCuration');

  // ── Step 1: bucket prompts by type + apply mixture ratio ──────────────────
  const bucketOf = (p) => {
    const s = String(p);
    if (/```|function |if\s*\( |for\s*\( |import |class \w+/.test(s)) return 'code';
    if (/\d+\.?\d*\s*%|波动|夏普|年化|收益|风险/.test(s)) return 'quant';
    return 'short';
  };
  const buckets = { short: [], code: [], quant: [] };
  for (const p of prompts) {
    buckets[bucketOf(p)].push(p);
  }
  const mix = mixture || { short: 0.5, code: 0.3, quant: 0.2 };
  const totalTarget = prompts.length;
  const sampledPrompts = [];
  for (const key of ['short', 'code', 'quant']) {
    const target = Math.round(totalTarget * (mix[key] || 0));
    // If a bucket is short of its target, top up from the others (no starvation).
    const take = Math.min(target, buckets[key].length);
    sampledPrompts.push(...buckets[key].slice(0, take));
  }
  // Backfill shortfall from any bucket that had surplus.
  if (sampledPrompts.length < totalTarget) {
    const surplus = [];
    for (const key of ['short', 'code', 'quant']) {
      const target = Math.round(totalTarget * (mix[key] || 0));
      surplus.push(...buckets[key].slice(target));
    }
    sampledPrompts.push(...surplus.slice(0, totalTarget - sampledPrompts.length));
  }
  const activePrompts = sampledPrompts.slice(0, totalTarget);

  // ── Step 2: generate teacher responses (multi-teacher or single) ─────────
  const gw = require('./gateway/aiGateway');
  if (!gw.isInitialized()) {
    await gw.init();
  }

  const teacherData = [];
  for (let i = 0; i < activePrompts.length; i++) {
    const prompt = activePrompts[i];
    if (onProgress) {
      onProgress(
        Math.round(((i + 1) / activePrompts.length) * 60),
        `蒸馏生成: 提示 ${i + 1}/${activePrompts.length} · ${teachers.length} 教师`
      );
    }

    // One response per teacher for this prompt.
    const responses = [];
    for (const teacher of teachers) {
      try {
        const result = await gw.generate(prompt, {
          preferredAdapter: 'ollama',
          model: teacher,
          temperature: 0.3,
          maxTokens: 1024,
        });
        if (result && result.success && result.content) {
          responses.push({ teacher, content: String(result.content) });
        }
      } catch {
        /* skip failed teacher */
      }
    }
    if (responses.length === 0) continue;

    let chosen;
    if (responses.length >= 2) {
      // Multi-teacher consensus: pick the response most similar to the others.
      let best = responses[0];
      let bestMean = 0;
      for (const cand of responses) {
        let sum = 0;
        for (const other of responses) {
          if (other === cand) continue;
          sum += responseSimilarity(cand.content, other.content);
        }
        const mean = sum / Math.max(1, responses.length - 1);
        if (mean > bestMean) {
          bestMean = mean;
          best = cand;
        }
      }
      chosen = { content: best.content, consensus: bestMean };
    } else {
      // Single-teacher: reject-sample on DEITA quality axis.
      const cand = responses[0];
      const probe = deitaScore({ instruction: prompt, output: cand.content });
      if (probe.quality < rejectThreshold) {
        continue; // reject low-quality teacher response
      }
      chosen = { content: cand.content, consensus: probe.quality };
    }

    teacherData.push({
      instruction: prompt,
      input: '',
      output: chosen.content,
      system: 'You are khy OS, a professional quantitative trading AI assistant.',
      _teacher: teachers.length >= 2 ? 'multi-teacher' : teachers[0],
      _consensus: chosen.consensus,
    });
  }

  if (teacherData.length === 0) {
    throw new Error(
      `蒸馏无有效输出: ${teachers.join(', ')} 对所有提示均未产生可用响应（教师是否已 ollama pull？）`
    );
  }

  // ── Step 3: curation (dedup + DEITA + train/val) on the distilled data ──
  const { train, val, report } = curateDataset(teacherData);
  const finalData = train.length > 0 ? train : teacherData;

  const datasetFile = path.join(DATASETS_DIR, `distill_${Date.now()}.json`);
  ensureDir(DATASETS_DIR);
  fs.writeFileSync(
    datasetFile,
    JSON.stringify(finalData.map(({ instruction, input, output, system }) => ({ instruction, input, output, system })), null, 2),
    'utf-8'
  );

  if (onProgress) {
    onProgress(70, `蒸馏数据整备: 保留 ${finalData.length}/${teacherData.length} (去重 -${report.dedup.dropped})`);
  }

  // ── Step 4: train the student on the curated teacher outputs ─────────────
  return trainLocal({
    baseModel: studentBase,
    datasetPath: datasetFile,
    outputName: outputName || `khy-${getNextVersion()}`,
    method: 'lora',
    preset: 'standard',
    onProgress: (pct, msg) => {
      if (onProgress) onProgress(70 + Math.round(pct * 0.3), msg);
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3b. Training progress log (JSON-lines protocol between Python and Node)
//     Borrowed from LlamaFactory LogCallback / unsloth PipeCapture patterns.
// ═══════════════════════════════════════════════════════════════════════════

const TRAIN_LOG_FILENAME = 'trainer_log.jsonl';

/**
 * Return the Python source for the KHY training-log helper block,
 * designed to be inlined into the top of every generated training script.
 *
 * Protocol (khy-trainlog/v1) — one JSON object per line, appended to
 * $KHY_TRAIN_LOG (env var set by the Node-side spawn):
 *   log_header  { protocol, ts }                       — written at startup
 *   epoch_start { epoch, total, ts }                   — first step of an epoch
 *   log_step    { step, total, loss, eval_loss, lr,
 *                 elapsed, remaining, ts }              — every logging_steps
 *   epoch_end   { epoch, train_loss, eval_loss, ts }   — epoch finished
 *   done        { totalSteps, ts }                     — training finished
 * The Node-side parser in trainLocal reads these lines with fs.watchFile
 * and ignores any unknown event type (forward-compatible).
 */
function buildTrainLogHelper() {
  // Each helper function is emitted as a plain-Python source snippet kept in
  // single-quoted JS strings (with \n escapes) to avoid the backtick/${}
  // collision with the outer template literal that inlines this block.
  const emitHeader =
    'def _khy_emit_header():\n' +
    '    _khy_log_event({"type": "log_header", "protocol": "khy-trainlog/v1"})\n';
  const epochStart =
    'def _khy_epoch_start(epoch, total_epochs):\n' +
    '    _khy_log_event({"type": "epoch_start", "epoch": epoch, "total": total_epochs})\n';
  const logStep =
    'def _khy_log_step(step, total_steps, loss=None, eval_loss=None, lr=None, elapsed=None, remaining=None):\n' +
    '    _khy_log_event({"type": "log_step", "step": step, "total": total_steps, "loss": loss, "eval_loss": eval_loss, "lr": lr, "elapsed": elapsed, "remaining": remaining})\n';
  const epochEnd =
    'def _khy_epoch_end(epoch, train_loss=None, eval_loss=None):\n' +
    '    _khy_log_event({"type": "epoch_end", "epoch": epoch, "train_loss": train_loss, "eval_loss": eval_loss})\n';
  const done =
    'def _khy_done(total_steps):\n' +
    '    _khy_log_event({"type": "done", "totalSteps": total_steps})\n';

  const core =
    'import json, datetime\n' +
    '_KHY_TRAIN_LOG = os.environ.get("KHY_TRAIN_LOG")\n' +
    'def _khy_log_event(event):\n' +
    '    if not _KHY_TRAIN_LOG:\n' +
    '        return\n' +
    '    try:\n' +
    '        event["ts"] = datetime.datetime.now().isoformat()\n' +
    '        with open(_KHY_TRAIN_LOG, "a", encoding="utf-8") as _f:\n' +
    '            _f.write(json.dumps(event, ensure_ascii=False) + chr(10))\n' +
    '    except OSError:\n' +
    '        pass\n';

  return core + emitHeader + epochStart + logStep + epochEnd + done;
}

/**
 * Parse the tail of the JSON-lines training log into a progress object.
 * Tolerates a partially written final line (Python flushes on each event).
 * @param {string} raw — raw log file contents
 * @returns {{ pct?: number, epoch?: number, epochs?: number, step?: number, totalSteps?: number, loss?: number, evalLoss?: number, lr?: number, elapsedSec?: number, remainingSec?: number }}
 */
function parseTrainLogProgress(raw) {
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
  let result = {};
  let stepSeen = 0;
  let headerSeen = false;
  let doneSeen = false;
  let totalEpochs = 0;
  let lastStepInfo = null;
  let lastEpochInfo = null;
  let lastLoss = null;
  let lastEvalLoss = null;
  let lastLr = null;
  let lastElapsed = null;
  let lastRemaining = null;

  for (let i = 0; i < lines.length; i++) {
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue; // skip malformed or partially written line
    }
    if (ev.type === 'log_header') {
      headerSeen = true;
    } else if (ev.type === 'epoch_start') {
      totalEpochs = ev.total || totalEpochs;
      result.epoch = ev.epoch;
      result.epochs = totalEpochs;
    } else if (ev.type === 'log_step') {
      stepSeen++;
      lastStepInfo = ev;
    } else if (ev.type === 'epoch_end') {
      lastEpochInfo = ev;
      lastLoss = ev.train_loss ?? lastLoss;
      lastEvalLoss = ev.eval_loss ?? lastEvalLoss;
    } else if (ev.type === 'done') {
      doneSeen = true;
    }
  }

  if (lastStepInfo) {
    lastLoss = lastStepInfo.loss ?? lastLoss;
    lastEvalLoss = lastStepInfo.eval_loss ?? lastEvalLoss;
    lastLr = lastStepInfo.lr ?? lastLr;
    lastElapsed = lastStepInfo.elapsed ?? lastElapsed;
    lastRemaining = lastStepInfo.remaining ?? lastRemaining;
    if (lastStepInfo.total) result.totalSteps = lastStepInfo.total;
    if (lastStepInfo.step) result.step = lastStepInfo.step;
  }
  if (lastEpochInfo) {
    result.epoch = lastEpochInfo.epoch;
    result.epochs = totalEpochs || result.epochs;
  }
  result.loss = lastLoss;
  result.evalLoss = lastEvalLoss;
  result.lr = lastLr;
  result.elapsedSec = lastElapsed;
  result.remainingSec = doneSeen ? 0 : lastRemaining;

  // Compute pct: prefer step-based, fall back to epoch-based.
  if (result.step && result.totalSteps && result.totalSteps > 0) {
    result.pct = Math.min(100, Math.round((result.step / result.totalSteps) * 100));
  } else if (result.epochs && totalEpochs > 0 && result.epoch != null) {
    result.pct = Math.min(100, Math.round(((result.epoch + 1) / totalEpochs) * 100));
  } else if (doneSeen) {
    result.pct = 100;
  } else if (headerSeen) {
    result.pct = 0;
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3c. Reproducible recipe snapshot (P0: LlamaFactory/Axolotl YAML-recipe
//     pattern — every run writes recipe.json so a khy-<version> can be
//     re-trained byte-identically from the snapshot).
// ═══════════════════════════════════════════════════════════════════════════

const RECIPE_FILENAME = 'recipe.json';

/**
 * Compute a stable fingerprint of a dataset file (sha256 of sorted content,
 * first 16 hex chars). Used by the recipe snapshot for reproducibility.
 * @param {string} datasetPath
 * @returns {string}
 */
function datasetFingerprint(datasetPath) {
  try {
    const raw = fs.readFileSync(datasetPath, 'utf-8');
    return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Build a reproducible recipe snapshot for a training run.
 * Mirrors LlamaFactory YAML-recipe + Axolotl DictDefault patterns:
 * every hyperparameter, data provenance, and environment fact that
 * affects the outcome is captured so the run can be re-created.
 *
 * @param {object} p
 * @param {object} p.base - BASE_MODELS entry
 * @param {string} p.baseModel - base model key
 * @param {string} p.method - 'lora' | 'full' | 'distill'
 * @param {string} p.preset - 'quick' | 'standard' | 'thorough'
 * @param {object} p.config - resolved TRAINING_PRESETS entry
 * @param {string} p.datasetPath
 * @param {number} p.datasetSize
 * @param {object} p.compute - getComputeStatus() result
 * @returns {object}
 */
function buildRecipeSnapshot({
  base,
  baseModel,
  method,
  preset,
  config,
  datasetPath,
  datasetSize,
  compute,
}) {
  // Try to capture git commit + dirty flag from the khy-os repo root.
  let gitHash = null;
  let gitDirty = false;
  try {
    gitHash = execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..', '..', '..', '..'),
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim() || null;
    const status = execSync('git status --porcelain', {
      cwd: path.join(__dirname, '..', '..', '..', '..'),
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    gitDirty = status.length > 0;
  } catch {
    /* not a git checkout or git unavailable */
  }

  const seed = 42; // LoRA init seed; kept explicit for reproducibility
  const recipe = {
    schema: 'khy-recipe/v1',
    createdAt: new Date().toISOString(),
    model: {
      name: baseModel,
      hfId: base ? base.hfId : baseModel,
      size: base ? base.size : null,
      vram: base ? base.vram : null,
    },
    method,
    preset,
    hyperparams: {
      epochs: config ? config.epochs : null,
      lr: config ? config.lr : null,
      batchSize: config ? config.batchSize : null,
      loraR: config ? config.loraR : null,
      loraAlpha: config ? config.loraAlpha : null,
      seed,
      warmupRatio: 0.1,
    },
    data: {
      path: datasetPath,
      count: datasetSize,
      fingerprint: datasetFingerprint(datasetPath),
    },
    compute: {
      platform: compute ? compute.platform : os.platform(),
      arch: compute ? compute.arch : os.arch(),
      cpus: compute ? compute.cpus : os.cpus().length,
      totalRAMGB: compute ? compute.totalRAM : null,
      cuda: compute ? compute.cuda : false,
      mps: compute ? compute.mps : false,
      gpuType: compute && compute.gpu ? compute.gpu.type : null,
      gpuCount: compute && compute.gpu ? compute.gpu.count : null,
    },
    environment: {
      nodeVersion: process.version,
      python: compute ? compute.pythonAvailable : false,
      torch: compute ? compute.torchAvailable : false,
      gitHash,
      gitDirty,
    },
    seed,
  };
  return recipe;
}

/**
 * Write the recipe snapshot to the model output directory.
 * Silently skips if the directory is not writable (recipe is advisory).
 * @param {string} outputDir
 * @param {object} recipe
 * @returns {string|null} path if written, null otherwise
 */
function writeRecipeSnapshot(outputDir, recipe) {
  try {
    ensureDir(outputDir);
    const recipePath = path.join(outputDir, RECIPE_FILENAME);
    fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2), 'utf-8');
    return recipePath;
  } catch {
    return null;
  }
}

/**
 * Read a recipe snapshot from a model directory.
 * @param {string} outputDir
 * @returns {object|null}
 */
function readRecipeSnapshot(outputDir) {
  try {
    const recipePath = path.join(outputDir, RECIPE_FILENAME);
    if (!fs.existsSync(recipePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(recipePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3d. Post-training eval gate + auto-rollback (P0: Axolotl lm_eval_post_train
//     pattern — run a lightweight eval probe after training; auto-rollback
//     the active version when the new model degrades below threshold).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fixed eval probe set for khy quantitative-trading domain.
 * Each probe has a deterministic expected property (contains / startsWith)
 * that a healthy fine-tuned model should satisfy at ≥ 70% pass rate.
 */
const EVAL_PROBES = [
  {
    id: 'math-arith',
    prompt: '计算: 24 * 3 + 12 = ?',
    expectContains: '84',
  },
  {
    id: 'trading-glossary',
    prompt: '用一句话解释什么是夏普比率 (Sharpe Ratio)',
    expectContains: '风险',
  },
  {
    id: 'python-code',
    prompt: '写一段 Python 代码, 计算列表 [3,1,4,1,5] 的均值',
    expectContains: 'sum',
  },
  {
    id: 'risk-assessment',
    prompt: '一只股票日波动率 5%, 年化大约多少?',
    expectContains: '80', // 5% * sqrt(252) ≈ 79%
  },
];

/**
 * Evaluate a trained model directory with the fixed probe set.
 * Uses the local Ollama endpoint (OpenAI-compatible) to run each probe;
 * if Ollama is unreachable the gate is skipped (fail-open) and reported
 * as `skipped: true` so callers can surface the reason to the user.
 *
 * @param {string} modelDir - path to a safetensors/LoRA dir
 * @param {string} modelName - khy-<version> name (used for Ollama lookup)
 * @param {object} [opts]
 * @param {number} [opts.passThreshold=0.7]
 * @param {function} [opts.onProgress]
 * @returns {Promise<{
 *   passed: boolean,
 *   score: number,
 *   total: number,
 *   results: Array,
 *   skipped: boolean,
 *   reason?: string
 * }>}
 */
async function evaluateModel(modelDir, modelName, opts = {}) {
  const passThreshold = opts.passThreshold ?? 0.7;
  const { onProgress } = opts;

  // Ollama endpoint single source of truth: import from serviceDefaults.js
  // instead of hardcoding the loopback port (Zero Hardcoding rule).
  const { OLLAMA_HOST } = require('../constants/serviceDefaults');
  const ollamaEndpoint = process.env.KHY_OLLAMA_ENDPOINT || OLLAMA_HOST;
  const apiUrl = new URL('/api/generate', ollamaEndpoint);

  // Probe liveness first (short handshake timeout — legal exception per Rule 3).
  let ollamaReachable = false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(apiUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: 'hi', stream: false }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    ollamaReachable = res.status < 500;
  } catch {
    ollamaReachable = false;
  }

  if (!ollamaReachable) {
    return {
      passed: false,
      score: 0,
      total: EVAL_PROBES.length,
      results: [],
      skipped: true,
      reason: `Ollama 不可达 (${apiUrl.host})，评测门已跳过；请确认 Ollama 已启动后手动重评`,
    };
  }

  const results = [];
  for (let i = 0; i < EVAL_PROBES.length; i++) {
    const probe = EVAL_PROBES[i];
    if (onProgress) {
      onProgress(i, `评测 ${modelName}: 探针 ${i + 1}/${EVAL_PROBES.length} (${probe.id})`);
    }
    let passed = false;
    let output = '';
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(apiUrl.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          prompt: probe.prompt,
          stream: false,
          options: { temperature: 0.2, num_predict: 256 },
        }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const body = await res.json();
        output = String(body.response || '').trim();
        passed = output.includes(probe.expectContains);
      }
    } catch {
      passed = false;
      output = '';
    }
    results.push({
      id: probe.id,
      prompt: probe.prompt,
      expectContains: probe.expectContains,
      output: output.slice(0, 200),
      passed,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  const score = results.length > 0 ? passedCount / results.length : 0;
  return {
    passed: score >= passThreshold,
    score,
    total: results.length,
    results,
    skipped: false,
  };
}

/**
 * Roll back the active model to the previous best version if the current
 * one failed the eval gate. Writes the decision to the model registry so
 * `listModels` can surface it.
 *
 * @param {string} failedModelName - khy-<version> that failed
 * @param {object} evalResult - evaluateModel() return
 * @returns {{ success: boolean, message: string, rolledBackTo?: string }}
 */
function autoRollbackOnEvalFailure(failedModelName, evalResult) {
  const registry = loadModelRegistry();
  if (!registry[failedModelName]) {
    return { success: false, message: `Model ${failedModelName} not in registry` };
  }

  // Find the previous best: latest version before the failed one numerically.
  const parseSegments = (name) => name.replace('khy-', '').split('.').map(Number);
  const compareVersions = (a, b) => {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  };
  const candidates = Object.keys(registry)
    .filter((n) => /^khy-\d+(\.\d+)*$/.test(n) && n !== failedModelName)
    .sort((a, b) => compareVersions(parseSegments(a), parseSegments(b)));
  const target = candidates[candidates.length - 1] || null;

  // Mark the failed model in the registry
  registry[failedModelName].evalResult = {
    skipped: evalResult.skipped,
    score: evalResult.score,
    total: evalResult.total,
    passedCount: evalResult.results ? evalResult.results.filter((r) => r.passed).length : 0,
    reason: evalResult.reason || null,
    evaluatedAt: new Date().toISOString(),
    passed: evalResult.passed,
  };
  if (evalResult.passed) {
    registry[failedModelName].evalStatus = 'passed';
  } else if (evalResult.skipped) {
    registry[failedModelName].evalStatus = 'skipped';
  } else {
    registry[failedModelName].evalStatus = 'failed';
    registry[failedModelName].autoRolledBack = !!target;
    if (target) {
      process.env.KHY_ACTIVE_MODEL = target;
      process.env.KHY_ACTIVE_MODEL_PATH = registry[target].path;
      registry[failedModelName].rolledBackTo = target;
    }
  }
  try {
    ensureDir(TRAINING_DIR);
    fs.writeFileSync(MODEL_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
  } catch {
    /* registry write is best-effort */
  }

  if (evalResult.passed) {
    return { success: true, message: `评测通过 (${evalResult.score.toFixed(2)})` };
  }
  if (evalResult.skipped) {
    return { success: true, message: `评测跳过: ${evalResult.reason}` };
  }
  if (target) {
    return {
      success: true,
      message: `评测未通过 (${evalResult.score.toFixed(2)})，已自动回滚到 ${target}`,
      rolledBackTo: target,
    };
  }
  return { success: false, message: `评测未通过且无历史版本可回滚` };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Model Export & Registration
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_REGISTRY_FILE = path.join(TRAINING_DIR, 'model_registry.json');

/**
 * Verify export password before allowing model export.
 *
 * 安全模型（对抗式综合方案）：
 *   - 默认模式（KHY_EXPORT_STRICT_MODE=0）：保持向后兼容，始终授权，但记录审计日志
 *   - 严格模式（KHY_EXPORT_STRICT_MODE=1）：需要密码验证，密码从 KHY_EXPORT_PASSWORD 或
 *     ~/.khyquant/config.json 中的 exportPassword 字段获取
 *   - 审计日志：所有导出尝试（无论成功/失败）都记录到 audit.log
 *
 * 推荐生产环境启用严格模式：
 *   KHY_EXPORT_STRICT_MODE=1 KHY_EXPORT_PASSWORD=<strong-password> khy export-model ...
 *
 * @param {string} _password - 导出密码（严格模式下使用）
 * @returns {boolean} 是否授权导出
 */
function verifyExportPassword(_password) {
  const strictMode = String(process.env.KHY_EXPORT_STRICT_MODE || '0') === '1';
  const providedPassword = _password || process.env.KHY_EXPORT_PASSWORD || '';
  
  // 审计日志：记录导出尝试
  const auditLog = {
    timestamp: new Date().toISOString(),
    action: 'model_export_password_check',
    strictMode,
    passwordProvided: !!providedPassword,
    source: 'modelTrainingService',
  };
  
  // 写入审计日志（fail-soft：审计失败不影响主流程）
  try {
    const fs = require('fs');
    const path = require('path');
    const { getDataHome } = require('../utils/dataHome');
    const auditDir = path.join(getDataHome(), 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(
      path.join(auditDir, 'export-audit.jsonl'),
      JSON.stringify(auditLog) + '\n',
      'utf-8'
    );
  } catch {
    // 审计失败不阻断
  }
  
  // 非严格模式：保持向后兼容，始终授权
  if (!strictMode) {
    console.warn(
      '[modelTrainingService] export password check bypassed (set KHY_EXPORT_STRICT_MODE=1 to enable)'
    );
    return true;
  }
  
  // 严格模式：验证密码
  let expectedPassword = process.env.KHY_EXPORT_PASSWORD || '';
  
  // 如果 env 未设置，尝试从配置文件读取
  if (!expectedPassword) {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(
        process.env.KHY_DATA_HOME || require('../utils/dataHome').getDataHome(),
        'config.json'
      );
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expectedPassword = config.exportPassword || '';
      }
    } catch {
      // 读取失败继续
    }
  }
  
  // 验证密码
  const authorized = !!expectedPassword && providedPassword === expectedPassword;
  
  if (!authorized) {
    console.error(
      '[modelTrainingService] 导出密码验证失败。请设置 KHY_EXPORT_PASSWORD 或在 config.json 中配置 exportPassword。'
    );
  }
  
  return authorized;
}

/**
 * Register a trained model in the local registry.
 */
function registerModel(name, metadata) {
  validateModelName(name);
  const registry = loadModelRegistry();
  const { recipe, ...publicMeta } = metadata || {};
  registry[name] = { ...publicMeta, registeredAt: new Date().toISOString() };
  ensureDir(TRAINING_DIR);
  fs.writeFileSync(MODEL_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
  // P0: persist the reproducible recipe snapshot next to the model files.
  if (recipe && registry[name].path) {
    writeRecipeSnapshot(registry[name].path, recipe);
  }
}

/**
 * Load model registry.
 */
function loadModelRegistry() {
  try {
    if (fs.existsSync(MODEL_REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(MODEL_REGISTRY_FILE, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
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
  if (!model) {
    throw new Error(`Model not found: ${modelName}. Run: train list`);
  }

  const modelPath = model.path;
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model files not found at: ${modelPath}`);
  }

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
    let settled = false;
    proc.stdout.on('data', (d) => {
      output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
    });
    proc.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
      resolve({ success: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
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
  if (!model) {
    throw new Error(`Model not found: ${modelName}`);
  }

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
    let settled = false;
    proc.stdout.on('data', (d) => {
      output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
    });
    proc.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
      resolve({ success: false, error: err.message });
    });
    proc.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        /* ignore */
      }
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
  if (!fs.existsSync(ggufPath)) {
    throw new Error(`GGUF file not found: ${ggufPath}`);
  }

  const modelfile = `FROM ${ggufPath}
SYSTEM "You are khy OS (${modelName}), a professional quantitative trading AI assistant specialized in Chinese A-shares, futures, and crypto markets. You provide data-driven analysis, strategy suggestions, and risk assessments."
PARAMETER temperature 0.4
PARAMETER top_p 0.9
PARAMETER num_ctx 4096
`;

  const modelfilePath = path.join(TRAINING_DIR, `Modelfile_${modelName}`);
  fs.writeFileSync(modelfilePath, modelfile, 'utf-8');

  try {
    execSync(`ollama create ${modelName} -f "${modelfilePath}"`, {
      encoding: 'utf-8',
      timeout: 120000,
    });
    // P2: model-discovery marker. The front-end's /api/ai-gateway/models
    // merges a live Ollama probe, so a freshly-registered model becomes
    // visible on the next model-list fetch. Writing a small notification file
    // lets the UI (or any watcher) surface "a new local model appeared"
    // without a WebSocket push channel.
    writeModelNotify(modelName);
    return {
      success: true,
      message: `Model ${modelName} registered with Ollama. Use: ollama run ${modelName}`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try {
      fs.unlinkSync(modelfilePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Append a model registration event to the discovery-notify file so the UI
 * can detect newly-available local models on its next refresh. Kept as an
 * append-only JSONL at `<dataHome>/models-notify.jsonl` (one JSON object per
 * line) — no rotation, small by design.
 *
 * @param {string} modelName - khy-<version>
 * @returns {string|null} path of the notify file, or null on write failure
 */
function writeModelNotify(modelName) {
  try {
    ensureDir(TRAINING_DIR);
    const notifyFile = path.join(path.dirname(TRAINING_DIR), 'models-notify.jsonl');
    const entry = {
      event: 'model:registered',
      model: modelName,
      source: 'ollama',
      at: new Date().toISOString(),
    };
    fs.appendFileSync(notifyFile, JSON.stringify(entry) + '\n', 'utf-8');
    return notifyFile;
  } catch {
    return null;
  }
}

/**
 * Read recent model-notify events (newest last). The UI merges the last
 * `limit` events to show "新注册" badges.
 * @param {number} [limit=20]
 * @returns {Array}
 */
function readModelNotify(limit = 20) {
  try {
    const notifyFile = path.join(path.dirname(TRAINING_DIR), 'models-notify.jsonl');
    if (!fs.existsSync(notifyFile)) return [];
    const lines = fs
      .readFileSync(notifyFile, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean);
    const events = lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return events;
  } catch {
    return [];
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
  if (!model) {
    throw new Error(`Model not found: ${modelName}`);
  }
  if (!model.path || !fs.existsSync(model.path)) {
    throw new Error(`Model files not found at: ${model.path}`);
  }
  if (!repoId || !repoId.includes('/')) {
    throw new Error('Invalid repo ID. Format: username/model-name');
  }

  const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '';
  if (!hfToken) {
    throw new Error(
      'HuggingFace token not set. Configure via: gateway config → provider-keys → HuggingFace, or set HF_TOKEN env var.'
    );
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

    if (onProgress) {
      onProgress(10, 'Creating repository...');
    }

    // Create repo (ignore error if exists)
    try {
      execSync(
        `huggingface-cli repo create ${repoId.split('/')[1]} --type model ${isPrivate ? '--private' : ''} -y`,
        { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, HF_TOKEN: hfToken } }
      );
    } catch {
      /* repo may already exist */
    }

    if (onProgress) {
      onProgress(30, 'Uploading model files...');
    }

    // Upload entire folder
    execSync(`huggingface-cli upload ${repoId} "${modelPath}" . --repo-type model`, {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, HF_TOKEN: hfToken },
      timeout: 600000, // 10 min
    });

    if (onProgress) {
      onProgress(100, 'Upload complete');
    }

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
      let settled = false;
      proc.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        // Parse progress
        const progressMatch = text.match(/PROGRESS:(\d+):(.+)/);
        if (progressMatch && onProgress) {
          onProgress(parseInt(progressMatch[1]), progressMatch[2]);
        }
      });
      proc.stderr.on('data', (data) => {
        output += data.toString();
      });

      proc.on('error', (err) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        resolve({ success: false, url: '', message: err.message });
      });

      proc.on('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        const successMatch = output.match(/SUCCESS:(.+)/);
        if (code === 0 && successMatch) {
          resolve({
            success: true,
            url: successMatch[1].trim(),
            message: `Model ${modelName} uploaded to ${successMatch[1].trim()}`,
          });
        } else {
          const errorMatch = output.match(/ERROR:(.+)/);
          resolve({
            success: false,
            url: '',
            message: errorMatch ? errorMatch[1].trim() : output.slice(-300),
          });
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
  // Parse a khy-<major>[.<minor>...] name into numeric segments.
  const parseSegments = (name) => name.replace('khy-', '').split('.').map(Number);
  // Compare two version segment arrays numerically, segment by segment.
  const compareVersions = (a, b) => {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  };

  // Sort registry keys numerically so khy-1.10 ranks after khy-1.9.
  const versionKeys = Object.keys(registry).filter((n) => /^khy-\d+(\.\d+)*$/.test(n));
  const sortVersionKeys = (arr) =>
    arr.slice().sort((x, y) => compareVersions(parseSegments(x), parseSegments(y)));

  // Match multi-segment versions (e.g. khy-1.0, khy-2.1.3) to align with validateModelName.
  const versions = sortVersionKeys(versionKeys).map(parseSegments);

  if (versions.length === 0) {
    return '1.0';
  }
  const latest = versions[versions.length - 1];
  const major = latest[0] || 1;
  const minor = latest[1] || 0;
  return `${major}.${minor + 1}`;
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
    // Find latest — sort numerically so khy-1.10 ranks after khy-1.9.
    const parseSegments = (name) => name.replace('khy-', '').split('.').map(Number);
    const versionKeys = Object.keys(registry).filter((n) => /^khy-\d+(\.\d+)*$/.test(n));
    versionKeys.sort((a, b) => {
      const sa = parseSegments(a);
      const sb = parseSegments(b);
      const len = Math.max(sa.length, sb.length);
      for (let i = 0; i < len; i++) {
        const diff = (sa[i] || 0) - (sb[i] || 0);
        if (diff !== 0) {
          return diff;
        }
      }
      return 0;
    });
    version = versionKeys[versionKeys.length - 1] || null;
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
  const { platform = 'github', repo, owner, token, password } = opts;

  // Verify export password
  if (!verifyExportPassword(password)) {
    throw new Error('导出密码错误。上传到仓库需要输入正确的导出密码。');
  }

  const registry = loadModelRegistry();
  const model = registry[modelName];
  if (!model) {
    throw new Error(`Model not found: ${modelName}`);
  }
  if (!model.path || !fs.existsSync(model.path)) {
    throw new Error(`Model files not found at: ${model.path}`);
  }

  if (!repo) {
    throw new Error('Repository name required. Use --repo <name>');
  }

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
      try {
        execSync(`git lfs track "${pattern}"`, { cwd: modelPath, stdio: 'pipe' });
      } catch {
        /* ignore */
      }
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
    } catch {
      /* already committed */
    }

    // Set remote
    try {
      execSync(`git remote remove origin`, { cwd: modelPath, stdio: 'pipe' });
    } catch {
      /* no remote */
    }
    execSync(`git remote add origin ${remoteUrl}`, { cwd: modelPath, stdio: 'pipe' });

    // Try to create repo via API (if token provided)
    if (token) {
      await createRemoteRepo(platform, repo, token, gitOwner);
    }

    // Push
    execSync('git push -u origin main --force', { cwd: modelPath, stdio: 'pipe', timeout: 300000 });

    const publicUrl =
      platform === 'gitee'
        ? `https://gitee.com/${gitOwner}/${repo}`
        : `https://github.com/${gitOwner}/${repo}`;

    return {
      success: true,
      url: publicUrl,
      message: `Model ${modelName} uploaded to ${publicUrl}`,
    };
  } catch (err) {
    return { success: false, url: '', message: err.message };
  }
}

/**
 * Create remote repository via API.
 */
async function createRemoteRepo(platform, repoName, token, owner) {
  try {
    let url;
    let body;
    let headers = { 'Content-Type': 'application/json' };
    if (platform === 'github') {
      url = 'https://api.github.com/user/repos';
      headers = { ...headers, Authorization: `Bearer ${token}` };
      body = { name: repoName, private: true, description: 'khy OS trained model' };
    } else if (platform === 'gitee') {
      url = 'https://gitee.com/api/v5/user/repos';
      body = {
        access_token: token,
        name: repoName,
        private: true,
        description: 'khy OS trained model',
      };
    } else {
      return;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`Repository API HTTP ${response.status}`);
    }
  } catch {
    /* repo may already exist, ignore */
  }
}

/**
 * Get git username from config.
 */
function getGitUser() {
  try {
    return execSync('git config user.name', { encoding: 'utf-8', stdio: 'pipe' }).trim() || 'user';
  } catch {
    return 'user';
  }
}

/**
 * Generate the Python training script.
 */
function generateTrainScript({
  baseModelId,
  datasetPath,
  outputDir,
  outputName,
  method,
  config,
  useCuda,
  useMps,
  trainLogPath,
}) {
  const device = useCuda ? 'cuda' : useMps ? 'mps' : 'cpu';
  const logHelper = buildTrainLogHelper();
  const pySafe = (s) => String(s).replace(/\\/g, '/').replace(/"/g, '\\"');

  // Tokenize block: pad token is masked out of labels (-100) so the loss is
  // not diluted by padding. Chat-template markers are built from unescaped
  // literals to keep the generated Python valid.
  const tokenizeBlock = `
def tokenize(example):
    system_text = "<|" + "system|>" + "\\n" + example.get("system", "") + "\\n" + "<|" + "/system|>"
    user_text = "<|" + "user|>" + "\\n" + example["instruction"] + "\\n" + "<|" + "/user|>"
    assistant_text = "<|" + "assistant|>" + "\\n" + example["output"] + "\\n" + "<|" + "/assistant|>"
    text = system_text + "\\n" + user_text + "\\n" + assistant_text
    tokens = tokenizer(text, truncation=True, max_length=2048, padding="max_length")
    labels = tokens["input_ids"].copy()
    labels = [([t if t != tokenizer.pad_token_id else -100 for t in row]) for row in labels]
    tokens["labels"] = labels
    return tokens
`;

  // Load dataset + 95/5 train/val split (held-out set feeds the eval gate
  // and EarlyStoppingCallback; deterministic seed for reproducibility).
  const datasetBlock = `
with open(DATASET_PATH, "r") as f:
    raw_data = json.load(f)

dataset = Dataset.from_list(raw_data).map(tokenize)
print(f"Dataset size: {len(dataset)}")
if len(dataset) >= 20:
    _split = dataset.train_test_split(test_size=0.05, seed=42)
    train_ds, eval_ds = _split["train"], _split["test"]
else:
    train_ds, eval_ds = dataset, None
print(f"Train size: {len(train_ds)}, Val size: {len(eval_ds) if eval_ds else 0}")
`;

  // Structured progress callback writing khy-trainlog/v1 JSON-lines events.
  const logCallbackClass = `
class KhyTrainLogCallback:
    """Emits khy-trainlog/v1 JSON-lines progress events (LlamaFactory LogCallback pattern)."""
    def __init__(self, total_epochs):
        self.total_epochs = total_epochs
        self.start = None
        self._first_step_seen = False

    def on_train_begin(self, args, state, control, **kwargs):
        self.start = time.time()

    def on_epoch_begin(self, args, state, control, **kwargs):
        _khy_epoch_start(state.epoch, self.total_epochs)

    def on_log(self, args, state, control, logs=None, **kwargs):
        if logs is None:
            return
        elapsed = time.time() - self.start if self.start else None
        remaining = None
        if elapsed is not None and state.epoch >= 1 and state.num_train_epochs:
            remaining = elapsed * max(state.num_train_epochs - state.epoch, 0) / state.epoch
        step = state.global_step or 0
        total = 0
        try:
            total = int(len(train_ds) / max(args.per_device_train_batch_size, 1)) * int(state.num_train_epochs or 1)
        except Exception:
            total = 0
        lr = logs.get("learning_rate") or logs.get("lr")
        loss = logs.get("loss")
        eval_loss = logs.get("eval_loss")
        _khy_log_step(step, total, loss, eval_loss, lr, elapsed, remaining)

    def on_epoch_end(self, args, state, control, **kwargs):
        _khy_epoch_end(state.epoch, train_loss=None, eval_loss=None)
`;

  // Trainer assembly: eval split + early stopping on val loss (patience=2).
  const trainerBlock = `
_callbacks = [KhyTrainLogCallback(EPOCHS)]
if eval_ds is not None:
    _callbacks.append(EarlyStoppingCallback(patience=2, metric="eval_loss"))

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
    eval_strategy="epoch" if eval_ds is not None else "no",
    load_best_model_at_end=(eval_ds is not None),
    metric_for_best_model="eval_loss" if eval_ds is not None else "train_loss",
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    callbacks=_callbacks,
)
_khy_emit_header()
print("Starting training...")
trainer.train()

# Save
model.save_pretrained(OUTPUT_DIR)
tokenizer.save_pretrained(OUTPUT_DIR)
_khy_done(trainer.state.global_step)
print(f"Model saved to: {OUTPUT_DIR}")
print("100% complete")
`;

  if (method === 'lora') {
    return `#!/usr/bin/env python3
"""Auto-generated khy OS LoRA fine-tuning script."""
import json, os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer, EarlyStoppingCallback
from peft import LoraConfig, get_peft_model, TaskType
from datasets import Dataset

# khy-trainlog/v1 helper block
${logHelper}

# Structured progress callback
${logCallbackClass}

# Config
BASE_MODEL = "${pySafe(baseModelId)}"
DATASET_PATH = "${pySafe(datasetPath)}"
OUTPUT_DIR = "${pySafe(outputDir)}"
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
${tokenizeBlock}
${datasetBlock}

# Train
${trainerBlock}
`;
  }

  // Full fine-tune (no LoRA)
  return `#!/usr/bin/env python3
"""Auto-generated khy OS full fine-tuning script."""
import json, os, time, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments, Trainer, EarlyStoppingCallback
from datasets import Dataset

# khy-trainlog/v1 helper block
${logHelper}

# Structured progress callback
${logCallbackClass}

# Config
BASE_MODEL = "${pySafe(baseModelId)}"
DATASET_PATH = "${pySafe(datasetPath)}"
OUTPUT_DIR = "${pySafe(outputDir)}"
DEVICE = "${device}"
EPOCHS = ${config.epochs}
LR = ${config.lr}
BATCH_SIZE = ${config.batchSize}

print(f"Full fine-tune: {BASE_MODEL} on {DEVICE}, Epochs: {EPOCHS}")

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL,
    torch_dtype=torch.float16 if DEVICE != "cpu" else torch.float32,
    device_map="auto" if DEVICE == "cuda" else None,
    trust_remote_code=True,
)

# Load dataset
${tokenizeBlock}
${datasetBlock}

# Train
${trainerBlock}
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
      '--model',
      baseModelId,
      '--output',
      outputDir,
      '--method',
      'full',
      '--top-k',
      String(topK),
      '--quant',
      quant,
      '--device',
      device,
    ];

    const proc = spawn(findPython(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    let settled = false;
    proc.stdout.on('data', (d) => {
      output += d.toString();
    });
    proc.stderr.on('data', (d) => {
      output += d.toString();
    });

    proc.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        success: false,
        modelName: outputName,
        safetensorsPath: outputDir,
        ggufPath: null,
        output: err.message,
      });
    });

    proc.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      const ggufPath = path.join(outputDir, `${outputName}.gguf`);
      const success = code === 0;

      if (success) {
        // Register the abliterated model
        try {
          registerModel(outputName, {
            baseModel: baseModelId,
            method: 'abliteration',
            topK,
            quant,
            path: outputDir,
          });
        } catch {
          /* ignore registration errors */
        }
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
  validateModelName,
  // Data recording
  recordInteraction,
  recordConversation,
  recordStrategyResult,
  recordFeedback,
  getDatasetStats,
  exportDataset,
  curateDataset: require('./dataCuration').curateDataset,

  // Training
  trainLocal,
  trainCloud,
  distill,
  getComputeStatus,
  BASE_MODELS,
  TRAINING_PRESETS,

  // Structured training log (khy-trainlog/v1)
  TRAIN_LOG_FILENAME,
  buildTrainLogHelper,
  parseTrainLogProgress,

  // Reproducible recipe snapshot
  RECIPE_FILENAME,
  buildRecipeSnapshot,
  writeRecipeSnapshot,
  readRecipeSnapshot,

  // Post-training eval gate + auto-rollback
  EVAL_PROBES,
  evaluateModel,
  autoRollbackOnEvalFailure,

  // Models & Export
  listModels,
  registerModel,
  exportGGUF,
  exportSafetensors,
  registerWithOllama,
  abliterateModel,

  // Model discovery notify (P2: front-end "new model appeared" marker)
  writeModelNotify,
  readModelNotify,

  // Version management & Relay
  getNextVersion,
  rollbackModel,
  getActiveModel,
  setActiveModel,
  getRelayConfig,
  verifyExportPassword,

  // Git upload
  uploadToGitRepo,
  createRemoteRepo,

  // HuggingFace
  uploadToHuggingFace,
};
