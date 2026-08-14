'use strict';

/**
 * glmVisionMaxTokens — 纯叶子:把发往 GLM 视觉模型的 `max_tokens` 钳到智谱允许的
 * 上限(≤1024),避免智谱端返回 `1210 max_tokens参数非法：限制数值范围[1,1024]`。
 *
 * 背景 / 实测根因(「识图 HTTP 400 code 1210」):
 *   识图链路(relay_api / callZhipu)在构造请求体时对 `max_tokens` 硬编码了一个高默认值
 *   (relayApiAdapter 的 OpenAI 兼容分支 `options.maxTokens ?? 8192`)。GLM 视觉模型
 *   (glm-4v-flash / glm-4.6v-flash 等)把 `max_tokens` 限制在 [1,1024];发送 8192 →
 *   智谱端参数校验直接 400 拒绝(code 1210),识图整轮失败。文本模型无此上限,故文本正常。
 *
 * 本叶子只做一件事:命中 GLM 视觉模型时,把请求的 max_tokens 收进 [1,1024];其余模型
 * 原样透传,不改任何行为。视觉模型判定单一真源复用 glmVisionApiPin.isGlmVisionModelName
 * (`/glm-4(?:\.\d+)?v/` 家族正则,覆盖 glm-4v-flash + glm-4.6v-flash 整条降级链)。
 *
 * 门控 KHY_GLM_VISION_MAX_TOKENS_CLAMP(parent = KHY_GLM_VISION_MODEL,默认开;
 * 0/false/off/no → 关)。关门 / 异常 → 原样透传 requested(逐字节回退今日行为)。
 *
 * 纯函数:除一次门控读取外零副作用、绝不抛。
 */

const GLM_VISION_MAX_TOKENS = 1024;

/**
 * 门控 KHY_GLM_VISION_MAX_TOKENS_CLAMP:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function clampEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_GLM_VISION_MAX_TOKENS_CLAMP;
    if (raw == null || String(raw).trim() === '') return true; // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

/**
 * 若模型是 GLM 视觉模型且门控开,把 max_tokens 钳到 [1,1024];否则原样返回 requested。
 * @param {string} model              目标模型串(可带 provider 前缀,如 `glm/glm-4v-flash`)
 * @param {number|undefined} requested 调用方拟发送的 max_tokens(可能为 undefined)
 * @param {object} [env]              环境(默认 process.env)
 * @returns {number|undefined}        钳位后的值;不命中 → 原样透传(含 undefined)
 */
function clampMaxTokensForGlmVision(model, requested, env = process.env) {
  try {
    if (!clampEnabled(env)) return requested;
    // 视觉模型判定复用 glmVisionApiPin 的单一真源(容忍 provider 前缀)。
    const { isGlmVisionModelName } = require('./glmVisionApiPin');
    if (!isGlmVisionModelName(model)) return requested;
    // 非有限数(undefined / null / NaN)→ 直接给上限,确保不会误发无上限默认值。
    const n = Number(requested);
    if (!Number.isFinite(n) || n <= 0) return GLM_VISION_MAX_TOKENS;
    return Math.min(Math.floor(n), GLM_VISION_MAX_TOKENS);
  } catch {
    return requested;
  }
}

module.exports = {
  clampMaxTokensForGlmVision,
  clampEnabled,
  GLM_VISION_MAX_TOKENS,
};
