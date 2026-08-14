'use strict';

/**
 * image.js — 图像生成 API 路由（文生图 / 图生图）。
 *
 * 端点：
 *   POST   /api/image/generate   生成图像（同步，立即返回 base64 或 URL）
 *   GET    /api/image/backends   列出已配置的图像生成后端及可用模型
 *
 * 底层委托给 imageGenService（支持 OpenAI / Agnes / 国内 API / 本地 SD WebUI）。
 * 与视频不同，图像生成是同步的：创建后直接返回结果。
 */

const router = require('express').Router();

const imageGenService = require('../services/imageGenService');
const toolErrorCodes = require('../services/toolErrorCodes');

// ── 辅助：安全返回 JSON ───────────────────────────────────────────────────────
function json(res, statusCode, obj) {
  res.status(statusCode).json(obj);
}

// ── POST /api/image/generate ──────────────────────────────────────────────────
//
// 请求体（JSON）：
//   prompt        string   必填，图像描述
//   negativePrompt string  可选，反向提示词
//   size          string   可选，尺寸如 "1024x1024"、"2K"（Agnes 档位）
//   n             number   可选，生成数量 1-4（默认 1）
//   seed          number   可选，随机种子
//   images        string[] 可选，输入图像 URL 数组（图生图）
//   backend       string   可选，后端名：openai | agnes | domestic | sd_webui
//   model         string   可选，模型 ID（如 agnes-image-2.0-flash）
//   outputBase64  boolean  可选，是否返回 base64（默认 true；Agnes 可用 extra_body.response_format 控制）
//
// 响应（200）：
//   { success: true, backend, model, size, n, images: [{base64}], paths?, message }
//
// 注意：当前实现将图像以 base64 内联返回。若需保存到文件，可配合 outputPath
// 在工具层处理；REST 层专注于生成+返回数据。

router.post('/generate', (req, res) => {
  if (!imageGenService.isAnyBackendConfigured()) {
    return json(res, 503, {
      success: false,
      error: imageGenService.backendHelpText(),
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

  const size = body.size || '1024x1024';
  const n = Math.max(1, Math.min(4, Number(body.n) || 1));
  const images = Array.isArray(body.images) ? body.images.filter(Boolean).map(String) : [];

  const genOpts = {
    prompt,
    negativePrompt: body.negativePrompt,
    size,
    n,
    seed: Number.isFinite(body.seed) ? body.seed : undefined,
    images: images.length ? images : undefined,
    backend: body.backend,
    model: body.model,
  };

  imageGenService
    .generate(genOpts)
    .then((result) => {
      if (!res.headersSent) {
        const response = {
          success: true,
          backend: result.backend,
          model: result.model,
          size: result.size,
          n: result.n,
          edited: result.edited || false,
          images: result.images.map((img) => ({
            base64: img.base64,
            dataUrl: `data:image/png;base64,${img.base64}`,
          })),
          message: `已生成 ${result.images.length} 张图像（${result.backend} / ${result.model}，${result.size}）`,
        };
        json(res, 200, response);
      }
    })
    .catch((err) => {
      if (!res.headersSent) {
        const code = err.code || 'GENERATION_FAILED';
        const errorMessage = err.message || '图像生成失败';

        // Use toolErrorCodes for rich error classification when available
        let enriched = null;
        try {
          enriched = toolErrorCodes.enrich({
            success: false,
            code,
            error: errorMessage,
            content: errorMessage,
            meta: { backend: err.backend || null },
          });
        } catch {
          /* fail-soft */
        }

        const statusMap = {
          NO_BACKEND: 503,
          EDIT_UNSUPPORTED: 400,
          BAD_PARAM: 400,
          NO_USABLE_KEY: 503,
          TIMEOUT: 504,
          GENERATION_FAILED: 500,
          BACKEND_ERROR: 500,
        };

        json(res, statusMap[code] || 500, {
          success: false,
          error: (enriched && enriched.error) || errorMessage,
          code,
          ...(enriched && enriched.errorClass ? { errorClass: enriched.errorClass } : {}),
        });
      }
    });
});

// ── GET /api/image/backends ───────────────────────────────────────────────────
//
// 返回已配置的图像生成后端列表、可用模型及帮助文本。

router.get('/backends', (_req, res) => {
  try {
    const backends = imageGenService.backendStatus();
    const models = imageGenService.catalogModels();

    json(res, 200, {
      success: true,
      data: {
        backends,
        models: models.map((m) => ({
          backend: m.backend,
          model: m.model,
          capability: m.capability,
          supportsEdit: m.supportsEdit || false,
        })),
        anyConfigured: imageGenService.isAnyBackendConfigured(),
        helpText: imageGenService.backendHelpText(),
        // Convenience: default model for each backend
        defaults: {
          agnes: require('../services/agnesImageModel').defaultAgnesGenModel(process.env),
          knownAgnesModels: require('../services/agnesImageModel').knownAgnesImageModels(),
          stepfun: 'step-image-edit-2',
          sensenova: 'sensenova-u1-fast',
        },
      },
    });
  } catch (err) {
    json(res, 500, {
      success: false,
      error: `获取图像后端信息失败: ${err.message}`,
    });
  }
});

module.exports = router;
