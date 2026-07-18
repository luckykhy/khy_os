'use strict';

/**
 * glmVisionModel.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 「文本模型看不了图 → 自动路由到图像识别模型再返回」以 GLM-4.6V-Flash 为例落地的
 * 视觉行为单一真源。khy 早有整套透明视觉路由基础设施(visionCapability / visionRouting /
 * aiGateway 视觉执行块 / _imageCompat 多模态请求),真实缺口只有两处:
 *   ① `glm-4.6v-flash` 在 visionCapability 里判不出「支持视觉」——唯一 GLM 名字提示词是
 *      `glm-4v`,匹配不到 `glm-4.6v`(`4` 后面是 `.6` 不是 `v`),于是它在路由器每个分支
 *      里都不可见(既不能被路由到,若它是当前模型还会被误判纯文本而「路由走」);
 *   ② 没有把它设为**默认视觉兜底模型**(KHY_VISION_FALLBACK_MODEL 目前纯 env、无代码默认)。
 *
 * 本叶子只声明「GLM 视觉模型是什么 / 是否启用 / 兜底 pin 形态 / 某 model 是否即它」——
 * 判定与兜底注入的 wiring 在 visionCapability / aiGateway 侧,均门控且逐字节回退。
 *
 *   - 开门(KHY_GLM_VISION_MODEL 默认开)→ 视觉能力认它、默认兜底转它、识图工具启用;
 *   - 关门(0/false/off/no)→ 全部逐字节回退今日行为(能力 false、无默认兜底、工具消失)。
 *
 * key 复用既有 GLM_API_KEY(同一智谱账号/端点),绝不硬编码密钥。绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// GLM 图像识别模型 id(OpenAI 兼容多模态,端点同 GLM 直连 https://open.bigmodel.cn/api/paas/v4)。
const GLM_VISION_MODEL_ID = 'glm-4.6v-flash';
// 次选 GLM 视觉模型:智谱 2024 年首发的免费图像理解模型,几乎所有账号默认即可调用。
// 现实缺口:glm-4.6v-flash 是 2025/12 才上的新模型,部分账号尚未实名/领取时官方端点会回
// 404 model_not_found(端点/模型名/key 全对却调不通)。此时级联降级到久经考验的 glm-4v-flash
// 常能当场恢复识图。它已被 visionCapability 的 'glm-4v' 名字提示词判为视觉,无需再改判定叶子。
const GLM_VISION_SECONDARY_ID = 'glm-4v-flash';
// 兜底 pin 带 `glm/` 前缀,让 visionRouting._modelProviderPrefix 解析出 poolHint='glm',
// 使 aiGateway 把 apiPoolProvider 定向到 GLM 池/端点(而非当前文本模型的池)。
const GLM_VISION_FALLBACK_PIN = 'glm/glm-4.6v-flash';
// 有序 GLM 视觉降级链:首选新旗舰 glm-4.6v-flash → 次选老牌免费 glm-4v-flash。
// 供 visionFallbackCandidates 级联枚举消费(describe 失败时逐个再试,均定向 glm 池)。
const GLM_VISION_FALLBACK_IDS = Object.freeze([GLM_VISION_MODEL_ID, GLM_VISION_SECONDARY_ID]);
// 子串判定锚点:命中即视为 GLM 视觉模型,对带 provider 前缀(zhipu/、glm/)的形式也成立。
// 刻意只锚 glm-4.6v(不锚更宽的 glm-4v,以免误伤 glm-4v-plus 等非视觉型号);glm-4v-flash 的
// 视觉判定交由 visionCapability 既有 'glm-4v' 名字提示词,二者互不越界。
const GLM_VISION_SUBSTR = 'glm-4.6v';

/**
 * 门控 KHY_GLM_VISION_MODEL:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function glmVisionEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_GLM_VISION_MODEL;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * GLM 视觉模型 id:开门 → 'glm-4.6v-flash';关门/异常 → ''。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function glmVisionModelId(env = process.env) {
  return glmVisionEnabled(env) ? GLM_VISION_MODEL_ID : '';
}

/**
 * 默认视觉兜底 pin(带 glm/ 前缀):开门 → 'glm/glm-4.6v-flash';关门/异常 → ''。
 * 供 aiGateway 在用户未自定义 KHY_VISION_FALLBACK_MODEL 且 GLM key 可用时注入。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function glmVisionFallbackPin(env = process.env) {
  return glmVisionEnabled(env) ? GLM_VISION_FALLBACK_PIN : '';
}

/**
 * 有序 GLM 视觉降级候选(供 describe 级联逐个再试):
 *   开门 → [{ model:'glm-4.6v-flash', poolHint:'glm' }, { model:'glm-4v-flash', poolHint:'glm' }];
 *   关门/异常 → []。
 * 用裸 model + poolHint 'glm'(而非带前缀 pin),与 aiGateway describe 调用的
 * { model, apiPoolProvider } 形态直接对齐。首选新旗舰、次选老牌免费——账号缺新模型(404)时
 * 自动降级到几乎恒可用的 glm-4v-flash。返回新数组,调用方可安全 mutate。
 * @param {Record<string,string>} [env]
 * @returns {Array<{model:string, poolHint:string}>}
 */
function glmVisionCandidatePins(env = process.env) {
  try {
    if (!glmVisionEnabled(env)) return [];
    return GLM_VISION_FALLBACK_IDS.map((id) => ({ model: id, poolHint: 'glm' }));
  } catch {
    return [];
  }
}

/**
 * 某 model id 是否即 GLM 视觉模型(门控内子串判定,容忍 provider 前缀)。
 * 关门 → 恒 false(逐字节回退:visionCapability 不因它把 glm-4.6v-flash 认作视觉)。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isGlmVisionModel(model, env = process.env) {
  try {
    if (!glmVisionEnabled(env)) return false;
    const m = String(model == null ? '' : model).trim().toLowerCase();
    if (!m) return false;
    return m.includes(GLM_VISION_SUBSTR);
  } catch {
    return false;
  }
}

/**
 * 内置视觉模型 id 清单(供 visionCapability 精确集合消费):开门 → ['glm-4.6v-flash'];
 * 关门/异常 → []。返回副本。
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
function builtinVisionModelIds(env = process.env) {
  try {
    return glmVisionEnabled(env) ? [GLM_VISION_MODEL_ID] : [];
  } catch {
    return [];
  }
}

module.exports = {
  GLM_VISION_MODEL_ID,
  GLM_VISION_SECONDARY_ID,
  GLM_VISION_FALLBACK_PIN,
  GLM_VISION_FALLBACK_IDS,
  GLM_VISION_SUBSTR,
  glmVisionEnabled,
  glmVisionModelId,
  glmVisionFallbackPin,
  glmVisionCandidatePins,
  isGlmVisionModel,
  builtinVisionModelIds,
};
