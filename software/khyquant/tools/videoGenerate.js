'use strict';

/**
 * videoGenerate — text/image-to-video generation tool (文生视频 / 图生视频 /
 * 多图视频 / 关键帧动画 / text-to-video / image-to-video).
 *
 * KHY's first video-generation capability. Routes a prompt (and optional input
 * image URLs) to an async video backend (currently Agnes — see
 * services/videoGenService.js), waits for the task to finish, downloads the MP4
 * to disk, and reports the URL/path/duration it produced. If no backend is
 * configured it returns clear setup guidance instead of failing silently.
 *
 * Backend selection and credentials are env-driven (zero-hardcoding).
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');

const videoGenService = require('../services/videoGenService');
const toolErrorCodes = require('../services/toolErrorCodes');

/** Resolve a user path with Windows %VAR% / ~ expansion (mirrors imageGenerate). */
const _resolvePath = require('../utils/resolveToolPath');

module.exports = defineTool({
  name: 'video_generate',
  description:
    'Generate a video from a text prompt and optional input image(s) '
    + '(text-to-video / image-to-video / 文生视频 / 图生视频 / 多图视频 / 关键帧动画 / keyframe animation). '
    + 'Asynchronous: the tool submits the job, polls until completion, downloads the MP4, and returns its path. '
    + 'Routes to a configurable backend (Agnes). Returns clear setup instructions if no backend is configured.',
  category: 'analysis',
  risk: 'low',
  isReadOnly: false,
  isConcurrencySafe: true,
  searchHint: 'video generate text-to-video image-to-video 文生视频 图生视频 视频生成 关键帧 keyframe animation',
  aliases: [
    'videoGenerate', 'generate_video', 'text_to_video', 'image_to_video',
    '文生视频', '图生视频', '视频生成', '生成视频', '关键帧动画',
  ],

  inputSchema: {
    prompt: {
      type: 'string',
      required: true,
      maxLength: 4000,
      description: 'Text description of the video to generate (English or Chinese).',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional input image URL(s). One URL = image-to-video; multiple = multi-image / keyframes. Must be public HTTP(S) URLs.',
    },
    mode: {
      type: 'string',
      description: 'Optional generation mode, e.g. "keyframes" for keyframe interpolation between input images.',
    },
    width: { type: 'number', description: 'Video width (default backend-decided, e.g. 1152).' },
    height: { type: 'number', description: 'Video height (default backend-decided, e.g. 768).' },
    numFrames: {
      type: 'number',
      description: 'Total frames. Must be <= 441 and satisfy 8n+1 (e.g. 81, 121, 241, 441). Default 121 (~5s @ 24fps).',
    },
    frameRate: { type: 'number', min: 1, max: 60, description: 'Frames per second (1-60). Default 24.' },
    numInferenceSteps: {
      type: 'number',
      description: 'Optional denoising / inference steps (Agnes num_inference_steps). Higher = more refined but slower. Backend default when omitted.',
    },
    seed: { type: 'number', description: 'Optional random seed for reproducibility.' },
    negativePrompt: { type: 'string', maxLength: 2000, description: 'Things to avoid in the video.' },
    outputPath: {
      type: 'string',
      maxLength: 4096,
      description: 'Optional file path (or directory) to save the MP4. Defaults to a temp file.',
    },
  },

  async validateInput(input) {
    if (!input || !input.prompt || !String(input.prompt).trim()) {
      return { valid: false, message: 'prompt is required and cannot be empty.' };
    }
    // Fail fast on bad frame params (mirrors the service contract).
    try {
      videoGenService.validateFrameParams({
        numFrames: Number.isFinite(input.numFrames) ? input.numFrames : undefined,
        frameRate: Number.isFinite(input.frameRate) ? input.frameRate : undefined,
      });
    } catch (e) {
      return { valid: false, message: e.message };
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
    return `生成视频：${short}`;
  },

  async execute(params, _context) {
    const startedAt = Date.now();
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const prompt = params && params.prompt ? String(params.prompt) : '';
    const images = Array.isArray(params && params.images) ? params.images.filter(Boolean).map(String) : [];

    let result;
    try {
      result = await videoGenService.generate({
        prompt,
        images,
        mode: params && params.mode,
        width: params && Number.isFinite(params.width) ? params.width : undefined,
        height: params && Number.isFinite(params.height) ? params.height : undefined,
        numFrames: params && Number.isFinite(params.numFrames) ? params.numFrames : undefined,
        frameRate: params && Number.isFinite(params.frameRate) ? params.frameRate : undefined,
        numInferenceSteps: params && Number.isFinite(params.numInferenceSteps) ? params.numInferenceSteps : undefined,
        seed: params && Number.isFinite(params.seed) ? params.seed : undefined,
        negativePrompt: params && params.negativePrompt,
      });
    } catch (err) {
      if (err && (err.code === 'NO_BACKEND' || err.code === 'BAD_PARAM')) {
        return toolErrorCodes.enrich({ success: false, code: err.code, error: err.message, content: err.message, meta: { backend: videoGenService.resolveBackend() } });
      }
      const backend = videoGenService.resolveBackend();
      const error = `视频生成失败（后端 ${backend || 'unknown'}）：${err.message}`;
      return toolErrorCodes.enrich({
        success: false,
        code: err && err.code ? err.code : 'BACKEND_ERROR',
        error,
        content: error,
        meta: { backend, partial: err && err.partial },
      });
    }

    // ── Download MP4 ──────────────────────────────────────────────────────────
    let target;
    if (params && params.outputPath) {
      target = _resolvePath(params.outputPath, cwd);
      const { validateNoPathTraversal } = require('./inputValidators');
      const confine = validateNoPathTraversal(target);
      if (!confine.valid) return { success: false, error: confine.message };
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, `video_${Date.now()}.mp4`);
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
    } else {
      target = path.join(os.tmpdir(), `khy_video_${Date.now()}.mp4`);
    }

    let savedPath = null;
    try {
      savedPath = await videoGenService.downloadVideo(result.videoUrl, target);
    } catch (err) {
      // The video exists upstream even if the local download failed — surface the URL.
      const error = `视频生成成功但下载失败：${err.message}`;
      return toolErrorCodes.enrich({
        success: false,
        code: 'DOWNLOAD_FAILED',
        error,
        content: `${error}\n视频 URL：${result.videoUrl}`,
        meta: { backend: result.backend, model: result.model, videoUrl: result.videoUrl, videoId: result.videoId },
      });
    }

    const content = `已生成视频（${result.seconds || '?'}s, ${result.size || '?'}）：\n- ${savedPath}\n  源 URL：${result.videoUrl}`;
    return {
      success: true,
      content,
      meta: {
        backend: result.backend,
        model: result.model,
        provider: result.backend,
        videoId: result.videoId,
        taskId: result.taskId,
        videoUrl: result.videoUrl,
        path: savedPath,
        seconds: result.seconds,
        size: result.size,
        format: 'mp4',
        durationMs: Date.now() - startedAt,
      },
    };
  },
});
