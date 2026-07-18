'use strict';

/**
 * recognizeImage.js — 显式「识图」原生工具 RecognizeImage。
 *
 * 用户诉求:文本模型看不了图时能识别图像并返回结果,先以 GLM-4.6V-Flash 为例。除透明视觉
 * 路由兜底(见 gateway/glmVisionModel + visionCapability + aiGateway 视觉块)外,本工具提供
 * **显式主动调用**:给一张图(本地路径 / http(s) URL / data: URI)+ 可选提问,直接路由到
 * GLM-4.6V-Flash 识别并返回文本。
 *
 * 复用既有基础设施:
 *   - gateway.generate(prompt, { model, images:[...] }) —— 入口已统一归一图像(_imageCompat),
 *     OpenAI 多模态请求(image_url blocks)自动构建;
 *   - key 复用既有 GLM_API_KEY(同一智谱账号/端点),绝不硬编码密钥;
 *   - 模型 id / 门控收口到 glmVisionModel 叶子。
 *
 * 门控 KHY_GLM_VISION_MODEL:关 → isEnabled() false → 工具不注册(逐字节回退「功能不存在」)。
 */

const { defineTool } = require('./_baseTool');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { guardedReadFileSync } = require('./guardedReadFileSync');

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

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
const SUPPORTED_EXTS = new Set(Object.keys(MIME_MAP));

const DEFAULT_PROMPT = '请详细描述这张图片的内容，并识别其中出现的所有文字。';

// 复用 imageOcr 的路径归一:展开 ~ / $VAR / %VAR% → 绝对路径。
const resolvePath = require('../utils/resolveToolPath');

function _isRemoteOrDataImage(image) {
  const s = String(image || '').trim();
  return /^(https?:)?\/\//i.test(s) || /^data:/i.test(s);
}

// 把用户输入的图像归一为 gateway.generate 可消费的 image 项。
//   - http(s) URL / data: URI → 直接作 { url }(gateway 归一层照单接收);
//   - 本地路径 → 读文件 → { base64, mimeType }。
// 返回 { image } 或 { error }。绝不抛(异常转 error)。
function normalizeImageInput(rawImage, cwd) {
  try {
    const raw = String(rawImage == null ? '' : rawImage).trim();
    if (!raw) return { error: 'image 不能为空(需图片路径 / http(s) URL / data: URI)' };
    if (_isRemoteOrDataImage(raw)) {
      return { image: { url: raw } };
    }
    const imagePath = resolvePath(raw, cwd);
    if (!fs.existsSync(imagePath)) {
      return { error: `图片不存在: ${imagePath}` };
    }
    const ext = path.extname(imagePath).toLowerCase();
    if (!SUPPORTED_EXTS.has(ext)) {
      return { error: `不支持的图片格式: ${ext}。支持: ${[...SUPPORTED_EXTS].join(', ')}` };
    }
    const stat = fs.statSync(imagePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      return { error: `图片过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB (上限 20MB)` };
    }
    const base64 = guardedReadFileSync(imagePath).toString('base64');
    const mimeType = MIME_MAP[ext] || 'image/jpeg';
    return { image: { base64, mimeType } };
  } catch (err) {
    return { error: `读取图片失败: ${err.message}` };
  }
}

// 实际经网关识图。可注入(测试经 Symbol.for 替换 _impl.recognize 以 stub gateway.generate)。
async function recognize({ prompt, image, model }) {
  try {
    const gateway = require('../services/gateway/aiGateway');
    const result = await gateway.generate(prompt, {
      model,
      images: [image],
      maxTokens: 4096,
      temperature: 0.2,
    });
    if (result && result.success) {
      return { success: true, text: result.content, model: result.model || model };
    }
    const rawError = (result && result.content) || 'unknown error';
    return { success: false, error: _visionFailureError(rawError, model) };
  } catch (err) {
    return { success: false, error: _visionFailureError(err && err.message, model, '图像识别出错') };
  }
}

// 把识图底层真因转成「诚实总结 + 配置视觉模型 key 邀约」。门控 KHY_VISION_FAILURE_SUMMARY
// 关或叶子不可用 → 逐字节回退到旧文案 `<legacyPrefix>: <raw>`。绝不抛。
function _visionFailureError(rawError, model, legacyPrefix = '图像识别失败') {
  const raw = rawError == null ? 'unknown error' : String(rawError);
  try {
    const summary = require('../services/gateway/visionFailureSummary')
      .buildVisionFailureMessage({ rawError: raw, model, env: process.env });
    if (summary) return summary;
  } catch { /* 叶子不可用 → 回退旧文案 */ }
  return `${legacyPrefix}: ${raw}`;
}

// 默认视觉模型 id。门控 KHY_RECOGNIZE_IMAGE_POOL_PIN(默认开)→ 用带 `glm/` 前缀的池限定 pin
// (glm/glm-4.6v-flash),让 aiGateway._resolveApiPoolProviderForRequest 把请求定向到 GLM 视觉端点
// (模型确实存在处),而非留在当前激活的自定义 `api` 池——裸 id 打到那里没有此模型 → 404 model_not_found。
// 门关或注册表不可用 → 逐字节回退裸 `glm-4.6v-flash`(供仅经 api 池访问 GLM、无独立 glm 池 key 的用户)。
// 绝不抛。
function _defaultVisionModel() {
  try {
    const glmVision = require('../services/gateway/glmVisionModel');
    let usePin = true;
    try {
      const reg = require('../services/flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(process.env)
        && typeof reg.isFlagEnabled === 'function') {
        usePin = reg.isFlagEnabled('KHY_RECOGNIZE_IMAGE_POOL_PIN', process.env);
      }
    } catch { /* 注册表不可用 → 保持默认开(usePin=true) */ }
    if (usePin) {
      return glmVision.glmVisionFallbackPin(process.env) || glmVision.GLM_VISION_FALLBACK_PIN;
    }
    return glmVision.GLM_VISION_MODEL_ID;
  } catch {
    return 'glm-4.6v-flash';
  }
}

// 可注入实现持有者:execute 经此对象调用,便于测试替换,不影响生产路径。
const _impl = { normalizeImageInput, recognize };

const _recognizeImageTool = defineTool({
  name: 'RecognizeImage',
  description: '识别/理解一张图片(路径、http(s) URL 或 data: URI),路由到 GLM-4.6V-Flash 视觉模型，返回描述与图中文字。适用于文本模型无法直接看图的场景。',
  category: 'analysis',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  isEnabled() {
    try {
      return require('../services/gateway/glmVisionModel').glmVisionEnabled(process.env);
    } catch {
      return false;
    }
  },

  aliases: ['recognize_image', 'describe_image', 'vision', '识图', '看图'],
  searchHint: '识别图片 理解图像 看图 识图 图片内容 图中文字 vision recognize describe image',

  inputSchema: {
    image: { type: 'string', required: true, description: '图片来源:本地文件路径 / http(s) URL / data: URI' },
    prompt: { type: 'string', required: false, description: `识图提问(默认:「${DEFAULT_PROMPT}」)` },
    model: { type: 'string', required: false, description: '覆盖视觉模型 id(默认 glm/glm-4.6v-flash,池限定到 GLM 视觉端点)' },
  },

  getActivityDescription(input) {
    const src = input && input.image ? String(input.image) : 'image';
    const name = /^(https?:)?\/\//i.test(src) || /^data:/i.test(src) ? src.slice(0, 48) : path.basename(src);
    return `识别图片：${name}`;
  },

  getToolUseSummary(input) {
    if (!input || !input.image) return null;
    return `识别图片：${input.image}`;
  },

  async execute(params) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const norm = _impl.normalizeImageInput(params && params.image, cwd);
    if (norm.error) {
      return { success: false, error: norm.error };
    }
    const prompt = (params && params.prompt && String(params.prompt).trim()) || DEFAULT_PROMPT;
    let model = params && params.model && String(params.model).trim();
    if (!model) {
      model = _defaultVisionModel();
    }
    return _impl.recognize({ prompt, image: norm.image, model });
  },
});

// 测试注入入口:defineTool 返回对象被 Object.freeze,无法挂属性;经 Symbol.for 注册表共享
// 同一 _impl 引用,测试替换 _impl.{normalizeImageInput,recognize} 即可 stub。生产路径从不读取它。
globalThis[Symbol.for('khyos.recognizeImage.__impl')] = _impl;

module.exports = _recognizeImageTool;
