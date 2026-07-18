'use strict';

/**
 * adaptiveParamStrip.js — 自适应参数匹配:当上游因某个可选采样参数「参数不对」而
 * 返回 HTTP 400 时,从错误报文里识别被点名、且本次请求确实发出的可选参数,剥离后
 * 重试,而不是把「参数不对」错误码直接抛给用户。
 *
 * WHY (平台/模型自适应):
 * 不同模态/家族的模型接受的参数子集不同——一个向量/嵌入或精简对话模型可能拒绝
 * `temperature` / `top_p` / `reasoning_effort` / `response_format` 等,回 400
 * `Unsupported parameter: 'reasoning_effort'`(或 GLM 系「不支持的参数」/「参数错误」)。
 * relayApiAdapter 早有「400 + tools → 剥 tools 重试」的自适应先例;本叶把同一模式
 * 推广到通用采样参数,让 khy 自适应匹配各模型接受的参数集合。
 *
 * 纯函数 + fail-soft:零 I/O、绝不抛;无法判定就返回空(不误删)。
 *
 * 安全红线:只剥「可选采样参数」白名单,永不触碰 model / messages / input / stream /
 * max_tokens 等结构性或必填字段(剥它们会改变语义或直接失败)。
 *
 * 门 KHY_ADAPTIVE_PARAM_STRIP(default-on)。关闭(0/false/off/no)时 planParamStrip
 * 返回 enabled:false → 调用点逐字节回退到「不做参数剥离」的旧行为。
 *
 * HOW TO EXTEND — 教 khy 认得更多可剥离参数:
 *   1. 往 _STRIPPABLE_PARAMS 加参数名(必须是「可选、剥掉不改变请求合法性」的)。
 *   2. 往 _UNSUPPORTED_SIGNALS 加新的上游「不支持」措辞(小写子串匹配)。
 *   3. 在 adaptiveParamStrip.test.js 加一条用例。
 */

// 可安全剥离的可选采样参数白名单。绝不含 model/messages/input/stream/max_tokens。
const _STRIPPABLE_PARAMS = Object.freeze([
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'stop',
  'response_format',
  'reasoning_effort',
  'thinking',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'n',
  'stream_options',
  'parallel_tool_calls',
]);

// 上游「这个参数不被支持」的措辞信号(小写子串)。只有错误报文命中其一,才认为
// 是「参数不对」类 400,避免把偶然提到参数名的普通 400 误判成可剥离。
const _UNSUPPORTED_SIGNALS = Object.freeze([
  'unsupported parameter',
  'unsupported_parameter',
  'unsupported value',
  'unknown parameter',
  'unknown_parameter',
  'unrecognized',
  'unexpected parameter',
  'not supported',
  'does not support',
  "isn't supported",
  'is not permitted',
  'not allowed',
  'invalid parameter',
  'invalid_parameter',
  'invalid argument',
  'extra fields not permitted',
  'unpermitted',
  '不支持',
  '不支持的参数',
  '未知参数',
  '未知的参数',
  '无效参数',
  '无效的参数',
  '参数错误',
  '参数不支持',
]);

const _PARAM_STRIP_FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env) {
  const raw = (env || process.env).KHY_ADAPTIVE_PARAM_STRIP;
  if (raw == null || raw === '') return true; // default-on
  return !_PARAM_STRIP_FALSY.has(String(raw).trim().toLowerCase());
}

function _stripSignalPresent(lowerText) {
  for (const sig of _UNSUPPORTED_SIGNALS) {
    if (lowerText.includes(sig)) return true;
  }
  return false;
}

/**
 * Identify which optional params the upstream 400 is rejecting.
 * Returns the intersection of: (a) params on the whitelist, (b) present in the
 * request body, (c) named in the error text — but ONLY when the error carries an
 * "unsupported"-type signal (otherwise returns []).
 *
 * @param {string} errorText - upstream error message / raw body slice
 * @param {object} body - the outbound request body
 * @returns {string[]} param keys to strip (subset of body keys)
 */
function detectUnsupportedParams(errorText, body) {
  if (!body || typeof body !== 'object') return [];
  const text = String(errorText == null ? '' : errorText);
  if (!text) return [];
  const lower = text.toLowerCase();
  if (!_stripSignalPresent(lower)) return [];
  const out = [];
  for (const key of _STRIPPABLE_PARAMS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    // Word-ish boundary: the param name appears in the error (case-insensitive).
    if (lower.includes(key.toLowerCase())) out.push(key);
  }
  return out;
}

/**
 * Gate-aware strip plan for a 400 retry loop. Filters out params already stripped
 * this request so the loop converges.
 *
 * @param {string} errorText
 * @param {object} body
 * @param {{alreadyStripped?:Set<string>, env?:object}} [opts]
 * @returns {{enabled:boolean, strip:string[]}}
 */
function planParamStrip(errorText, body, opts = {}) {
  const enabled = isEnabled(opts.env);
  if (!enabled) return { enabled: false, strip: [] };
  const already = opts.alreadyStripped instanceof Set ? opts.alreadyStripped : new Set();
  const detected = detectUnsupportedParams(errorText, body);
  const strip = detected.filter((k) => !already.has(k));
  return { enabled: true, strip };
}

module.exports = {
  isEnabled,
  detectUnsupportedParams,
  planParamStrip,
  // exported for tests
  _STRIPPABLE_PARAMS,
  _UNSUPPORTED_SIGNALS,
};
