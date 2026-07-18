'use strict';

/**
 * visionCapability.js — 模型"是否支持视觉输入(图像)"判定的单一真源。
 *
 * 背景：网关里既有的能力数据要么是适配器级(capabilityRegistry 的 vision 0-5 分)、
 * 要么是 multiFreeService 内置 provider 的 supportsVision 布尔——都不是"按请求里
 * 指定的具体 model id"判定。于是"带图 + 纯文本模型"无法被识别，也就无法做
 * "自动改选视觉模型 / 退回 OCR"的路由决策。
 *
 * 本模块把"某个 model 是否能接受图像输入"收口为单一真源，判定优先级：
 *   1. 强制纯文本集(env KHY_TEXT_ONLY_MODELS) —— 命中即 false，优先级最高(用于
 *      纠正启发式误判，例如某个名字带 image 但其实纯文本的模型)。
 *   2. 显式视觉集(env KHY_VISION_MODELS + 内置 BUILTIN_VISION_MODELS) —— 命中即 true。
 *   3. 内置纯文本集(BUILTIN_TEXT_ONLY_MODELS) —— 命中即 false(在代码里纠正名字启发式
 *      会误判的型号，例如名字带 image 实则只「生成图、不收图」的型号)。
 *   4. 模型名启发式(VISION_NAME_HINTS) —— 命中即 true。
 *   5. 默认 false(纯文本)。
 *
 * 纯叶子：零外部依赖、无副作用、env 经 opts 注入可测(DESIGN-ARCH 风格)。
 */

// 名字含这些片段的模型默认视为支持视觉。关键词刻意保守、精确，避免误伤——
// 例如不能用裸 '-v'(会把 deepseek-v4 误判)，也不用裸 '4o' 之类过宽片段。
const VISION_NAME_HINTS = Object.freeze([
  'vision', 'multimodal', 'omni',
  '-vl', 'vl-', 'qwen-vl', 'qwen2-vl', 'qwen2.5-vl', 'internvl', 'cogvlm', 'glm-4v',
  'minicpm-v', 'llava', 'pixtral', 'step-1v', 'yi-vision', 'gpt-4o', 'gemini',
  'claude-3', 'claude-opus', 'claude-sonnet', 'claude-haiku',
  // 名字明确带 image 的型号通常是视觉/图像模型；若某型号名带 image 却**不收图像输入**
  // (如图像生成专用模型)，用 BUILTIN_TEXT_ONLY_MODELS(代码内)或 KHY_TEXT_ONLY_MODELS
  // (env)把它纠正回纯文本。
  'image',
]);

// 内置视觉模型集(精确小写匹配)。当前留空：经实测确认,SenseNova Token Plan 里没有
// 任何「按 model id 走 /v1/chat/completions 直接读图」的多模态模型可信赖——
//   - sensenova-6.7-flash-lite 此前被写死为视觉模型,但实际**不收图像输入**(带图请求
//     它会当作没收到图、回「请上传图片」),故移出本集、按纯文本处理。
//   - sensenova-6.7-flash-image / sensenova-u1-fast 是「生成图」型号(见下 TEXT_ONLY 集),
//     名字带 image 会被启发式误判为视觉,必须显式纠正回纯文本,否则识图请求发给它→上游 404。
// 于是 SenseNova 通道的带图请求会被 decideVisionRouting 判为「无视觉兄弟」→ 退回本地 OCR
// (Tesseract,chi_sim+eng 已装),文字类截图可直接识别,非文字图给诚实说明(见 visionOcrFallback)。
// 若日后确认某 SenseNova 型号确实支持图像输入,把它加回本集(或用 env KHY_VISION_MODELS=<id>
// 即时启用),无需改动其它代码。
const BUILTIN_VISION_MODELS = Object.freeze([]);

// 内置纯文本集(精确小写匹配)。这些型号名字带 image / 看似视觉,但实际**只生成图、不收
// 图像输入**,会被 VISION_NAME_HINTS 的 'image' 片段误判为视觉,故在代码里显式纠正回纯文本
// (优先级低于 env KHY_VISION_MODELS,用户仍可经 env 强制覆盖)：
//   - sensenova-6.7-flash-image —— 图像生成型号,不接受图像输入(自动改选到它做识图必然 404)。
//   - sensenova-u1-fast        —— 「信息图生成」,走独立的 /v1/images/generations 端点、不收图。
const BUILTIN_TEXT_ONLY_MODELS = Object.freeze([
  'sensenova-6.7-flash-image',
  'sensenova-u1-fast',
]);

// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _normModel = require('../../utils/trimLowerNullish');

/**
 * 解析逗号/空白分隔的 env 列表为一组小写模型名。
 * @param {string} raw
 * @returns {Set<string>}
 */
const parseModelListEnv = require('../../utils/parseListToSet');

function _matchesNameHint(modelLower) {
  for (const hint of VISION_NAME_HINTS) {
    if (modelLower.includes(hint)) return true;
  }
  return false;
}

/**
 * 判定一个 model 是否支持视觉(图像)输入。
 * @param {string} model
 * @param {{env?: object}} [opts]
 * @returns {boolean}
 */
function isVisionCapableModel(model, opts = {}) {
  const modelLower = _normModel(model);
  if (!modelLower) return false;

  const env = opts.env || process.env;
  const textOnly = parseModelListEnv(env.KHY_TEXT_ONLY_MODELS);
  if (textOnly.has(modelLower)) return false; // 强制纯文本，优先级最高

  const visionEnv = parseModelListEnv(env.KHY_VISION_MODELS);
  if (visionEnv.has(modelLower)) return true;
  if (BUILTIN_VISION_MODELS.includes(modelLower)) return true;

  // GLM 视觉模型(glm-4.6v-flash)门控内子串判定——名字提示词 'glm-4v' 匹配不到 'glm-4.6v'
  // (`4` 后跟 `.6` 非 `v`),故收口到 glmVisionModel 叶子。门关(KHY_GLM_VISION_MODEL=0)→
  // isGlmVisionModel 恒 false → 与历史逐字节等价。fail-soft:叶子异常绝不冒泡。
  try {
    const glmv = require('./glmVisionModel');
    if (glmv.isGlmVisionModel(modelLower, env)) return true;
  } catch { /* fail-soft: 叶子不可用不影响既有判定 */ }

  // 当代原生多模态模型族(llama-4 / gpt-4.1 / glm-4.5v / grok-4 / nova-* / gemma-3 …)——名字
  // 不含任何 VISION_NAME_HINTS 片段,漏判会被无谓退回 OCR。收口到 modernVisionHints 叶子,
  // 门控内子串判定。门关(KHY_MODERN_VISION_HINTS=0)→ 恒 false → 逐字节回退。fail-soft。
  try {
    const mvh = require('./modernVisionHints');
    if (mvh.isModernVisionModel(modelLower, env)) return true;
  } catch { /* fail-soft: 叶子不可用不影响既有判定 */ }

  // 在名字启发式之前纠正「名字带 image 但只生成图、不收图」的型号(否则 'image' 片段误判)。
  if (BUILTIN_TEXT_ONLY_MODELS.includes(modelLower)) return false;

  // 精确 id 名单(上一行)无法枚举每个自定义 provider 的 *-image-* / 视频生成型号,故把该纠正
  // 模式化:命中「媒体生成」命名规律(如 agnes-image-2.1-flash)→ 强制纯文本,不被 'image' 片段
  // 误判为视觉、不被选作视觉候选而误发到生成端点(→ model_not_found/404)。门关/异常 → 恒 false
  // → 逐字节回退('image' 片段照旧命中)。优先级低于上方 env KHY_VISION_MODELS/内置视觉集。
  try {
    const gx = require('./visionGenerationExclusion');
    if (gx.isGenerationOnlyModel(modelLower, env)) return false;
  } catch { /* fail-soft: 叶子不可用不影响既有判定 */ }

  return _matchesNameHint(modelLower);
}

/**
 * 从候选模型清单中，判断是否存在支持视觉的候选。
 * @param {Array<string|{id?:string, model?:string, name?:string}>} candidates
 * @param {{env?: object}} [opts]
 * @returns {boolean}
 */
function hasVisionCapableCandidate(candidates, opts = {}) {
  return !!pickVisionCandidate(candidates, opts);
}

function _candidateModelId(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') return item.id || item.model || item.name || '';
  return '';
}

/**
 * 从候选模型清单中挑选第一个支持视觉的候选(保持传入顺序=优先级)。
 * @param {Array<string|{id?:string, model?:string, name?:string}>} candidates
 * @param {{env?: object}} [opts]
 * @returns {string|object|null} 命中的原始候选项(便于调用方拿回 adapter 等附带字段)，无则 null
 */
function pickVisionCandidate(candidates, opts = {}) {
  if (!Array.isArray(candidates)) return null;
  for (const item of candidates) {
    const id = _candidateModelId(item);
    if (id && isVisionCapableModel(id, opts)) return item;
  }
  return null;
}

module.exports = {
  VISION_NAME_HINTS,
  BUILTIN_VISION_MODELS,
  BUILTIN_TEXT_ONLY_MODELS,
  parseModelListEnv,
  isVisionCapableModel,
  hasVisionCapableCandidate,
  pickVisionCandidate,
  _candidateModelId,
};
