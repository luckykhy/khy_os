'use strict';

/**
 * visionRouting.js — "带图请求遇纯文本模型"的路由决策单一真源。
 *
 * 用户期望(方案A)：带图时若当前模型不支持视觉，自动在候选里改选一个支持视觉的
 * 模型识图；候选中没有视觉模型，才退回 OCR 把图转文本喂给纯文本模型。
 *
 * 本模块只做"纯决策"，不碰网关状态、不做 OCR、不改 options——决策结果交回
 * aiGateway 执行。纯叶子：零外部依赖(仅引用同目录纯叶子 visionCapability)，
 * env 经 opts 注入可测(DESIGN-ARCH 风格)。
 *
 * 决策结果 action：
 *   'keep'         —— 无图，或当前模型已支持视觉：原样进行。
 *   'switch-model' —— 候选里找到视觉模型：带 model 字段，调用方改写后路由到它。
 *   'ocr-fallback' —— 带图但当前模型纯文本且候选无视觉：调用方退回 OCR 转文本。
 */

const {
  isVisionCapableModel,
  pickVisionCandidate,
  _candidateModelId,
} = require('./visionCapability');

/**
 * 从带 provider 前缀的模型 id 里提取 pool/provider 名(纯函数,无 IO)。
 * 跨 pool 的视觉兜底模型(KHY_VISION_FALLBACK_MODEL)通常写全前缀,如:
 *   'relay/gpt-4o-mini'      → 'relay'   (两段式 provider/model)
 *   'relay:gpt-4o-mini'      → 'relay'
 *   'api:relay:gpt-4o-mini'  → 'relay'   (三段式 api:pool:model)
 *   'gpt-4o'                 → null      (裸模型名,默认同当前 pool)
 * 返回的 hint 交由 aiGateway 规范化并覆盖请求 scope,确保兜底打到对的端点。
 * @param {string} model
 * @returns {string|null}
 */
function _modelProviderPrefix(model) {
  const input = String(model == null ? '' : model).trim();
  if (!input) return null;
  const m3 = input.match(/^api[:/]([a-z0-9_-]+)[:/].+$/i);
  if (m3) return m3[1].toLowerCase();
  const m2 = input.match(/^([a-z0-9_-]+)[:/].+$/i);
  if (m2) return m2[1].toLowerCase();
  return null;
}

/**
 * @param {object} input
 * @param {boolean} input.hasImage         请求是否带图像
 * @param {string}  input.currentModel     当前选定模型 id
 * @param {Array<string|object>} [input.candidateModels] 同 provider/可选范围内的候选模型清单
 * @param {object}  [input.env]            注入 env(测试用)，默认 process.env
 * @returns {{action:'keep'|'switch-model'|'ocr-fallback', model?:string, reason:string}}
 */
function decideVisionRouting(input = {}) {
  const { hasImage, currentModel } = input;
  const env = input.env || process.env;
  const candidateModels = Array.isArray(input.candidateModels) ? input.candidateModels : [];

  if (!hasImage) {
    return { action: 'keep', reason: 'no_image_input' };
  }
  if (isVisionCapableModel(currentModel, { env })) {
    return { action: 'keep', reason: 'current_model_supports_vision' };
  }

  const currentLower = String(currentModel || '').trim().toLowerCase();

  // 1) 显式钉选优先：用户用 KHY_VISION_FALLBACK_MODEL 指定首选视觉模型时，
  //    只要它本身支持视觉且不等于当前模型，就用它(消除"注册表里到底哪个是视觉
  //    模型"的歧义，给用户确定性控制权)。
  const pinned = String(env.KHY_VISION_FALLBACK_MODEL || '').trim();
  if (pinned && pinned.toLowerCase() !== currentLower && isVisionCapableModel(pinned, { env })) {
    // poolHint：钉选模型自带的 provider 前缀(若有)。aiGateway 据此覆盖请求 scope,
    // 让跨 pool 兜底(当前 SenseNova、兜底 relay/gpt-4o-mini)真正打到 relay 端点。
    return {
      action: 'switch-model',
      model: pinned,
      reason: 'switched_to_pinned_vision_model',
      poolHint: _modelProviderPrefix(pinned),
    };
  }

  // 2) 在候选(同 provider 兄弟模型)里找视觉模型，排除当前模型自身。
  const others = candidateModels.filter((c) => {
    const id = String(_candidateModelId(c) || '').trim().toLowerCase();
    return id && id !== currentLower;
  });
  const picked = pickVisionCandidate(others, { env });
  if (picked) {
    return {
      action: 'switch-model',
      model: _candidateModelId(picked),
      reason: 'switched_to_vision_candidate',
    };
  }

  // 3) 候选里没有视觉模型：退回 OCR 转文本。
  return { action: 'ocr-fallback', reason: 'no_vision_candidate_available' };
}

module.exports = { decideVisionRouting, _modelProviderPrefix };
