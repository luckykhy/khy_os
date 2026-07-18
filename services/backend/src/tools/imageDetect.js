/**
 * imageDetect — image object detection / visual analysis tool.
 *
 * Capability: "图像识别" (image recognition / object detection). Routes an image
 * to a vision-capable LLM and returns structured detections — objects, their
 * approximate locations, counts, scene description, and optionally text or
 * specific attributes the caller asks about.
 *
 * Strategy: mirrors imageOcr.aiVisionOcr — read file → base64 → gateway.generate
 * with a detection-tuned prompt. All multi-provider vision plumbing
 * (_imageCompat, per-adapter formatting, capability routing, OCR fallback) is
 * reused automatically by aiGateway.
 *
 * Zero-hardcoding rule: no model is hardcoded; aiGateway selects a vision-capable
 * adapter via its capability registry. State transparency: meta reports the
 * model/provider that answered and the detection mode.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { guardedReadFileSync } = require('./guardedReadFileSync');

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

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

// ─── Detection prompts by mode ───────────────────────────────────────────────

const DETECTION_PROMPTS = {
  objects:
    'Detect and list all distinct objects in this image. For each object provide: '
    + 'a label, an approximate count, and its rough position (e.g. top-left, center, bottom-right). '
    + 'Return a compact Markdown table with columns: Object | Count | Position | Notes. '
    + 'After the table, add a one-sentence scene summary. Be precise; do not invent objects.',
  scene:
    'Describe this image: the overall scene, setting, main subjects, notable activities, '
    + 'colors, and mood. Then list the 5 most prominent objects. Keep it factual and concise.',
  faces:
    'Analyze people in this image. Report: number of people, their approximate positions, '
    + 'visible attributes (posture, apparent activity, clothing colors). '
    + 'Do NOT guess identity, age, gender, ethnicity, or emotion as fact — describe only what is visibly present.',
  text:
    'Detect any text visible in this image (signs, labels, UI, documents). '
    + 'For each text region report the text content and its position. '
    + 'Preserve layout. If there is no text, say so.',
};

/**
 * Build the effective prompt for a detection request.
 * @param {string} mode
 * @param {string} query - optional caller-specified focus
 * @returns {string}
 */
function _buildPrompt(mode, query) {
  const base = DETECTION_PROMPTS[mode] || DETECTION_PROMPTS.objects;
  if (query && query.trim()) {
    return `${base}\n\nAdditionally, focus on this specific request: "${query.trim()}". `
      + 'Answer it directly using only what is visible in the image.';
  }
  return base;
}

const _resolvePath = require('../utils/resolveToolPath');

// ─── Tool Definition ─────────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'image_detect',
  description:
    'Detect objects and analyze the content of an image using a vision-capable model. '
    + 'Modes: objects (list objects with counts and positions), scene (describe the whole image), '
    + 'faces (analyze people without guessing identity), text (detect visible text). '
    + 'Optionally pass a query to focus on a specific question about the image.',
  category: 'analysis',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'image object detection vision recognize analyze picture',
  aliases: ['imageDetect', 'detect_objects', 'image_recognition', 'analyze_image', '图像识别', '物体检测', '识别图片'],

  inputSchema: {
    imagePath: {
      type: 'string',
      required: true,
      maxLength: 4096,
      description: 'Path to the image file (.png/.jpg/.jpeg/.webp/.gif/.bmp/.tiff).',
    },
    mode: {
      type: 'string',
      enum: ['objects', 'scene', 'faces', 'text'],
      default: 'objects',
      description: 'Detection mode: objects (default), scene, faces, or text.',
    },
    query: {
      type: 'string',
      maxLength: 500,
      description: 'Optional specific question to focus the analysis (e.g. "how many cars are red?").',
    },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotDevicePath(input.imagePath),
      validateNotUNCPath(input.imagePath),
    );
  },

  getActivityDescription(input) {
    const name = input && input.imagePath ? path.basename(String(input.imagePath)) : 'image';
    const mode = (input && input.mode) || 'objects';
    return `图像识别(${mode})：${name}`;
  },

  async execute(params, _context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const imagePath = _resolvePath(params && params.imagePath, cwd);
    const mode = (params && params.mode) || 'objects';
    const query = params && params.query ? String(params.query) : '';

    // ── Validation ───────────────────────────────────────────────────────────
    if (!fs.existsSync(imagePath)) {
      const error = `Image not found: ${imagePath}`;
      return { success: false, error, content: error, meta: { mode } };
    }

    const ext = path.extname(imagePath).toLowerCase();
    if (!SUPPORTED_FORMATS.has(ext)) {
      const error = `Unsupported image format: ${ext}. Supported: ${[...SUPPORTED_FORMATS].join(', ')}`;
      return { success: false, error, content: error, meta: { mode } };
    }

    const stat = fs.statSync(imagePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      const error = `Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 20MB)`;
      return { success: false, error, content: error, meta: { mode } };
    }

    // ── Read + base64 ────────────────────────────────────────────────────────
    let base64;
    try {
      // 读前防卡死前检:用户传入的图片路径若是 FIFO/设备/阻塞伪文件,同步读会冻结事件循环;
      // guardedReadFileSync 预检后对阻塞类抛 EREADHANG,由下方 catch 转成清晰的读取失败信息。
      base64 = guardedReadFileSync(imagePath).toString('base64');
    } catch (err) {
      const error = `Failed to read image: ${err.message}`;
      return { success: false, error, content: error, meta: { mode } };
    }
    const mimeType = MIME_MAP[ext] || 'image/jpeg';

    // ── Vision model call ────────────────────────────────────────────────────
    let result;
    try {
      const gateway = require('../services/gateway/aiGateway');
      result = await gateway.generate(_buildPrompt(mode, query), {
        images: [{ base64, mimeType }],
        maxTokens: 2048,
        temperature: 0.2,
      });
    } catch (err) {
      const error = `Vision model error: ${err.message}`;
      return { success: false, error, content: error, meta: { mode } };
    }

    if (!result || !result.success) {
      const error = `Image detection failed: ${(result && result.content) || 'no vision-capable model available'}.`;
      return {
        success: false,
        error,
        content: `${error} Ensure a vision-capable adapter (Claude/Qwen-VL/Codex) is configured.`,
        meta: { mode, model: (result && (result.model || result.provider)) || null },
      };
    }

    return {
      success: true,
      content: result.content,
      meta: {
        mode,
        model: result.model || result.provider || null,
        provider: result.provider || null,
        imageFormat: ext.slice(1),
        imageSizeBytes: stat.size,
        query: query || undefined,
      },
    };
  },
});
