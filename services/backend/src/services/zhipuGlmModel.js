'use strict';

/**
 * zhipuGlmModel.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「glm-5.2 做适配」:智谱 GLM 的默认/已知模型清单在全仓三处 SSoT 里仍停留在 glm-4 世代
 * (constants/models.js 的 ZHIPU_DIRECT_MODELS、gateway/providerPresets.js 的 zhipu preset
 * defaultModel、gateway/builtinProviderConfig.js 的 GLM models),而智谱最新旗舰是 GLM-5.2
 * (OpenAI 兼容端点 https://open.bigmodel.cn/api/paas/v4/chat/completions,1M 上下文、128K 最大
 * 输出、thinking / reasoning_effort / function-call / MCP / structured-output)。因此:
 *   - 直连 zhipu(routes/ai.js)自动带的默认模型仍是 glm-4;
 *   - provider 选择器 / builtin 目录里 glm-5.2 从不出现,用户无从「默认命中」或「一眼选中」它。
 *
 * 本叶子把「zhipu 默认模型 + 已知可选清单」收敛为单一真源:
 *   - 开门(KHY_GLM_LATEST_MODEL 默认开)→ 默认 = glm-5.2,清单以 glm-5.2 打头、保留 glm-4 系可选;
 *   - 关门(0/false/off/no)→ 逐字节回退历史默认 glm-4 与旧清单 [glm-4, glm-4-flash, glm-4-air]。
 *
 * 只管**默认值 + 已知清单**:调用方的显式 env / UI model 覆盖始终优先。绝不抛:异常回退历史默认。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 智谱最新旗舰(OpenAI 兼容),作 zhipu 默认与清单首项。
const LATEST_ZHIPU_MODEL = 'glm-5.2';
// 历史默认(关门回退目标),同时仍是可选模型。
const LEGACY_ZHIPU_MODEL = 'glm-4';

// 历史 builtin 清单(关门逐字节回退基准)。
const LEGACY_ZHIPU_MODELS = ['glm-4', 'glm-4-flash', 'glm-4-air'];
// 开门清单:glm-5.2 打头(默认),后接历史 glm-4 系仍可显式选中,末尾并入 GLM 视觉模型
// glm-4.6v-flash(供 sibling 扫描可见 + 池解析 + /model 可选;视觉行为另由 KHY_GLM_VISION_MODEL
// 门控,见 gateway/glmVisionModel.js)。
const LATEST_ZHIPU_MODELS = ['glm-5.2', 'glm-4-flash', 'glm-4-air', 'glm-4', 'glm-4.6v-flash'];

/**
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function latestGlmModelEnabled(env = process.env) {
  const raw = env && env.KHY_GLM_LATEST_MODEL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * zhipu 默认模型:
 *   1. GLM_DEFAULT_MODEL 明确指定 → 使用该值(最高优先级)
 *   2. KHY_GLM_LATEST_MODEL 开门 → glm-5.2
 *   3. 关门/异常 → 历史 glm-4
 * 只决定默认;call-site 的显式 env / 参数覆盖优先于本返回值。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function defaultZhipuModel(env = process.env) {
  try {
    // 优先使用显式配置的 GLM_DEFAULT_MODEL
    const explicitModel = env && env.GLM_DEFAULT_MODEL;
    if (explicitModel && String(explicitModel).trim()) {
      return String(explicitModel).trim();
    }
    // 回退到门控逻辑
    return latestGlmModelEnabled(env) ? LATEST_ZHIPU_MODEL : LEGACY_ZHIPU_MODEL;
  } catch {
    return LEGACY_ZHIPU_MODEL;
  }
}

/**
 * zhipu 已知可选模型清单:开门 → glm-5.2 打头的新清单;关门/异常 → 历史清单。
 * 返回副本,调用方可自由改动不影响内部常量。
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
function knownZhipuModels(env = process.env) {
  try {
    return (latestGlmModelEnabled(env) ? LATEST_ZHIPU_MODELS : LEGACY_ZHIPU_MODELS).slice();
  } catch {
    return LEGACY_ZHIPU_MODELS.slice();
  }
}

module.exports = {
  latestGlmModelEnabled,
  defaultZhipuModel,
  knownZhipuModels,
  LATEST_ZHIPU_MODEL,
  LEGACY_ZHIPU_MODEL,
  LATEST_ZHIPU_MODELS,
  LEGACY_ZHIPU_MODELS,
};
