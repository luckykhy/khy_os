'use strict';

/**
 * glmVisionApiPin — 纯叶子:判定「带图的外层 generate() 是否应把 preferredAdapter
 * 强制钉到 `api` 适配器」。
 *
 * 背景 / 实测根因(「图像识别始终 404 / Request failed with status code 404」):
 *   当请求携带图片、且模型本身就是 GLM 视觉模型(如 `glm/glm-4.6v-flash`、`glm-4v-flash`)时,
 *   decideVisionRouting 走 `keep` 分支(该模型已被判为「支持视觉」)——于是**不进入** describe
 *   级联,也就**不触发** describe 里那套 `preferredAdapter='api'` 定向。请求原样流进通用适配器
 *   级联(codex / cursor / trae / …… / api),排在 `api` 前面的通道先接住它、拿到裸视觉模型名打到
 *   自己的上游 → 那里没有此 GLM 模型 → **裸 404**(既非 `智谱AI:` 也非 `OpenAI:` 前缀,因为
 *   流式响应体未被解析),真错因(code 1211 未开通 / 1002 无效 key)被吞,识图永远失败。
 *
 *   describe 级联的 api-pin(_shouldPinApiAdapterForVisionDescribe)只保护**嵌套 describe 透传**,
 *   从不保护 `keep` 分支的外层请求。本叶子补齐该缺口:外层若是 GLM 视觉模型 + glm 池有 key,
 *   就把 preferredAdapter 钉到 `api` → 定向智谱端点(callZhipu,那里模型确实存在),真错因得以浮现;
 *   若智谱端仍失败(404 / model_not_found),既有 post-failure OCR 兜底网照旧救回,不毒会话。
 *
 * 门控 KHY_GLM_VISION_API_PIN(parent = KHY_GLM_VISION_MODEL,默认开;0/false/off/no → 关)。
 * 关门 / 异常 → 恒 false → 逐字节回退今日行为(通用级联,可能被 codex/openai 抢答)。
 *
 * 纯判定:除一次门控读取外零副作用、绝不抛。GLM key 可用性由调用方查好后以 `hasGlmKey` 传入
 * (本叶子不做 IO,保持可测、无隐藏依赖)。
 */

// GLM 视觉模型裸 id 前缀匹配:glm-4v-flash / glm-4.6v-flash / glm-4.5v … 统一 `glm-4[.x]v` 开头。
// 与 visionCapability 的 'glm-4v' 名字提示词、glmVisionModel 的 GLM_VISION_SUBSTR('glm-4.6v')
// 互补:此处用更宽的正则一网打尽有序降级链的两个成员(主 glm-4.6v-flash + 次 glm-4v-flash)。
const _GLM_VISION_ID_RE = /^glm-4(?:\.\d+)?v(?:[-_].*)?$/;

/**
 * 从可能带 provider 前缀的模型串里剥出裸 id。
 *   `api:glm:glm-4.6v-flash` → `glm-4.6v-flash`
 *   `glm/glm-4.6v-flash`     → `glm-4.6v-flash`
 *   `glm-4v-flash`           → `glm-4v-flash`
 * @param {string} model
 * @returns {string} 小写裸 id(无前缀原样小写);无效 → ''
 */
function bareModelId(model) {
  const m = String(model == null ? '' : model).trim().toLowerCase();
  if (!m) return '';
  // 三段式 api:pool:model
  const m3 = m.match(/^api[:/]([a-z0-9_-]+)[:/](.+)$/);
  if (m3) return m3[2].trim();
  // 两段式 provider/model 或 provider:model
  const m2 = m.match(/^[a-z0-9_-]+[:/](.+)$/);
  if (m2) return m2[1].trim();
  return m;
}

/**
 * 门控 KHY_GLM_VISION_API_PIN:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function apiPinEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_GLM_VISION_API_PIN;
    if (raw == null || String(raw).trim() === '') return true; // 缺省 → 默认开
    const v = String(raw).trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
  } catch {
    return false;
  }
}

/**
 * 判定给定模型串是否属于 GLM 视觉模型(容忍 provider 前缀)。
 * @param {string} model
 * @returns {boolean}
 */
function isGlmVisionModelName(model) {
  const bare = bareModelId(model);
  if (!bare) return false;
  return _GLM_VISION_ID_RE.test(bare);
}

/**
 * 外层带图请求是否应钉 `api` 适配器。
 * @param {object}  input
 * @param {boolean} input.hasImage    本次请求是否携带图片
 * @param {string}  input.model       目标模型串(可带 provider 前缀)
 * @param {boolean} input.hasGlmKey   glm 池是否有可用 key(调用方查好传入)
 * @param {object}  [input.env]       环境(默认 process.env)
 * @returns {boolean}  true → 应设 preferredAdapter='api' + strict
 */
function shouldPinApiForGlmVision(input = {}) {
  try {
    const { hasImage, model, hasGlmKey } = input;
    const env = input.env || process.env;
    if (!hasImage) return false;
    if (!hasGlmKey) return false;
    if (!apiPinEnabled(env)) return false;
    // 父门:GLM 视觉总开关关 → 不介入(逐字节回退)。
    try {
      const glm = require('./glmVisionModel');
      if (!glm.glmVisionEnabled(env)) return false;
    } catch { /* 叶子不可用 → 继续按本叶子自有判定 */ }
    return isGlmVisionModelName(model);
  } catch {
    return false;
  }
}

module.exports = {
  shouldPinApiForGlmVision,
  isGlmVisionModelName,
  bareModelId,
  apiPinEnabled,
  _GLM_VISION_ID_RE,
};
