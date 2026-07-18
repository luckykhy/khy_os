'use strict';

/**
 * modernVisionHints.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 当代原生多模态模型族的名字提示扩展。visionCapability 的 VISION_NAME_HINTS 刻意保守,
 * 漏掉了若干**当代原生多模态**模型族——它们的名字不含任何现有片段,于是真发带图请求会被
 * 误判纯文本 → 被无谓退回本地 OCR。本叶子把这组片段收口为单一真源,由 visionCapability 在
 * GLM 叶子判定之后、name-hint 之前额外查一次。
 *
 * 收录标准:该模型族的**全部公开变体**都原生接受图像输入,且名字片段足够精确不误伤纯文本
 * 同名族。片段刻意精确(用 'llama-4' 而非裸 '4'、'gpt-4.1' 而非 '4.1'),避免把纯文本型号
 * (如 deepseek-v4、gpt-4.1 若某 provider 另有纯文本 alias)误判——若有例外,用户可用
 * KHY_TEXT_ONLY_MODELS(优先级最高)精确纠正回纯文本。
 *
 * 门控 KHY_MODERN_VISION_HINTS(默认开):关(0/false/off/no)→ isModernVisionModel 恒 false
 * → visionCapability 这层完全静默 → 逐字节回退今日行为。绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 当代原生多模态模型族的名字片段(小写子串匹配)。每个片段对应的模型族**全部变体**均收图。
const MODERN_VISION_HINTS = Object.freeze([
  'llama-4',        // Meta Llama 4(Scout/Maverick,原生多模态)
  'gpt-4.1',        // OpenAI GPT-4.1 / 4.1-mini / 4.1-nano(收图)
  'gpt-5',          // OpenAI GPT-5 系(多模态)
  'grok-4',         // xAI Grok 4(收图)
  'grok-2-vision',  // xAI Grok 2 Vision(显式视觉变体)
  'glm-4.5v',       // 智谱 GLM-4.5V(与 glmVisionModel 叶子处理的 4.6v 不同代)
  'nova-lite',      // Amazon Nova Lite(多模态)
  'nova-pro',       // Amazon Nova Pro(多模态)
  'gemma-3',        // Google Gemma 3(多模态;gemma-2 及更早为纯文本,故不用裸 'gemma')
  'mistral-small-3', // Mistral Small 3.1/3.2(多模态;更早的 small 为纯文本)
  'mistral-medium-3', // Mistral Medium 3(多模态)
  'phi-4-multimodal', // Microsoft Phi-4 Multimodal
  'doubao-1.5-vision', // 字节豆包 1.5 Vision(显式视觉;裸 doubao 有纯文本变体故不收)
  'ernie-4.5-vl',   // 百度文心 4.5 VL
]);

/**
 * 门控 KHY_MODERN_VISION_HINTS:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function modernVisionHintsEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_MODERN_VISION_HINTS;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 某 model id 是否命中当代多模态模型族片段(门控内子串判定,容忍 provider 前缀)。
 * 关门/异常 → 恒 false(逐字节回退)。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isModernVisionModel(model, env = process.env) {
  try {
    if (!modernVisionHintsEnabled(env)) return false;
    const m = String(model == null ? '' : model).trim().toLowerCase();
    if (!m) return false;
    for (const hint of MODERN_VISION_HINTS) {
      if (m.includes(hint)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 命中的片段(供调试/描述;无命中或关门 → null)。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function matchedModernVisionHint(model, env = process.env) {
  try {
    if (!modernVisionHintsEnabled(env)) return null;
    const m = String(model == null ? '' : model).trim().toLowerCase();
    if (!m) return null;
    for (const hint of MODERN_VISION_HINTS) {
      if (m.includes(hint)) return hint;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  MODERN_VISION_HINTS,
  modernVisionHintsEnabled,
  isModernVisionModel,
  matchedModernVisionHint,
};
