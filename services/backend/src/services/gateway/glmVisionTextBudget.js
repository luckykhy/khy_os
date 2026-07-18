'use strict';

/**
 * glmVisionTextBudget — 纯叶子:把发往 GLM 视觉模型的**文本**内容,在发送前无依赖地
 * 中段截断到 GLM 视觉端的 16384 合并预算内,避免超大文本(如磁盘扫描 JSON 工具结果)
 * 撞 400 code 1210(`inputs tokens + max_new_tokens must be <= 16384`)。
 *
 * 背景 / 实测根因(「大文本 400 code 1210」——1210 的第三种形态):
 *   已修两种 1210:①单参数 max_tokens>1024(glmVisionMaxTokens);②单张图片像素过大
 *   (glmVisionImageDownscale)。第三种是**纯文本**撑爆合并预算——一次 C+D 盘扫描的
 *   DiskCleanup 工具结果编码成约 25304 个 input token > 16384,**无图片**,故前两个修复
 *   都不触发,请求带着 25304 token 直接打到只有 16384 预算的 glm-4v-flash 上 → 恒 400
 *   code 1210 → 网关级联耗尽 → 落到剪贴板中转兜底(见排障:「为什么会出现剪贴板中转模式」)。
 *   文本大模型窗口大故无此问题,唯 GLM 视觉小模型的合并预算受限。
 *
 *   本叶子:命中 GLM 视觉模型时,估算 messages 里所有文本 token,若超过
 *   「合并预算 - 输出保留 - 安全余量」的**输入预算**,就**中段截断最大的文本块**
 *   (优先缩磁盘扫描这类巨型工具结果,保留系统/用户小提示不动),保头保尾 + 插入截断标记,
 *   让模型仍看到内容结构。就地 mutate messages(镜像 glmVisionImageDownscale 的
 *   downscaleImageBlocksInMessages),仅当确有收缩才改。
 *
 * 设计红线(镜像 glmVisionImageDownscale):
 *   - **仅** GLM 视觉模型触发(判定复用 glmVisionApiPin 单一真源),其它模型零影响;
 *   - **仅** 估算超预算才截断,预算内 0 成本透传;
 *   - 无第三方依赖,纯字符串运算,零 IO;
 *   - **绝不抛**:任何异常 → 原样透传(把决定权交回既有诊断 / OCR 兜底 / 剪贴板兜底)。
 *
 * 门控 KHY_GLM_VISION_TEXT_BUDGET(parent = KHY_GLM_VISION_MODEL,默认开;
 * 0/false/off/no → 关)。关门 / 异常 → 原样透传(逐字节回退今日行为)。
 */

// GLM 视觉端合并预算上限(inputs + max_new_tokens)。与 glmVisionImageDownscale 同一常量。
const COMBINED_TOKEN_BUDGET = 16384;
// 输出保留:GLM 视觉 max_tokens 上限为 1024(见 glmVisionMaxTokens)。调用方通常已把它钳到
// 1024;此处作为缺省的输出保留,确保输入预算给输出留足空间。
const DEFAULT_OUTPUT_RESERVE_TOKENS = 1024;
// 安全余量:token 估算误差 + 请求结构(role / JSON 包裹 / 消息分隔)的额外开销。宁可多截
// 一点也别贴着上限撞 1210。默认输入预算 = 16384 - 1024 - 1360 = 14000。
const SAFETY_MARGIN_TOKENS = 1360;
const DEFAULT_INPUT_BUDGET =
  COMBINED_TOKEN_BUDGET - DEFAULT_OUTPUT_RESERVE_TOKENS - SAFETY_MARGIN_TOKENS; // 14000

// token 估算(启发式,非精确计费):CJK 字符按 1 char/token(**高估**),其它按 3.5 char/token。
// 与 glmVisionImageDownscale 同一取向——宁可高估 token(多截一点)也别低估又撞 1210。
const CJK_CHARS_PER_TOKEN = 1;
const ASCII_CHARS_PER_TOKEN = 3.5;

// 单个文本块被截断后至少保留的 token(避免把小上下文整块截没,保留可读的头尾)。
const MIN_KEEP_TOKENS = 200;

// 截断标记本身占的 token 预留(_middleTruncate 会插入一行中文标记,约 40~60 token)。
// 计算 keepTokens 时先扣掉它,确保「保留正文 + 标记」的合计仍落在目标预算内。
const MARKER_TOKEN_RESERVE = 64;

// CJK / 假名 / 谚文 区间(与中日韩全角文字对齐)。用于给文本 token 估算加权。
const _CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af\uff00-\uffef]/g;

/**
 * 环境布尔门:缺省 / 空 → dflt;0/false/off/no → false。异常 → false。
 * @param {*} raw
 * @param {boolean} [dflt]
 * @returns {boolean}
 */
// 收敛到 utils/onValueOr 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/onValueOr');

/**
 * 门控 KHY_GLM_VISION_TEXT_BUDGET:默认开;0/false/off/no → 关。异常 → 关门(false)。
 * @param {object} [env]
 * @returns {boolean}
 */
function textBudgetEnabled(env = process.env) {
  return _envOn(env && env.KHY_GLM_VISION_TEXT_BUDGET, true);
}

/**
 * 估算一段文本的 GLM input token(启发式,偏高估)。纯函数、不抛。
 * @param {string} str
 * @returns {number}
 */
function estimateTextTokens(str) {
  const s = String(str == null ? '' : str);
  if (!s) return 0;
  const cjk = (s.match(_CJK_RE) || []).length;
  const other = Math.max(0, s.length - cjk);
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / ASCII_CHARS_PER_TOKEN);
}

/**
 * 由目标 token 数反推可保留的字符数(用当前串的 char/token 比例换算,保守偏少)。
 * @param {string} str
 * @param {number} keepTokens
 * @returns {number}
 */
function _keepCharsForTokens(str, keepTokens) {
  const s = String(str == null ? '' : str);
  const tokens = estimateTextTokens(s);
  if (tokens <= 0) return s.length;
  const charsPerToken = s.length / tokens; // 该串实际的字符/ token 比
  return Math.max(0, Math.floor(keepTokens * charsPerToken));
}

/**
 * 中段截断:保头(60%)+ 截断标记 + 保尾(40%)。已在预算内 → 原样返回。纯函数、不抛。
 * @param {string} str
 * @param {number} keepChars 目标保留字符数(不含标记)
 * @returns {string}
 */
function _middleTruncate(str, keepChars) {
  const s = String(str == null ? '' : str);
  const keep = Math.max(0, Math.floor(keepChars));
  if (s.length <= keep) return s;
  const headLen = Math.floor(keep * 0.6);
  const tailLen = Math.max(0, keep - headLen);
  const cut = s.length - keep;
  const marker = `\n…[khy 已截断约 ${cut} 字符以适配 glm-4v-flash 的 16384 合并预算;如需完整内容请换文本大窗口模型]…\n`;
  return s.slice(0, headLen) + marker + (tailLen > 0 ? s.slice(s.length - tailLen) : '');
}

/**
 * 从一条消息里收集所有「可截断的文本位置」。返回 { get, set, tokens } 三元组数组。
 * 支持形状:
 *   - { role, content: "字符串" }                                  (纯文本消息)
 *   - { role, content: [ { type:'text', text:'...' }, ... ] }       (OpenAI/ChatML 块)
 *   - { role, content: [ { type:'input_text', text:'...' }, ... ] } (Responses API)
 *   - { role, content: [ { type:'text', text:'...' }, ... ] }       (Anthropic text 块同形)
 * @param {object} msg
 * @returns {Array<{get:()=>string, set:(s:string)=>void, tokens:number}>}
 */
function _collectTextLocations(msg) {
  const out = [];
  if (!msg || typeof msg !== 'object') return out;
  const content = msg.content;
  if (typeof content === 'string') {
    if (content.length > 0) {
      out.push({
        get: () => msg.content,
        set: (s) => { msg.content = s; },
        tokens: estimateTextTokens(content),
      });
    }
    return out;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text')
          && typeof block.text === 'string' && block.text.length > 0) {
        const b = block;
        out.push({
          get: () => b.text,
          set: (s) => { b.text = s; },
          tokens: estimateTextTokens(b.text),
        });
      }
    }
  }
  return out;
}

/**
 * **真正命中相关路径的接线**:命中 GLM 视觉模型时,就地把 messages 里的文本内容中段
 * 截断到输入预算内。仅当估算超预算才动,且优先缩最大的文本块(磁盘扫描这类巨型工具结果),
 * 保留系统/用户小提示。原地 mutate。绝不抛。
 *
 * @param {string} model                目标模型串(可带 provider 前缀,如 `glm/glm-4v-flash`)
 * @param {object[]} messages           OpenAI/ChatML 或 Responses input[] 消息数组
 * @param {object} [options]
 * @param {number} [options.maxTokens]  本次请求的输出 token 保留(默认 1024)
 * @param {number} [options.inputBudget] 直接指定输入 token 预算(优先于 maxTokens 推算)
 * @param {object} [env]
 * @returns {{changed:boolean, beforeTokens:number, afterTokens:number, budget:number, truncated:number}}
 */
function clampTextBudgetInMessages(model, messages, options = {}, env = process.env) {
  const noop = { changed: false, beforeTokens: 0, afterTokens: 0, budget: 0, truncated: 0 };
  try {
    if (!textBudgetEnabled(env)) return noop;
    if (!Array.isArray(messages) || messages.length === 0) return noop;
    const { isGlmVisionModelName } = require('./glmVisionApiPin');
    if (!isGlmVisionModelName(model)) return noop;

    // 输入预算:显式 inputBudget 优先;否则 16384 - 输出保留 - 安全余量。
    let budget;
    if (Number.isFinite(Number(options.inputBudget)) && Number(options.inputBudget) > 0) {
      budget = Math.floor(Number(options.inputBudget));
    } else {
      const outReserve = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0
        ? Math.floor(Number(options.maxTokens))
        : DEFAULT_OUTPUT_RESERVE_TOKENS;
      budget = COMBINED_TOKEN_BUDGET - outReserve - SAFETY_MARGIN_TOKENS;
    }
    if (budget < MIN_KEEP_TOKENS) budget = MIN_KEEP_TOKENS; // 极端情况兜底

    const locations = [];
    for (const msg of messages) {
      for (const loc of _collectTextLocations(msg)) locations.push(loc);
    }
    const beforeTokens = locations.reduce((sum, l) => sum + l.tokens, 0);
    if (beforeTokens <= budget) {
      return { changed: false, beforeTokens, afterTokens: beforeTokens, budget, truncated: 0 };
    }

    // 需要削减的 token 数;从最大的文本块开始削(保留小提示)。
    let toCut = beforeTokens - budget;
    let truncated = 0;
    const bySizeDesc = locations.slice().sort((a, b) => b.tokens - a.tokens);
    for (const loc of bySizeDesc) {
      if (toCut <= 0) break;
      const maxCutFromThis = loc.tokens - MIN_KEEP_TOKENS;
      if (maxCutFromThis <= 0) continue; // 已经很小,不再削
      const cutHere = Math.min(toCut, maxCutFromThis);
      const keepTokens = loc.tokens - cutHere;
      // 扣掉截断标记的 token 预留,确保「保留正文 + 标记」合计仍落在目标预算内。
      const keepChars = _keepCharsForTokens(loc.get(), Math.max(MIN_KEEP_TOKENS / 2, keepTokens - MARKER_TOKEN_RESERVE));
      const newStr = _middleTruncate(loc.get(), keepChars);
      const newTokens = estimateTextTokens(newStr);
      if (newTokens < loc.tokens) {
        loc.set(newStr);
        toCut -= (loc.tokens - newTokens);
        truncated += 1;
      }
    }

    const afterTokens = locations.reduce((sum, l) => sum + estimateTextTokens(l.get()), 0);
    return { changed: truncated > 0, beforeTokens, afterTokens, budget, truncated };
  } catch {
    return noop;
  }
}

module.exports = {
  clampTextBudgetInMessages,
  textBudgetEnabled,
  estimateTextTokens,
  _collectTextLocations,
  _middleTruncate,
  _keepCharsForTokens,
  COMBINED_TOKEN_BUDGET,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  SAFETY_MARGIN_TOKENS,
  DEFAULT_INPUT_BUDGET,
  MIN_KEEP_TOKENS,
};
