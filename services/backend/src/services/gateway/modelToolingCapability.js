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
  'kiro',
  'cursor',
  'trae',
  'claude',
  'codex',
  'api',
  'windsurf',
  'vscode',
  'warp',
  'cursor2api',
  'relay_api',
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
  if (!a) {
    return false;
  }
  return NATIVE_TOOL_USE_ADAPTERS.includes(a);
}

/**
 * model 维度:该模型是否**缺乏**可靠的原生工具调用(=须退回文本拦截)。
 * @param {string} model
 * @param {{env?: object, measured?: ('native'|'text'|null)}} [opts]
 *   measured:实测裁决(toolCapabilityStore.getVerdict 的结果);胜过名字启发,但低于 env 强制。
 * @returns {boolean}
 */
/**
 * 用户强制名单命中判定。两种写法都认。
 *
 * 为什么:调用方拿到的 model 有两种形态 —— 教学门给路由 id(`api:agnes:agnes-3.0-flash`),
 * 剥离门给裸模型名(`agnes-3.0-flash`)。只比裸名会让同一条 env 只在一个门上生效:
 * 用户设了 KHY_NATIVE_TOOL_MODELS,模型却仍被注入「你没有原生工具,请用文本语法」教学。
 * 与实测缓存(capabilityModelKey 规范化)用同一套键,两个门才不可能各执一词。
 * @param {Set<string>} set
 * @param {string} m 已 _norm 的 model 串
 * @returns {boolean}
 */
function _forcedHit(set, m) {
  if (set.has(m)) {
    return true;
  }
  let key = '';
  try {
    key = require('./capabilityModelKey').capabilityModelKey(m);
  } catch {
    key = '';
  } // 叶子不可用 → 只认裸名,绝不抛
  return !!key && key !== m && set.has(key);
}

/**
 * model 维度:该模型是否**缺乏**可靠的原生工具调用(=须退回文本拦截)。
 *
 * 用途是**提示词侧**(教学门):被判「缺」的模型会被注入 `<tool_call>` 文本协议教学。
 *
 * 档位优先级:
 *   1. env 强制原生 / 强制纯文本(用户主权,最高)
 *   2. 实测裁决 measured('native'→不缺 / 'text'→缺),或通道拒收 → 缺
 *   3. 名字启发 SMALL_MODEL_HINTS(暂定档)
 *
 * ⚠ **本函数自 2026-09-23 起不再决定 wire 行为**。它保留名字启发档,因为「先教一遍文本
 * 协议」对暂定档是零代价的(教了不用不花钱);而「先剥掉 tools」不是零代价的 —— 剥掉之后
 * 模型再也无法用原生调用证明自己,误判无法被现实推翻(BUG-014)。wire 侧请用
 * shouldStripUpstreamTools,那条路只认正面证据。
 *
 * 为什么「既发 tools 又教回退语法」不是矛盾指令(别把它改成与剥离门耦合):
 * 教学文案是**加性**的 —— prompts.js:_toolCallingFallbackProfile 的标题就是
 * 「Tool calling (text-based fallback)」,只告诉模型「可以这样写」,从不断言「你没有原生
 * 工具」。而且文本协议下的调用是**一等公民**:resolveToolCalls 在两条协议里都会解析执行
 * 它(resolveToolCalls.js:50-113)。所以暂定档有两条成功路径,任一条走通都算成功:
 * 原生通道可用 → 结构化调用;原生通道不可用 → 模型回退到文本语法 → 照样执行。
 * 真正会失败的是「两条路都不走、只在散文里说『我先搜索一下』」——那要靠实测把该模型
 * 判进 text 档来纠正,不是靠让两个门互相耦合。
 * @param {string} model
 * @param {{env?: object, measured?: ('native'|'text'|null), routeRejects?: boolean}} [opts]
 *   measured:实测裁决(toolCapabilityStore.getVerdict 的结果);胜过名字启发,但低于 env 强制。
 *   routeRejects:该通道是否被记为「拒收 tools」(toolCapabilityStore.routeRejectsTools)。
 * @returns {boolean}
 */
function modelLacksReliableToolCalling(model, opts = {}) {
  const m = _norm(model);
  if (!m) {
    return false;
  } // 未知/空 → 视为不缺(不过度教学,保留原生路径)
  const env = (opts && opts.env) || process.env;

  const nativeForced = parseModelListEnv(env && env.KHY_NATIVE_TOOL_MODELS);
  if (_forcedHit(nativeForced, m)) {
    return false;
  } // 用户强制原生,最高优先级

  const textForced = parseModelListEnv(env && env.KHY_TEXT_ONLY_TOOL_MODELS);
  if (_forcedHit(textForced, m)) {
    return true;
  } // 用户强制纯文本工具

  // 实测裁决:胜过任何按名字的启发(「不硬编码,实测为准」)。
  const measured = opts && opts.measured;
  if (measured === 'native') {
    return false;
  } // 实测能原生调工具
  if (measured === 'text') {
    return true;
  } // 实测不支持原生工具
  if (opts && opts.routeRejects === true) {
    return true;
  } // 通道收不了 tools → 只能走文本协议

  // 实测前的暂定默认:小模型名 → 缺(安全走文本协议);其余 → 不缺(保留原生)。
  return SMALL_MODEL_HINTS.test(m);
}

/**
 * 组合判定:在某个 adapter 上跑某个 model 时,是否具备可靠原生工具调用。
 * 取代四处历史内联逻辑的统一表达:有原生通道的适配器 ∧ 模型不缺。
 * @param {{model?: string, adapter?: string, env?: object, measured?: ('native'|'text'|null), routeRejects?: boolean}} [opts]
 * @returns {boolean}
 */
function hasNativeToolUse(opts = {}) {
  const { model, adapter, env, measured, routeRejects } = opts || {};
  if (!adapterSupportsNativeToolUse(adapter)) {
    return false;
  }
  return !modelLacksReliableToolCalling(model, { env, measured, routeRejects });
}

/**
 * 剥离门判据(**wire 侧**):relay/multiFree 这类原生适配器在发请求前,是否应把 tools 从
 * 上游请求里删掉。
 *
 * **只认正面证据**(2026-09-23 起,BUG-014):
 *   - env 强制纯文本 / 强制原生 —— 用户主权,最高
 *   - measured === 'native' / 'text' —— 实测裁决
 *   - routeRejects === true —— 该**通道**带 tools 被拒、去掉 tools 成功(端点属性)
 *   - **challenge === true** —— 隔离式挑战轮(每 N 次请求放行一次):即便已判 text 也照发,
 *     让模型有机会原生调用一次来推翻结论。见 toolChallengeCadence
 *   - 其余一切(含「未实测 + 名字含 flash」)→ **发**
 *
 * 为什么不认名字:剥掉 tools 之后模型再也拿不到 tools、也就再也产生不了原生 tool_calls,
 * 被动学习无法翻案 —— 一旦猜错就锁死到 TTL 到期。而「先发」错了可以挽回:端点真拒收就会
 * 回 400,那条 400 恰好构成 routeRejects 的对照证据,记下之后该通道不再付第二次。
 *
 * 与 modelLacksReliableToolCalling 的分工:那个函数保留名字启发档,供**提示词侧**(教学门)
 * 使用 —— 先教一遍文本协议是零代价的(教了不用不花钱);而剥掉 tools 不是零代价的。
 * @param {string} model
 * @param {{env?: object, measured?: ('native'|'text'|null), routeRejects?: boolean, challenge?: boolean}} [opts]
 * @returns {boolean} true=应剥离 tools(消息中的工具块须内联为文本)
 */
function shouldStripUpstreamTools(model, opts = {}) {
  const m = _norm(model);
  if (!m) {
    return false;
  }
  const env = (opts && opts.env) || process.env;

  const nativeForced = parseModelListEnv(env && env.KHY_NATIVE_TOOL_MODELS);
  if (_forcedHit(nativeForced, m)) {
    return false;
  }
  const textForced = parseModelListEnv(env && env.KHY_TEXT_ONLY_TOOL_MODELS);
  if (_forcedHit(textForced, m)) {
    return true;
  } // 用户钉子连挑战轮也不越过 —— 那是用户明确要的状态

  const measured = opts && opts.measured;
  if (measured === 'native') {
    return false;
  } // 见过真实原生 tool_calls —— 正面证据压过通道否决

  // 通道拒收是**端点的定论**,不参与挑战:挑战要推翻的是「模型被判 text」这个关于模型的
  // 结论。这里必须在 challenge 之前判 —— 否则这条不变量就只剩调用方的约定,而调用方一行
  // 疏忽就会让严格端点每次都吃 400(SECURITY-004 fail-closed / RUNTIME-010 同精神)。
  if (opts && opts.routeRejects === true) {
    return true;
  }

  // 隔离式挑战:只有「被判 text」的模型需要这一趟。
  if (opts && opts.challenge === true) {
    return false;
  }

  if (measured === 'text') {
    return true;
  }

  return false; // 未知 → 先发,让现实给证据
}

/**
 * 剥离 tools 时给用户看的说明(单一真源)。
 *
 * 为什么收口到这里:multiFreeService 与 relayApiAdapter 两个剥离门各自内联过一份文案,
 * 已经是同一判断的两个副本。文案要说的其实是「本模块做的那个决定」,而决定只有一份,
 * 所以说明也只有一份 —— 两处都不再持有字符串,漂移在结构上不可能发生。
 *
 * 措辞原则(旧文案的教训):旧文案写「不支持工具调用…请切换到支持 function calling 的模型」,
 * 但工具**仍在通过文本协议正常执行**,于是用户被引导去换模型,排障方向被指错。新文案只陈述
 * 两个可核对的事实(未确证 / 工具仍可用),再给一条能自己验证的出路(复测命令)。
 * @param {string} model
 * @returns {string}
 */
function stripToolsNotice(model) {
  const m = String(model == null ? '' : model).trim() || '(当前模型)';
  return (
    `模型 ${m} 未确证原生工具调用：本轮改由文本协议携带调用（工具仍可用）。` +
    `复测原生通道：khy gateway probe-tools ${m}（可用 --adapter 指定通道）`
  );
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
  stripToolsNotice,
};
