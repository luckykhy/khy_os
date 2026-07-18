'use strict';

/**
 * imageGenerate — text-to-image generation tool (绘图 / 文生图 / 漫画).
 *
 * Fills the long-standing gap where the gateway capabilityRegistry recognized a
 * drawing intent (image_gen) but no callable tool existed, so the model returned
 * empty text. This tool routes a prompt to a configurable image backend
 * (OpenAI-compatible / domestic API / local Stable Diffusion WebUI), saves the
 * result(s) to disk, previews them, and reports the backend/model it used.
 *
 * Backend selection and credentials are env-driven (zero-hardcoding); see
 * services/imageGenService.js. All multi-backend HTTP/proxy/base64 plumbing
 * lives there — this file is the thin tool contract, mirroring how imageDetect
 * delegates to imageService.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');

const imageGenService = require('../services/imageGenService');
const imageService = require('../services/imageService');
const toolErrorCodes = require('../services/toolErrorCodes');

const SUPPORTED_SIZES = ['256x256', '512x512', '768x768', '1024x1024', '1024x768', '768x1024', '1024x1792', '1792x1024'];

/** Resolve a user path with Windows %VAR% / ~ expansion (mirrors imageDetect). */
const _resolvePath = require('../utils/resolveToolPath');

module.exports = defineTool({
  name: 'image_generate',
  description:
    'Generate an image from a text prompt (text-to-image / 文生图 / 绘图 / 画图 / draw / comic). '
    + 'Routes to a configurable backend (OpenAI-compatible, a domestic API, or a local Stable Diffusion WebUI). '
    + 'Saves the generated image(s) to disk and returns their file paths. '
    + 'If no backend is configured, returns clear setup instructions instead of failing silently.',
  category: 'analysis',
  risk: 'low',
  isReadOnly: false,
  isConcurrencySafe: true,
  searchHint: 'image generate draw picture comic text-to-image 文生图 绘图 画图 生成图片',
  aliases: [
    'imageGenerate', 'generate_image', 'draw_image', 'text_to_image',
    '文生图', '生成图片', '绘图', '画图', '生成图像',
  ],

  inputSchema: {
    prompt: {
      type: 'string',
      required: true,
      maxLength: 4000,
      description: 'Text description of the image to generate (English or Chinese).',
    },
    negativePrompt: {
      type: 'string',
      maxLength: 2000,
      description: 'Things to avoid in the image. Used by Stable Diffusion / domestic backends; ignored by OpenAI.',
    },
    size: {
      type: 'string',
      enum: SUPPORTED_SIZES,
      default: '1024x1024',
      description: 'Image size as WxH. Default 1024x1024.',
    },
    n: {
      type: 'number',
      min: 1,
      max: 4,
      default: 1,
      description: 'Number of images to generate (1-4).',
    },
    outputPath: {
      type: 'string',
      maxLength: 4096,
      description: 'Optional file path (or directory) to save the first image. Defaults to a temp file.',
    },
    seed: {
      type: 'number',
      description: 'Optional random seed for reproducibility (honored by SD / some domestic backends).',
    },
  },

  async validateInput(input) {
    if (!input || !input.prompt || !String(input.prompt).trim()) {
      return { valid: false, message: 'prompt is required and cannot be empty.' };
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
    return `生成图像：${short}`;
  },

  async execute(params, _context) {
    const startedAt = Date.now();
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const prompt = params && params.prompt ? String(params.prompt) : '';
    const size = (params && params.size) || '1024x1024';
    const n = Math.max(1, Math.min(4, parseInt(params && params.n, 10) || 1));

    // Per-user image-model preference (graceful): when the tool loop carries an
    // authenticated userId, honor that user's pinned backend/model; otherwise the
    // override stays undefined and imageGenService falls back to global env/auto.
    let userPref = null;
    try {
      const userId = _context && _context.traceContext && _context.traceContext.userId;
      if (userId != null) {
        userPref = await require('../services/imageGenUserPref').getUserImagePref(userId);
      }
    } catch { /* fail-soft: fall back to global/auto */ }

    // ── Generate ──────────────────────────────────────────────────────────────
    let result;
    try {
      result = await imageGenService.generate({
        prompt,
        negativePrompt: params && params.negativePrompt,
        size,
        n,
        seed: params && Number.isFinite(params.seed) ? params.seed : undefined,
        backend: userPref ? userPref.backend : undefined,
        model: userPref && userPref.model ? userPref.model : undefined,
      });
    } catch (err) {
      // Honest failure summary + "configure a key?" invite (imageGenFailureSummary,
      // gated KHY_IMAGE_GEN_FAILURE_SUMMARY / fail-soft). Applies to the degradation
      // chain's tail: NO_USABLE_KEY (every bridged/known image key rejected) and to
      // auth/rate/timeout/network backend errors. When the leaf returns null (gate
      // off / anything odd) we byte-revert to today's plain-message branches below.
      const backend = imageGenService.resolveBackend();
      let summary = null;
      try {
        summary = require('../services/imageGenFailureSummary').buildImageGenFailureMessage({
          rawError: err && err.message ? err.message : String(err),
          backend: backend || (err && err.code === 'NO_BACKEND' ? null : undefined),
          model: (userPref && userPref.model) || undefined,
          env: process.env,
        });
      } catch { summary = null; }

      if (err && err.code === 'NO_USABLE_KEY') {
        // All known image-capable keys were tried and rejected/cooled down → invite
        // the user to paste a key (model then routes it to configureModelProvider).
        const content = summary || err.message;
        return toolErrorCodes.enrich({ success: false, code: 'CONFIG_MISSING', error: content, content, meta: { backend: backend || null } });
      }

      if (err && err.code === 'NO_BACKEND') {
        // Clear, actionable guidance — not an empty reply. `code` is the
        // machine-readable channel; `error`/`content` are for human display.
        // `errorClass`(经 toolErrorCodes)再叠一层语义分类:CONFIG_MISSING,供调用方
        // 与「服务不可用」区分(P2#5)。When the summary leaf classifies this as a
        // key problem (no available key across whitelisted providers), prefer its
        // "configure a key?" invite; else keep the raw backend help text.
        const content = summary || err.message;
        return toolErrorCodes.enrich({ success: false, code: 'NO_BACKEND', error: content, content, meta: { backend: null } });
      }

      const error = summary || `图像生成失败（后端 ${backend || 'unknown'}）：${err.message}`;
      return toolErrorCodes.enrich({ success: false, code: err && err.code ? err.code : 'BACKEND_ERROR', error, content: error, meta: { backend } });
    }

    // ── Save images ─────────────────────────────────────────────────────────────
    const paths = [];
    try {
      for (let i = 0; i < result.images.length; i++) {
        const b64 = result.images[i].base64;
        let savedPath = null;
        if (i === 0 && params && params.outputPath) {
          let target = _resolvePath(params.outputPath, cwd);
          // [SAFE] validateInput() only ran UNC/device checks on the RAW
          // outputPath; _resolvePath() expands ~/$VAR/%VAR% to an ABSOLUTE host
          // path. This is the most dangerous write sink in the toolset: unlike
          // the .docx tools it writes RAW BYTES with NO suffix constraint and
          // mkdirSyncs parents recursively — an unconfined Agent could drop
          // ~/.ssh/authorized_keys, overwrite ~/.bashrc, plant a .so or a cron
          // file ANYWHERE (full arbitrary-write privilege escalation). Confine the
          // expanded target to the project tree or the user's own home/Desktop/
          // Documents/Downloads before any mkdir/write.
          {
            const { validateNoPathTraversal } = require('./inputValidators');
            const confineCheck = validateNoPathTraversal(target);
            if (!confineCheck.valid) {
              return { success: false, error: confineCheck.message };
            }
          }
          // Directory target → generate a filename inside it.
          if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
            target = path.join(target, `image_${Date.now()}.png`);
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
          // Best-effort terminal preview (no-op under TUI / non-iTerm).
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
      const error = `图像生成成功但写入磁盘失败：${err.message}`;
      return { success: false, error, content: error, meta: { backend: result.backend, model: result.model } };
    }

    if (!paths.length) {
      const error = '图像生成成功但未能保存任何文件。';
      return { success: false, error, content: error, meta: { backend: result.backend, model: result.model } };
    }

    const content = `已生成 ${paths.length} 张图像：\n${paths.map((p) => `- ${p}`).join('\n')}`;
    return {
      success: true,
      content,
      meta: {
        backend: result.backend,
        model: result.model,
        provider: result.backend,
        size: result.size,
        n: result.n,
        paths,
        format: 'png',
        seed: params && Number.isFinite(params.seed) ? params.seed : undefined,
        durationMs: Date.now() - startedAt,
      },
    };
  },
});
