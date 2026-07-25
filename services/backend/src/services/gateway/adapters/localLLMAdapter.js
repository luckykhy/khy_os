/**
 * Local LLM Adapter — run GGUF models directly via node-llama-cpp.
 *
 * No external service required. Model is loaded once into the Node.js process.
 * Detection: check if GGUF file exists at LOCAL_MODEL_PATH.
 * Generation: direct inference via node-llama-cpp.
 */
const localLLMService = require('../../localLLMService');
// Sampling locks come from the zero-dependency leaf, not the upgrade runtime
// ([DESIGN-ARCH-051] §6.8 — keeps this adapter out of the giant SCC).
const runtime = require('../../samplingPolicy');
const { normalizeImages } = require('./_imageCompat');
const { buildSuccess, buildFailure } = require('./_responseBuilder');
// Model-name SSOT: local-brain default flows from constants/models.js
// (env LOCAL_LLM_MODEL still overrides first).
const { PRIMARY: MODELS } = require('../../../constants/models');
const DEFAULT_MODEL = process.env.LOCAL_LLM_MODEL || MODELS.localBrain;

let _available = null;

/**
 * Detect if local model is available.
 */
function detect(forceRefresh = false) {
  if (_available !== null && !forceRefresh) return _available;
  _available = localLLMService.isModelAvailable(forceRefresh);
  return _available;
}

/**
 * Async detection — check if model file exists (don't trigger loading).
 */
async function detectAsync() {
  _available = localLLMService.isModelAvailable(true);
  return _available;
}

/**
 * Generate response using local GGUF model.
 */
async function generate(prompt, options = {}) {
  // Graceful image degradation: strip images and proceed with text-only
  // (local GGUF models typically don't support vision; don't hard-fail)
  // Defensive normalize — gateway already does this, but keep it idempotent
  if (Array.isArray(options.images) && options.images.length > 0) {
    options.images = normalizeImages(options.images);
  }
  if (Array.isArray(options.images) && options.images.length > 0) {
    const strippedCount = options.images.length;
    const stripped = { ...options, images: undefined };
    Object.assign(options, stripped);
    // Append the single-source degradation notice so the model knows images
    // were provided but are not visible (text-only model). Unified across the
    // gateway via plainTextImageDegrade — no per-adapter ad-hoc wording.
    const { buildTextModelImageNotice } = require('../plainTextImageDegrade');
    const notice = buildTextModelImageNotice(strippedCount);
    if (notice && !prompt.includes(notice.trim())) {
      prompt += notice;
    }
  }

  const sourceText = options.userMessage || prompt || '';
  const forcedTemperature = runtime.lockTemperature(sourceText);
  const forcedTopP = runtime.lockTopP(sourceText);

  try {
    // Ensure model is loaded (first call triggers loading)
    await localLLMService.ensureLoaded();

    // Build prompt from structured messages if available
    let fullPrompt = prompt;
    if (options.messages && Array.isArray(options.messages) && options.messages.length > 0) {
      const parts = [];
      if (options.system) {
        parts.push(`<|im_start|>system\n${options.system}<|im_end|>`);
      }
      for (const msg of options.messages) {
        if (msg.role === 'user') {
          parts.push(`<|im_start|>user\n${msg.content}<|im_end|>`);
        } else if (msg.role === 'assistant') {
          parts.push(`<|im_start|>assistant\n${msg.content}<|im_end|>`);
        } else if (msg.role === 'tool') {
          parts.push(`<|im_start|>user\n[Tool Results]: ${msg.content}<|im_end|>`);
        }
      }
      parts.push('<|im_start|>assistant\n');
      fullPrompt = parts.join('\n');
    } else if (options.system) {
      fullPrompt = `<|im_start|>system\n${options.system}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;
    }

    const response = await localLLMService.generate(fullPrompt, {
      temperature: forcedTemperature,
      top_p: forcedTopP,
      maxTokens: options.maxTokens || 1024,
      system: options.system,
      messages: options.messages,
      onChunk: typeof options.onChunk === 'function' ? options.onChunk : undefined,
      timeoutMs: options.timeoutMs || 120_000,
    });

    // generateRunner always returns { content, thinking, tokenUsage }
    const content = typeof response === 'object' ? response.content : response;
    const thinking = typeof response === 'object' ? response.thinking : undefined;
    const tokenUsage = typeof response === 'object' ? response.tokenUsage : undefined;

    const modelName = DEFAULT_MODEL;
    return buildSuccess(content, {
      adapter: 'localLLM', provider: `Local (${modelName})`, model: modelName,
      thinking, tokenUsage,
      attempts: [{ provider: `Local (${modelName})`, success: true }],
    });
  } catch (err) {
    return buildFailure(err, {
      adapter: 'localLLM', provider: 'Local LLM',
      attempts: [{ provider: `Local (${DEFAULT_MODEL})`, success: false, error: String(err?.message || err) }],
    });
  }
}

/**
 * Get adapter status.
 */
function getStatus() {
  const status = localLLMService.getStatus();
  const backendLabel = {
    'ollama-runner': 'ollama-runner 独立引擎',
    'node-llama-cpp': 'node-llama-cpp',
    'python-server': 'Python 推理服务器',
    'ollama': 'Ollama HTTP API',
  }[status.backend] || '未加载';

  let detail = '';
  if (status.loaded) {
    detail = `模型已加载 (${backendLabel})，就绪`;
  } else if (status.available) {
    detail = '模型文件就绪，等待首次加载';
  } else if (status.modelDiscoveryReason === 'importable_only') {
    detail = status.modelImportHint || '已检测到可导入模型格式，需先导入/转换到 GGUF。';
  } else if (status.modelDiscoveryReason === 'non_runtime_only') {
    detail = status.modelImportHint || '已检测到非 GGUF 模型文件，需先转换或导入为 GGUF。';
  } else if (status.modelDiscoveryReason === 'scan_error') {
    detail = status.discoveryError
      ? `模型扫描失败: ${status.discoveryError}`
      : '模型扫描失败，请检查目录权限或路径配置';
  } else if (status.modelArtifactPath) {
    detail = `未发现可运行 GGUF 模型（已检测到: ${status.modelArtifactPath}）`;
  } else {
    detail = `未发现可运行 GGUF 模型: ${status.modelPath}`;
  }

  return {
    name: '本地模型',
    type: 'localLLM',
    available: status.available,
    detail,
    importCommand: status.modelImportCommand || null,
  };
}

/**
 * Get list of available models.
 */
function getModels() {
  return localLLMService.isModelAvailable() ? [DEFAULT_MODEL] : [];
}

async function listModels() {
  const models = getModels();
  if (models.length === 0) return [];
  return models.map((id, idx) => ({
    id,
    name: id,
    provider: 'localLLM',
    description: 'node-llama-cpp local model',
    isDefault: idx === 0,
  }));
}

function destroy() {
  localLLMService.dispose();
  _available = null;
}

module.exports = { detect, detectAsync, generate, getStatus, getModels, listModels, destroy };
