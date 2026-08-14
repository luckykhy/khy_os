'use strict';

/**
 * modelToolingCapability.js — 「某个 model(在某个 adapter 上)是否具备可靠的原生
 * function calling(工具调用)」判定的单一真源。
 *
 * 背景:网关里「这个模型能不能原生调工具、不能就得退回 <tool_call> 文本拦截」这个
 * 决策被复制了四处——khyUpgradeRuntime 两处「教学门」(决定是否给模型注入 <tool_call>
 * 文本调用语法教学)+ relayApiAdapter / multiFreeService 两处「剥离门」(决定是否把
 * tools 从上游请求里删掉)。而且它们已经漂移:**教学门用的小模型正则缺了剥离门的
 * deepseek/sensenova 例外**,导致 deepseek-v4-flash / sensenova-6.7-flash-lite 这类
 * 全尺寸模型既被原生发送 tools、又被注入 <tool_call> 文本教学,指令自相矛盾。
 *
 * 本模块把该决策收口为单一真源(镜像 visionCapability.js 的范式),让「剥离原生工具」
 * 与「教学文本拦截语法」永远同步:凡被判为缺乏可靠原生工具调用的模型,一定会被教
 * 文本拦截语法,从而即便上游不支持 function calling,模型也能经既有 toolCallParser
 * (toolUseLoop 的文本回退解析 + syntheticToolLayer)调用 khy 的工具完成任务。
 *
 * model 维度判定优先级(modelLacksReliableToolCalling):
 *   1. 强制原生集(env KHY_NATIVE_TOOL_MODELS) —— 命中即「不缺」(false),优先级最高
 *      (用户主权:纠正任何误判,把某个模型钉死为原生)。
 *   2. 强制纯文本集(env KHY_TEXT_ONLY_TOOL_MODELS) —— 命中即「缺」(true)。
 *   3. **实测裁决(opts.measured)** —— 'native'→不缺、'text'→缺。由 toolCapabilityStore 提供
 *      (live probe / 被动学习的真实结果)。**实测胜过任何按名字的启发**——这是「不硬编码、
 *      实测为准」的落点:一个名字含 flash 但实测能调工具的模型,measured='native' 即拉回原生。
 *   4. 小模型名启发(SMALL_MODEL_HINTS) —— 命中即「缺」。仅作**провизионально(暂定)**默认:
 *      实测前安全地走文本协议(永远能用),一旦实测/被动学习有结果即被第 3 步覆盖。
 *   5. 默认「不缺」(false:未知/非小名模型不过度教学,保留原生路径)。
 *
 * 设计变更(用户裁决「工具可调用模型不要硬编码,需要实测后才算」):**删除**了原先的正向
 * 名字白名单 FULL_SIZE_TOOL_EXCEPTIONS(deepseek-v[3-9]/sensenova-\d/agnes-\d)。名字含
 * flash/lite 的全尺寸模型不再靠硬编码豁免,而是经实测缓存晋升为原生(探测/被动学习)。
 * 过渡期(未测前)这类模型暂走文本协议——安全可用;需立即原生可用 env KHY_NATIVE_TOOL_MODELS。
 *
 * 纯叶子:零外部依赖、无副作用、env 与 measured 经 opts 注入可测、绝不抛。
 * 门控 KHY_MODEL_TOOLING_CAPABILITY 默认开;关 → 各调用方自行字节回退到原内联逻辑。
 */

// 能做原生 function calling 的适配器(SSOT)。其余适配器(local/localLLM/ollama 的
// 弱档/clipboard/webRelay…)一律走文本拦截。小写精确匹配。
const NATIVE_TOOL_USE_ADAPTERS = Object.freeze([
  'kiro', 'cursor', 'trae', 'claude', 'codex', 'api',
  'windsurf', 'vscode', 'warp', 'cursor2api', 'relay_api',
]);

// 名字含这些片段的模型**暂定(провизионально)**视为「小模型、缺乏可靠原生工具调用」。
// 仅作实测前的安全默认(走文本协议永远能用);一旦 toolCapabilityStore 有实测裁决,
// modelLacksReliableToolCalling 的 opts.measured 即覆盖此启发。与四处历史正则一致。
const SMALL_MODEL_HINTS = /(mini|lite|flash|haiku|small|7b|8b|3b|1\.5b|nano|tiny)/i;

// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _norm = require('../../utils/trimLowerNullish');

/**
 * 门控(默认开;仅 0/false/off/no 关,大小写/空白不敏感)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const v = _norm(env && env.KHY_MODEL_TOOLING_CAPABILITY);
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 解析逗号/空白分隔的 env 列表为一组小写模型名(镜像 visionCapability.parseModelListEnv)。
 * @param {string} raw
 * @returns {Set<string>}
 */
const parseModelListEnv = require('../../utils/parseListToSet');

/**
 * 适配器维度:该 adapter 是否具备原生 function calling 通道。
 * @param {string} adapter
 * @returns {boolean}
 */
function adapterSupportsNativeToolUse(adapter) {
  const a = _norm(adapter);
  if (!a) return false;
  return NATIVE_TOOL_USE_ADAPTERS.includes(a);
}

/**
 * model 维度:该模型是否**缺乏**可靠的原生工具调用(=须退回文本拦截)。
 * @param {string} model
 * @param {{env?: object, measured?: ('native'|'text'|null)}} [opts]
 *   measured:实测裁决(toolCapabilityStore.getVerdict 的结果);胜过名字启发,但低于 env 强制。
 * @returns {boolean}
 */
function modelLacksReliableToolCalling(model, opts = {}) {
  const m = _norm(model);
  if (!m) return false; // 未知/空 → 视为不缺(不过度教学,保留原生路径)
  const env = (opts && opts.env) || process.env;

  const nativeForced = parseModelListEnv(env && env.KHY_NATIVE_TOOL_MODELS);
  if (nativeForced.has(m)) return false; // 用户强制原生,最高优先级

  const textForced = parseModelListEnv(env && env.KHY_TEXT_ONLY_TOOL_MODELS);
  if (textForced.has(m)) return true; // 用户强制纯文本工具

  // 实测裁决:胜过任何按名字的启发(「不硬编码,实测为准」)。
  const measured = opts && opts.measured;
  if (measured === 'native') return false; // 实测能原生调工具
  if (measured === 'text') return true; // 实测不支持原生工具

  // 实测前的暂定默认:小模型名 → 缺(安全走文本协议);其余 → 不缺(保留原生)。
  return SMALL_MODEL_HINTS.test(m);
}

/**
 * 组合判定:在某个 adapter 上跑某个 model 时,是否具备可靠原生工具调用。
 * 取代四处历史内联逻辑的统一表达:有原生通道的适配器 ∧ 模型不缺。
 * @param {{model?: string, adapter?: string, env?: object, measured?: ('native'|'text'|null)}} [opts]
 * @returns {boolean}
 */
function hasNativeToolUse(opts = {}) {
  const { model, adapter, env, measured } = opts || {};
  if (!adapterSupportsNativeToolUse(adapter)) return false;
  return !modelLacksReliableToolCalling(model, { env, measured });
}

/**
 * 剥离门判据:relay/multiFree 这类原生适配器在发请求前,是否应把 tools 从上游请求里
 * 删掉(模型不支持 function calling,发 tools 会 400)。等价于 model 维度的「缺」判定。
 * @param {string} model
 * @param {{env?: object}} [opts]
 * @returns {boolean}
 */
function shouldStripUpstreamTools(model, opts = {}) {
  return modelLacksReliableToolCalling(model, opts);
}

module.exports = {
  NATIVE_TOOL_USE_ADAPTERS,
  SMALL_MODEL_HINTS,
  isEnabled,
  parseModelListEnv,
  adapterSupportsNativeToolUse,
  modelLacksReliableToolCalling,
  hasNativeToolUse,
  shouldStripUpstreamTools,
};
