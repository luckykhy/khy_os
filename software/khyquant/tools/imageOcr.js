const { defineTool } = require('./_baseTool');
const { spawn, execFileSync } = require('child_process');
const { safeKill } = require('./platformUtils');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { guardedReadFileSync } = require('./guardedReadFileSync');

const DOC_HELPER = path.join(__dirname, '../services/docHelper.py');
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

let _enabled = null;
const _checkEnabled = require('../utils/docHelperEnabled');
const SUPPORTED_FORMATS = new Set([
  '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp', '.gif',
]);

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

const resolvePath = require('../utils/resolveToolPath');

function runPython(pythonPath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(pythonPath, args, { env });

    let stdout = '';
    let stderr = '';

    // Activity-aware idle timeout (resets on stdout/stderr data)
    let _idleTimer = null;
    const IDLE_MS = 120000;
    // Hard wall-clock total cap (does NOT reset on activity). Injected by callers
    // via opts.totalMs (policy KHY_IMAGE_OCR_NO_CASCADE / KHY_IMAGE_OCR_TOTAL_MS).
    // Without it a streaming-but-never-finishing child could run unbounded — the
    // 804s hang the user hit. 0/absent → disabled (byte-revert to idle-only).
    let _totalTimer = null;
    const _totalMs = Number(opts.totalMs) > 0 ? Number(opts.totalMs) : 0;
    const _clearTimers = () => {
      if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
      if (_totalTimer) { clearTimeout(_totalTimer); _totalTimer = null; }
    };
    const _resetIdle = () => {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => {
        _clearTimers();
        safeKill(child);
        reject(new Error(`Python OCR idle timeout (${IDLE_MS / 1000}s without output)`));
      }, IDLE_MS);
    };
    _resetIdle();
    if (_totalMs > 0) {
      _totalTimer = setTimeout(() => {
        _clearTimers();
        safeKill(child);
        reject(new Error(`Python OCR total timeout (${Math.round(_totalMs / 1000)}s wall-clock)`));
      }, _totalMs);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; _resetIdle(); });
    child.stderr.on('data', d => { stderr += d; _resetIdle(); });

    child.on('error', err => {
      _clearTimers();
      reject(new Error(`Python process error: ${err.message}`));
    });

    child.on('close', code => {
      _clearTimers();
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${e.message}`));
      }
    });
  });
}

async function aiVisionOcr(imagePath, opts = {}) {
  // Bound the gateway round-trip so a stuck/cascading vision call can't hang the
  // tool (the 804s the user hit). totalMs (from policy) → abort the gateway via
  // its existing options.abortSignal; 0/absent → unbounded (byte-revert).
  let _timer = null;
  let _ac = null;
  try {
    const gateway = require('../services/gateway/aiGateway');
    const imageData = guardedReadFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = MIME_MAP[ext] || 'image/jpeg';

    const _totalMs = Number(opts.totalMs) > 0 ? Number(opts.totalMs) : 0;
    let abortSignal;
    if (_totalMs > 0 && typeof AbortController !== 'undefined') {
      _ac = new AbortController();
      abortSignal = _ac.signal;
      _timer = setTimeout(() => {
        try { _ac.abort('imageOcr vision total timeout'); } catch { /* ignore */ }
      }, _totalMs);
    }

    const result = await gateway.generate(
      'Extract all text from this image. Preserve the original layout and formatting. '
      + 'If there are tables, output them in Markdown table format. '
      + 'Output only the recognized text, no explanations.',
      {
        images: [{ base64, mimeType }],
        maxTokens: 4096,
        temperature: 0.1,
        abortSignal,
      }
    );

    if (result.success) {
      return {
        success: true,
        text: result.content,
        method: 'ai_vision',
        model: result.model || result.provider,
      };
    }

    return {
      success: false,
      error: `AI vision OCR failed: ${result.content || 'unknown error'}. Install local OCR: pip install khy-os[doc]`,
    };
  } catch (err) {
    return {
      success: false,
      error: `AI vision OCR error: ${err.message}`,
    };
  } finally {
    if (_timer) clearTimeout(_timer);
  }
}

// 判断当前是否存在可用的视觉模型/原生收图通道——用于决定本地 OCR 之后是否值得动网络。
// 复用既有 SSOT:adapterVisionCapability(原生收图适配器,如 codex)、visionCapability
// (按 model id 判定)、aiGateway.collectProviderSiblingModels(同 provider 兄弟模型)。
// best-effort:任何一步失败 → 视为「无视觉」(保守:宁可返回本地 OCR / 诚实失败,也绝不
// 级联重入网关)。env 经入参注入可测。
function computeVisionAvailable(env) {
  const e = env || process.env;
  try {
    const gateway = require('../services/gateway/aiGateway');
    const visionCap = require('../services/gateway/visionCapability');
    const adapterCap = require('../services/gateway/adapterVisionCapability');

    let active = null;
    try { active = gateway.getActiveAdapter(); } catch { active = null; }

    const adapterKey = (active && active.key) || e.GATEWAY_PREFERRED_ADAPTER || '';
    if (adapterCap.adapterHandlesImagesNatively(adapterKey, e)) return true;

    const model = (active && active.activeModel) || e.GATEWAY_PREFERRED_MODEL || '';
    if (model && visionCap.isVisionCapableModel(model, { env: e })) return true;

    if (model && typeof gateway.collectProviderSiblingModels === 'function') {
      let siblings = [];
      try { siblings = gateway.collectProviderSiblingModels(model); } catch { siblings = []; }
      if (visionCap.hasVisionCapableCandidate(siblings, { env: e })) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 可注入实现持有者:execute 经此对象调用,便于测试替换(stub python / gateway /
// vision 判定),不影响生产路径(默认即真实现)。
const _impl = { runPython, aiVisionOcr, computeVisionAvailable };

const _imageOcrTool = defineTool({
  name: 'imageOcr',
  description: 'Extract text from an image using OCR (local Tesseract or AI vision fallback)',
  category: 'filesystem',
  risk: 'low',
  isReadOnly: (input) => !input?.outputPath,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },
  isConcurrencySafe: true,

  aliases: ['ocr', 'image_to_text', 'recognize_text'],
  searchHint: 'OCR extract text from image recognize characters',

  inputSchema: {
    imagePath: { type: 'string', required: true, description: 'Path to the image file' },
    outputPath: { type: 'string', required: false, description: 'Save recognized text as an editable Word (.docx) file at this path' },
    lang: { type: 'string', required: false, description: 'OCR language (default: chi_sim+eng). Examples: eng, chi_sim, chi_tra+eng' },
    forceAi: { type: 'boolean', required: false, description: 'Force AI vision instead of local OCR' },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotDevicePath(input.imagePath),
      validateNotUNCPath(input.imagePath),
    );
  },

  getActivityDescription(input) {
    const name = input?.imagePath ? path.basename(input.imagePath) : 'image';
    return `识别图片文字：${name}`;
  },

  getToolUseSummary(input) {
    if (!input?.imagePath) return null;
    return `识别图片：${input.imagePath}`;
  },

  async execute(params) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const imagePath = resolvePath(params.imagePath, cwd);

    if (!fs.existsSync(imagePath)) {
      return { success: false, error: `Image not found: ${imagePath}` };
    }

    const ext = path.extname(imagePath).toLowerCase();
    if (!SUPPORTED_FORMATS.has(ext)) {
      return {
        success: false,
        error: `Unsupported image format: ${ext}. Supported: ${[...SUPPORTED_FORMATS].join(', ')}`,
      };
    }

    const stat = fs.statSync(imagePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      return {
        success: false,
        error: `Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 20MB)`,
      };
    }

    const lang = params.lang || 'chi_sim+eng';

    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();
    const outputDocx = params.outputPath ? resolvePath(params.outputPath, cwd) : null;
    if (outputDocx) {
      // [SAFE] resolvePath() expands ~/$VAR/%VAR% to an ABSOLUTE host path that
      // validateInput() never confined. Without this the Agent could WRITE the
      // recognized-text .docx anywhere — clobber a user's documents or seed a
      // watched/auto-run dir (arbitrary write / privilege escalation). Confine the
      // expanded write target to the project tree or the user's own home/Desktop/
      // Documents/Downloads, mirroring the createDocument fix. (The imagePath READ
      // is intentionally left unconfined: media tools legitimately OCR transient
      // files under /tmp and session dirs, and the read is ext-gated, not a raw
      // secret-byte primitive.)
      const { validateNoPathTraversal } = require('./inputValidators');
      const outCheck = validateNoPathTraversal(outputDocx);
      if (!outCheck.valid) return { success: false, error: outCheck.message };
    }

    // 「不级联 + 有界 + local-OCR 优先」策略门控(KHY_IMAGE_OCR_NO_CASCADE,默认开)。
    // 关闭 → 逐字节回退到旧路径(本地失败即无条件 AI 视觉、无总超时)。
    let policy = null;
    try { policy = require('../services/gateway/imageOcrFallbackPolicy'); } catch { policy = null; }
    const policyOn = !!(policy && policy.isNoCascadeEnabled(process.env));
    const totalMs = policy ? policy.getTotalTimeoutMs(process.env) : 0;
    const ocrOpts = policyOn ? { totalMs } : {};
    const visionOpts = policyOn ? { totalMs } : {};

    if (!policyOn) {
      // ── 门控关:旧行为(逐字节) ──
      if (params.forceAi) {
        const result = await _impl.aiVisionOcr(imagePath);
        if (result.success && outputDocx) {
          return saveTextAsDocx(pythonPath, result.text, outputDocx, result);
        }
        return result;
      }
      let localResult;
      try {
        localResult = await _impl.runPython(pythonPath, [DOC_HELPER, 'ocr', imagePath, lang]);
      } catch {
        localResult = { success: false, needsAiFallback: true };
      }
      if (localResult.success && !localResult.needsAiFallback) {
        const result = {
          success: true,
          text: localResult.text,
          confidence: localResult.confidence,
          method: 'tesseract',
          lang: localResult.lang,
        };
        if (outputDocx) {
          return saveTextAsDocx(pythonPath, result.text, outputDocx, result);
        }
        return result;
      }
      const aiResult = await _impl.aiVisionOcr(imagePath);
      if (localResult.success && localResult.text) {
        aiResult.localText = localResult.text;
        aiResult.localConfidence = localResult.confidence;
      }
      if (aiResult.success && outputDocx) {
        return saveTextAsDocx(pythonPath, aiResult.text, outputDocx, aiResult);
      }
      return aiResult;
    }

    // ── 门控开:local-OCR 优先 + 有界 + 无视觉模型绝不重入网关 ──
    const visionAvailable = _impl.computeVisionAvailable(process.env);

    // forceAi 且确有视觉模型:直接走有界视觉(尊重显式意图,不必先跑本地)。
    if (params.forceAi && visionAvailable) {
      const result = await _impl.aiVisionOcr(imagePath, visionOpts);
      if (result.success && outputDocx) {
        return saveTextAsDocx(pythonPath, result.text, outputDocx, result);
      }
      return result;
    }

    // 本地 Tesseract OCR 优先(有界总超时),离线、不动网络。
    let localResult;
    try {
      localResult = await _impl.runPython(pythonPath, [DOC_HELPER, 'ocr', imagePath, lang], ocrOpts);
    } catch {
      localResult = { success: false, needsAiFallback: true };
    }

    const decision = policy.decideImageOcrNext({
      localSuccess: !!localResult.success,
      localHasText: !!localResult.text,
      localNeedsAiFallback: !!localResult.needsAiFallback,
      visionAvailable,
      forceAi: !!params.forceAi,
    });

    if (decision.action === 'use-local') {
      const result = {
        success: true,
        text: localResult.text,
        confidence: localResult.confidence,
        method: 'tesseract',
        lang: localResult.lang,
      };
      if (localResult.needsAiFallback) result.lowConfidence = true;
      // 无视觉模型时如实标注「已用本地 OCR」,绝不伪装成视觉识别。
      if (!visionAvailable) result.note = '当前无可用视觉模型，已使用本地 OCR 识别结果';
      if (outputDocx) {
        return saveTextAsDocx(pythonPath, result.text, outputDocx, result);
      }
      return result;
    }

    if (decision.action === 'fail-honest') {
      // 无视觉模型且本地取不到文字:如实失败,绝不重入网关级联、绝不编造图像内容。
      return {
        success: false,
        error: policy.buildNoVisionNoTextMessage({ count: 1 }),
        method: 'none',
        visionAvailable: false,
        reason: decision.reason,
      };
    }

    // decision.action === 'try-vision':单次有界 AI 视觉(确有视觉模型才到这)。
    const aiResult = await _impl.aiVisionOcr(imagePath, visionOpts);
    if (localResult.success && localResult.text) {
      aiResult.localText = localResult.text;
      aiResult.localConfidence = localResult.confidence;
    }
    if (aiResult.success && outputDocx) {
      return saveTextAsDocx(pythonPath, aiResult.text, outputDocx, aiResult);
    }
    return aiResult;
  },
});

async function saveTextAsDocx(pythonPath, text, outputPath, ocrResult) {
  try {
    const docResult = await runPython(pythonPath, [DOC_HELPER, 'text2docx', text, outputPath]);
    if (docResult.success) {
      return {
        ...ocrResult,
        output: docResult.output,
        outputSize: docResult.outputSize,
        message: docResult.message,
      };
    }
    // Word save failed, but OCR succeeded — return text with a warning
    return { ...ocrResult, warning: `OCR succeeded but Word save failed: ${docResult.error}` };
  } catch (err) {
    return { ...ocrResult, warning: `OCR succeeded but Word save failed: ${err.message}` };
  }
}

// 测试注入入口:defineTool 返回的工具对象是 Object.freeze 的,无法挂属性;改用
// Symbol.for 注册表共享同一个 _impl 引用,测试替换 _impl.{runPython,aiVisionOcr,
// computeVisionAvailable} 即可 stub python / gateway / vision 判定。生产路径从不读取它。
globalThis[Symbol.for('khyos.imageOcr.__impl')] = _impl;

module.exports = _imageOcrTool;
