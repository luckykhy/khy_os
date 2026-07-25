'use strict';

/**
 * zhipuFreeModels.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 「智谱 GLM(poolKey `glm`)的 key 配好后,自动把智谱**免费模型**加入 khyos 可用清单」
 * 的单一真源。背景:khyos 早有整套 pool→模型目录基础设施,但对**裸 poolKey**(有 key、
 * 无 custom_providers.json 记录,`glm` 正是此形态)的模型枚举只认 GATEWAY_API_POOL_DEFAULT_
 * MODEL_MAP 里的 0-1 个默认模型或远端 /v1/models 实时发现——占位/离线时那批免费模型根本
 * 不出现在 /model 选择器(apiAdapter.listModels / modelCatalogGraph 两处目录面)。
 *
 * 本叶子只声明「智谱免费模型是什么 / 是否启用 / 如何并入裸 glm 池的静态模型集」;
 * 并入的 wiring 在 apiAdapter.listModels 与 modelCatalogGraph 两处,均门控且逐字节回退。
 *
 *   - 开门(KHY_ZHIPU_FREE_MODELS 默认开)→ glm 池一旦有 key(占位或真 key)即在目录面
 *     出现下方免费聊天/视觉模型(cogview/cogvideox 属图像/视频端点,不进**聊天**目录避免误选 404);
 *   - 关门(0/false/off/no)→ augmentGlmPoolModels 原样返回入参 → 与历史逐字节等价。
 *
 * 数据来源:智谱开放平台 BigModel「免费模型」文档
 *   https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash
 * 端点复用既有 GLM 默认(OpenAI 兼容 v4,https://open.bigmodel.cn/api/paas/v4);模型经
 * 既有 `api:glm:<model>` 规范 id 走 glm 池 key 的端点,无需额外路由 wiring。
 *
 * 绝不硬编码密钥:本叶子只是模型 id 元数据。绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const GLM_POOL_KEY = 'glm';
const ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4';

// 智谱 BigModel 永久免费模型(2026-07 核准)。modality:
//   'chat'   —— 走 /chat/completions 的对话模型,进聊天目录。
//   'vision' —— 走 /chat/completions 的多模态模型(收图),进聊天目录(视觉路由可挑中)。
//   'image'  —— 走 /images/generations 的文生图模型,**不进聊天目录**(供生图侧消费)。
//   'video'  —— 走 /videos/generations 的文/图生视频模型,**不进聊天目录**。
// glm-4.5-flash 已于 2026-01 下线并自动路由到 glm-4.7-flash,故不列入。
const ZHIPU_FREE_MODELS = Object.freeze([
  Object.freeze({ id: 'glm-4.7-flash', modality: 'chat', label: 'GLM-4.7-Flash(免费·旗舰对话/推理/Agent,200K 上下文)' }),
  Object.freeze({ id: 'glm-4.6v-flash', modality: 'vision', label: 'GLM-4.6V-Flash(免费·视觉理解)' }),
  Object.freeze({ id: 'glm-4.1v-thinking-flash', modality: 'vision', label: 'GLM-4.1V-Thinking-Flash(免费·视觉推理)' }),
  Object.freeze({ id: 'glm-4-flash-250414', modality: 'chat', label: 'GLM-4-Flash-250414(免费·文本)' }),
  Object.freeze({ id: 'glm-4v-flash', modality: 'vision', label: 'GLM-4V-Flash(免费·图像理解)' }),
  Object.freeze({ id: 'cogview-3-flash', modality: 'image', label: 'CogView-3-Flash(免费·文生图)' }),
  Object.freeze({ id: 'cogvideox-flash', modality: 'video', label: 'CogVideoX-Flash(免费·文/图生视频)' }),
]);

// 进「聊天目录」的免费模型 modality(对话 + 视觉)。图像/视频端点不同,排除避免被当聊天模型误选。
const CHAT_MODALITIES = Object.freeze(['chat', 'vision']);

// 已确证下线的智谱模型名 → 有效替代(exact-match,小写键)。智谱官方对 glm-4.5-flash 做了
// 自动路由(见上方 :36 注释),但对裸 glm-4.5 不路由 → 用户选中 glm-4.5 时直发端点撞 404
// model_not_found。这里在发出前本地重映射到永久免费旗舰 glm-4.7-flash,让对话立即恢复。
const RETIRED_ZHIPU_REMAP = Object.freeze({
  'glm-4.5': 'glm-4.7-flash',
  'glm-4.5-flash': 'glm-4.7-flash',
});

/**
 * 门控 KHY_ZHIPU_FREE_MODELS:默认开;0/false/off/no → 关。异常回退关门(false)。
 * flagRegistry 优先,失败回退本地 CANON 解析(仿 builtinGlmKey.js 范式)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function zhipuFreeModelsEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('../flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_ZHIPU_FREE_MODELS', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_ZHIPU_FREE_MODELS;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 某 poolKey 是否即智谱 GLM 池(容忍大小写/空白)。
 * @param {string} poolKey
 * @returns {boolean}
 */
function isGlmPoolKey(poolKey) {
  return String(poolKey == null ? '' : poolKey).trim().toLowerCase() === GLM_POOL_KEY;
}

/**
 * 全部免费模型(含 image/video),返回深拷贝数组。关门/异常 → []。
 * @param {Record<string,string>} [env]
 * @returns {Array<{id:string, modality:string, label:string}>}
 */
function listZhipuFreeModels(env = process.env) {
  try {
    if (!zhipuFreeModelsEnabled(env)) return [];
    return ZHIPU_FREE_MODELS.map((m) => ({ id: m.id, modality: m.modality, label: m.label }));
  } catch {
    return [];
  }
}

/**
 * 进聊天目录的免费模型 id(对话 + 视觉)。关门/异常 → []。
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
function zhipuFreeChatModelIds(env = process.env) {
  try {
    if (!zhipuFreeModelsEnabled(env)) return [];
    return ZHIPU_FREE_MODELS.filter((m) => CHAT_MODALITIES.includes(m.modality)).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * 全部免费模型 id(含 image/video)。关门/异常 → []。
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
function zhipuFreeModelIds(env = process.env) {
  try {
    if (!zhipuFreeModelsEnabled(env)) return [];
    return ZHIPU_FREE_MODELS.map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * 把智谱免费**聊天/视觉**模型并入某裸 poolKey 的静态模型集(供 apiAdapter.listModels /
 * modelCatalogGraph 的 pool-only 分支消费)。仅当 poolKey 为 `glm` 且门开才增补;
 * 其余情况原样返回入参副本(严格超集:只对 glm 只加不减)。
 *
 * 语义:
 *   - 关门/异常 → 返回 existing 的浅拷贝(内容逐字节等价 → 目录面与历史一致)。
 *   - 非 glm poolKey → 返回 existing 浅拷贝(其它 provider 绝不受影响)。
 *   - glm + 门开 → existing 之后追加缺失的免费聊天模型 id(大小写不敏感去重,保留既有顺序在前)。
 *
 * existing 元素可为字符串或 {id} 对象(两处调用点形态不一),去重按其 id 小写比较;
 * 追加的免费模型统一以字符串 id 形态 push(下游两处均 `typeof x==='string'?x:x.id` 兼容)。
 * @param {string} poolKey
 * @param {Array<string|{id?:string}>} existing
 * @param {Record<string,string>} [env]
 * @returns {Array<string|{id?:string}>}
 */
function augmentGlmPoolModels(poolKey, existing, env = process.env) {
  const base = Array.isArray(existing) ? existing.slice() : [];
  try {
    if (!zhipuFreeModelsEnabled(env)) return base;
    if (!isGlmPoolKey(poolKey)) return base;
    const idOf = (x) => String(typeof x === 'string' ? x : (x && x.id) || '').trim().toLowerCase();
    const have = new Set(base.map(idOf).filter(Boolean));
    for (const id of zhipuFreeChatModelIds(env)) {
      const lc = String(id).toLowerCase();
      if (!have.has(lc)) {
        base.push(id);
        have.add(lc);
      }
    }
    return base;
  } catch {
    return Array.isArray(existing) ? existing.slice() : [];
  }
}

/**
 * 把已下线的智谱模型名重映射到有效替代(发出前的最后一道正确性钩子)。
 * 仅对 RETIRED_ZHIPU_REMAP 里显式登记的下线名做 exact-match 替换,其余一律原样返回。
 *
 * 语义:
 *   - 空 / 非字符串 → 原样返回入参(不臆造)。
 *   - 门关(KHY_ZHIPU_FREE_MODELS=0/false/off/no)/ 异常 → 逐字节回退,原样返回入参
 *     (等价今日行为:直发端点,由上游决定是否 404)。
 *   - `glm-4.5v*` 护栏:GLM-4.5V 是**有效**视觉模型代,绝不被误映射(exact-match 表本不含它,
 *     此为双保险,防后人误改成前缀匹配)。
 *   - 命中下线名 → 返回有效替代;未命中(含有效名)→ 原样返回。
 * 绝不抛:异常一律回退原入参,不阻断请求。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function remapRetiredZhipuModel(model, env = process.env) {
  try {
    const raw = String(model == null ? '' : model).trim();
    if (!raw) return model;                          // 空 → 原样
    if (!zhipuFreeModelsEnabled(env)) return model;  // 门关 → 逐字节回退(今日无 remap)
    const key = raw.toLowerCase();
    if (key.startsWith('glm-4.5v')) return model;    // 护栏:glm-4.5v* 是有效视觉模型,绝不误伤
    return RETIRED_ZHIPU_REMAP[key] || model;        // 未知/有效名 → 原样返回
  } catch {
    return model;                                    // fail-soft:异常绝不阻断请求
  }
}

module.exports = {
  GLM_POOL_KEY,
  ZHIPU_ENDPOINT,
  ZHIPU_FREE_MODELS,
  RETIRED_ZHIPU_REMAP,
  zhipuFreeModelsEnabled,
  isGlmPoolKey,
  listZhipuFreeModels,
  zhipuFreeChatModelIds,
  zhipuFreeModelIds,
  augmentGlmPoolModels,
  remapRetiredZhipuModel,
};
