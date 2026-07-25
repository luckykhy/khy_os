'use strict';

/**
 * imageEdit — image-to-image editing / compositing tool (图改图 / 图生图 / 换背景 /
 * 局部编辑 / 多图合成).
 *
 * Complements imageGenerate (text-to-image): this tool takes one or more INPUT
 * images plus an editing prompt and routes them to an edit-capable image backend
 * (currently Agnes — see services/imageGenService.js). Local image paths are read
 * and encoded as data: URIs; public HTTP(S) URLs are passed through as-is. The
 * result is saved to disk and previewed, mirroring imageGenerate's contract.
 *
 * Backend selection and credentials are env-driven (zero-hardcoding). If no
 * edit-capable backend is configured, the tool returns clear setup guidance
 * instead of failing silently.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { guardedReadFileSync } = require('./guardedReadFileSync');

const imageGenService = require('../services/imageGenService');
const imageService = require('../services/imageService');
const toolErrorCodes = require('../services/toolErrorCodes');

const SUPPORTED_SIZES = ['256x256', '512x512', '768x768', '1024x1024', '1024x768', '768x1024', '1024x1792', '1792x1024'];
const MAX_INPUT_IMAGES = 4;
const MAX_INPUT_BYTES = 12 * 1024 * 1024; // 12 MiB per input image (data-URI payloads get large)

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Resolve a user path with Windows %VAR% / ~ expansion (mirrors imageGenerate). */
const _resolvePath = require('../utils/resolveToolPath');

/** Turn one input ref (URL or local path) into something the backend accepts. */
function _toImageRef(ref, cwd) {
  const s = String(ref || '').trim();
  if (!s) throw new Error('输入图片引用为空');
  // Public URL or already a data: URI → pass through untouched.
  if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  // Otherwise treat as a local file path → read + encode as a data: URI.
  const abs = _resolvePath(s, cwd);
  const { validateNoPathTraversal } = require('./inputValidators');
  const confine = validateNoPathTraversal(abs);
  if (!confine.valid) throw new Error(confine.message);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`输入图片不存在或不是文件: ${s}`);
  }
  const bytes = fs.statSync(abs).size;
  if (bytes > MAX_INPUT_BYTES) {
    throw new Error(`输入图片过大（${(bytes / 1048576).toFixed(1)}MB > 12MB）: ${s}`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw new Error(`不支持的图片格式 ${ext || '(无扩展名)'}（支持 png/jpg/jpeg/webp/gif）: ${s}`);
  // 读前防卡死前检:用户传入的图片路径若是 FIFO/设备/阻塞伪文件,同步 readFileSync 会永久冻结事件循环。
  const b64 = guardedReadFileSync(abs).toString('base64');
  return `data:${mime};base64,${b64}`;
}

module.exports = defineTool({
  name: 'image_edit',
  description:
    'Edit or transform existing image(s) from a text prompt (image-to-image / 图改图 / 图生图 / '
    + '换背景 / 局部编辑 / 多图合成 / inpaint / restyle). Takes one or more input images '
    + '(local file paths or public URLs) plus an editing instruction, and produces a new image. '
    + 'Use this when the user provides a source image to modify; use image_generate for text-only generation. '
    + 'Requires an edit-capable backend (Agnes); returns clear setup instructions if none is configured.',
  category: 'analysis',
  risk: 'low',
  isReadOnly: false,
  isConcurrencySafe: true,
  searchHint: 'image edit img2img image-to-image 图改图 图生图 换背景 局部编辑 多图合成 restyle inpaint',
  aliases: [
    'imageEdit', 'edit_image', 'image_to_image', 'img2img',
    '图改图', '图生图', '改图', '换背景', '局部编辑', '多图合成',
  ],

  inputSchema: {
    prompt: {
      type: 'string',
      required: true,
      maxLength: 4000,
      description: 'Editing instruction: what to change and what to preserve (English or Chinese).',
    },
    images: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Input image(s): local file path(s) or public HTTP(S) URL(s). 1-4 items. '
        + 'Multiple images enable compositing (e.g. combine characters into one scene).',
    },
    size: {
      type: 'string',
      enum: SUPPORTED_SIZES,
      default: '1024x1024',
      description: 'Output image size as WxH. Default 1024x1024.',
    },
    outputPath: {
      type: 'string',
      maxLength: 4096,
      description: 'Optional file path (or directory) to save the result. Defaults to a temp file.',
    },
  },

  async validateInput(input) {
    if (!input || !input.prompt || !String(input.prompt).trim()) {
      return { valid: false, message: 'prompt is required and cannot be empty.' };
    }
    const imgs = Array.isArray(input.images) ? input.images.filter(Boolean) : [];
    if (!imgs.length) {
      return { valid: false, message: 'images is required: provide at least one input image path or URL.' };
    }
    if (imgs.length > MAX_INPUT_IMAGES) {
      return { valid: false, message: `too many input images (${imgs.length} > ${MAX_INPUT_IMAGES}).` };
    }
    if (input.outputPath) {
      const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
      return composeValidations(
        validateNotDevicePath(input.outputPath),
        validateNotUNCPath(input.outputPath),
      );
    }
    return { valid: true };
  },

  getActivityDescription(input) {
    const p = input && input.prompt ? String(input.prompt) : '';
    const short = p.length > 30 ? `${p.slice(0, 30)}…` : p;
    return `图改图：${short}`;
  },

  async execute(params, _context) {
    const startedAt = Date.now();
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const prompt = params && params.prompt ? String(params.prompt) : '';
    const size = (params && params.size) || '1024x1024';

    // ── Resolve input images (read local files → data URIs) ────────────────────
    let images;
    try {
      const refs = Array.isArray(params && params.images) ? params.images.filter(Boolean) : [];
      images = refs.map((r) => _toImageRef(r, cwd));
    } catch (err) {
      const error = `输入图片处理失败：${err.message}`;
      return toolErrorCodes.enrich({ success: false, code: 'BAD_INPUT_IMAGE', error, content: error });
    }

    // ── Edit ───────────────────────────────────────────────────────────────────
    let result;
    try {
      result = await imageGenService.generate({ prompt, size, images });
    } catch (err) {
      if (err && (err.code === 'NO_BACKEND' || err.code === 'EDIT_UNSUPPORTED')) {
        return toolErrorCodes.enrich({ success: false, code: err.code, error: err.message, content: err.message, meta: { backend: imageGenService.resolveBackend() } });
      }
      const backend = imageGenService.resolveBackend();
      const error = `图改图失败（后端 ${backend || 'unknown'}）：${err.message}`;
      return toolErrorCodes.enrich({ success: false, code: err && err.code ? err.code : 'BACKEND_ERROR', error, content: error, meta: { backend } });
    }

    // ── Save result ──────────────────────────────────────────────────────────────
    const paths = [];
    try {
      for (let i = 0; i < result.images.length; i++) {
        const b64 = result.images[i].base64;
        let savedPath = null;
        if (i === 0 && params && params.outputPath) {
          let target = _resolvePath(params.outputPath, cwd);
          // [SAFE] Same arbitrary-write hardening as imageGenerate: confine the
          // expanded absolute target to the project tree / the user's own home
          // before any mkdir/write (this sink writes raw bytes recursively).
          {
            const { validateNoPathTraversal } = require('./inputValidators');
            const confineCheck = validateNoPathTraversal(target);
            if (!confineCheck.valid) {
              return { success: false, error: confineCheck.message };
            }
          }
          if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
            target = path.join(target, `image_edit_${Date.now()}.png`);
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
          }
          fs.writeFileSync(target, Buffer.from(b64, 'base64'));
          savedPath = target;
        } else {
          savedPath = imageService.saveBase64ToTemp(b64, 'image/png');
        }
        if (savedPath) {
          paths.push(savedPath);
          try {
            imageService.printImagePreview({
              base64: b64,
              format: 'png',
              sizeBytes: Buffer.byteLength(b64, 'base64'),
              mimeType: 'image/png',
            });
          } catch { /* preview is non-essential */ }
        }
      }
    } catch (err) {
      const error = `图改图成功但写入磁盘失败：${err.message}`;
      return { success: false, error, content: error, meta: { backend: result.backend, model: result.model } };
    }

    if (!paths.length) {
      const error = '图改图成功但未能保存任何文件。';
      return { success: false, error, content: error, meta: { backend: result.backend, model: result.model } };
    }

    const content = `已编辑生成 ${paths.length} 张图像：\n${paths.map((p) => `- ${p}`).join('\n')}`;
    return {
      success: true,
      content,
      meta: {
        backend: result.backend,
        model: result.model,
        provider: result.backend,
        size: result.size,
        inputCount: images.length,
        edited: true,
        paths,
        format: 'png',
        durationMs: Date.now() - startedAt,
      },
    };
  },
});
