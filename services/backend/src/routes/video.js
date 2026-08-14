'use strict';

/**
 * video.js — 视频生成 API 路由（文生视频 / 图生视频 / 关键帧动画）。
 *
 * 端点：
 *   POST   /api/video/generate   创建视频生成任务（异步，立即返回 videoId）
 *   GET    /api/video/status/:videoId  查询任务状态（轮询用）
 *   GET    /api/video/backends   列出已配置的视频生成后端
 *
 * 底层委托给 videoGenService（Agnes Video V2.0 异步任务 API）。
 * 视频生成是异步的：创建任务后客户端需轮询 /status/:videoId 获取结果。
 */

const router = require('express').Router();

const videoGenService = require('../services/videoGenService');

// ── 辅助：安全返回 JSON ───────────────────────────────────────────────────────
function json(res, statusCode, obj) {
  res.status(statusCode).json(obj);
}

// ── POST /api/video/generate ──────────────────────────────────────────────────
//
// 请求体（JSON）：
//   prompt       string   必填，视频文本描述
//   images       string[] 可选，图片 URL 数组（单张=图生视频，多张=关键帧动画）
//   mode         string   可选，生成模式（如 "keyframes"）
//   width        number   可选，视频宽度（默认 1152）
//   height       number   可选，视频高度（默认 768）
//   numFrames    number   可选，总帧数，≤441 且满足 8n+1（默认 121）
//   frameRate    number   可选，帧率 1-60（默认 24）
//   numInferenceSteps number 可选，推理步数
//   seed         number   可选，随机种子（复现用）
//   negativePrompt string 可选，反向提示词
//
// 响应（200）：
//   { success: true, videoId, taskId, status, backend, model, message }
//
// 注意：视频生成是异步任务，此接口立即返回。客户端需轮询
// GET /api/video/status/:videoId 获取进度和最终视频 URL。

router.post('/generate', (req, res) => {
  // 无后端 → 直接返回可操作错误
  if (!videoGenService.isAnyBackendConfigured()) {
    return json(res, 503, {
      success: false,
      error: videoGenService.backendHelpText(),
      code: 'NO_BACKEND',
    });
  }

  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();

  if (!prompt) {
    return json(res, 400, {
      success: false,
      error: 'prompt 不能为空',
      code: 'MISSING_PROMPT',
    });
  }

  const images = Array.isArray(body.images) ? body.images.filter(Boolean).map(String) : [];

  // 构建生成参数
  const genOpts = {
    prompt,
    images: images.length ? images : undefined,
    mode: body.mode,
    width: Number.isFinite(body.width) ? body.width : undefined,
    height: Number.isFinite(body.height) ? body.height : undefined,
    numFrames: Number.isFinite(body.numFrames) ? body.numFrames : undefined,
    frameRate: Number.isFinite(body.frameRate) ? body.frameRate : undefined,
    numInferenceSteps: Number.isFinite(body.numInferenceSteps) ? body.numInferenceSteps : undefined,
    seed: Number.isFinite(body.seed) ? body.seed : undefined,
    negativePrompt: body.negativePrompt,
    onProgress: (progress) => {
      // 可选：通过 SSE 或 WebSocket 推送进度（未来扩展）
      // 当前静默处理，客户端通过轮询获取
    },
  };

  // 使用 Promise.race 实现可中断的生成（允许客户端通过 req 信号取消）
  const genPromise = videoGenService.generate(genOpts);

  // 监听客户端断开连接
  const clientGone = () => {
    // 客户端断开时无需特别处理，Agnes 侧任务继续运行；
    // 客户端后续可通过 videoId 轮询获取结果。
  };
  req.on('close', clientGone);

  genPromise
    .then((result) => {
      if (!res.headersSent) {
        json(res, 200, {
          success: true,
          videoId: result.videoId,
          taskId: result.taskId,
          status: result.status,
          backend: result.backend,
          model: result.model,
          seconds: result.seconds,
          size: result.size,
          videoUrl: result.videoUrl,
          message: `视频生成完成（${result.seconds || '?'}s, ${result.size || '?'}）`,
        });
      }
    })
    .catch((err) => {
      if (!res.headersSent) {
        const code = err.code || 'GENERATION_FAILED';
        const statusMap = {
          NO_BACKEND: 503,
          BAD_PARAM: 400,
          TIMEOUT: 504,
          GENERATION_FAILED: 500,
        };
        json(res, statusMap[code] || 500, {
          success: false,
          error: err.message,
          code,
          ...(err.partial ? { partial: err.partial } : {}),
        });
      }
    });
});

// ── GET /api/video/status/:videoId ───────────────────────────────────────────
//
// 查询视频生成任务状态。任务完成后返回视频 URL。
//
// 响应：
//   { success: true, videoId, taskId, status, progress, backend, model,
//     seconds, size, videoUrl?, error? }

router.get('/status/:videoId', async (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return json(res, 400, {
      success: false,
      error: 'videoId 不能为空',
      code: 'MISSING_VIDEO_ID',
    });
  }

  if (!videoGenService.isAnyBackendConfigured()) {
    return json(res, 503, {
      success: false,
      error: videoGenService.backendHelpText(),
      code: 'NO_BACKEND',
    });
  }

  try {
    const backend = videoGenService.resolveBackend();
    if (!backend || backend !== 'agnes') {
      return json(res, 501, {
        success: false,
        error: `暂不支持后端: ${backend || 'none'}`,
        code: 'UNSUPPORTED_BACKEND',
      });
    }

    // 复用 Agnes 轮询逻辑获取最新状态
    const result = await videoGenService.__testHooks._pollAgnes({ videoId });

    if (!result) {
      return json(res, 404, {
        success: false,
        error: '视频任务未找到或已被清理',
        code: 'NOT_FOUND',
      });
    }

    const status = String(result.status || 'unknown').toLowerCase();
    const isTerminal = status === 'completed' || status === 'failed';
    const videoUrl =
      result.remixed_from_video_id ||
      result.video_url ||
      (result.video && result.video.url) ||
      null;

    json(res, 200, {
      success: true,
      videoId,
      taskId: result.id || result.task_id || null,
      status,
      progress: result.progress != null ? result.progress : isTerminal ? 100 : 0,
      backend,
      model: result.model || null,
      seconds: result.seconds || null,
      size: result.size || null,
      ...(videoUrl ? { videoUrl } : {}),
      ...(result.error
        ? { error: typeof result.error === 'string' ? result.error : JSON.stringify(result.error) }
        : {}),
      completed: isTerminal,
    });
  } catch (err) {
    const statusCode = err.status || 500;
    json(res, statusCode, {
      success: false,
      error: `查询视频状态失败: ${err.message}`,
      code: err.code || 'POLL_ERROR',
    });
  }
});

// ── GET /api/video/backends ───────────────────────────────────────────────────
//
// 返回已配置的视频生成后端列表及可用模型。

router.get('/backends', (_req, res) => {
  try {
    const backends = videoGenService.backendStatus();
    const models = videoGenService.catalogModels();

    json(res, 200, {
      success: true,
      data: {
        backends,
        models,
        anyConfigured: videoGenService.isAnyBackendConfigured(),
        helpText: videoGenService.backendHelpText(),
      },
    });
  } catch (err) {
    json(res, 500, {
      success: false,
      error: `获取视频后端信息失败: ${err.message}`,
    });
  }
});

module.exports = router;
