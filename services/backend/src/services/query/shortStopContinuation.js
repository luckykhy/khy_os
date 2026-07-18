'use strict';

// [AI-弱模型·照抄] 纯叶子:形状照 streamRepetitionGuard.js / answerEchoGuard.js。零 I/O、确定性、
//   绝不抛、门关返安全默认(shouldContinue→false)。本门**默认关**(opt-in):续写是缓解弱模型早停的
//   启发式,多一次模型调用、且可能续写本就该短的答案,故不默认注入,仅显式开启时生效。

/**
 * shortStopContinuation.js — 纯叶子:弱模型「自然早停」的一次性自动续写缓解。
 *
 * 缺口(dogfood,provider api:agnes:agnes-2.0-flash):「讲个笑话」在 ~26 token 处以自然 stop
 * (finish_reason=stop,**非** length)中途断句结束(「…那你举个例」)。这不是 khyos 缺陷——khyos
 * 忠实渲染了模型产出;maxTokensRecovery 只处理 length(截断),对自然 stop 不介入。根因是弱模型早停。
 *
 * 本叶子提供**可选**缓解:当回复以非终止标点中途断句 + 异常短 + finish_reason 为自然停止时,
 * 判定值得追加一次「接着上文继续把话说完」的续写(接线处单次封顶)。续写产**新文本**(补完的下半句),
 * 不会与 answerEchoGuard 的回声判定冲突。
 *
 * 与既有件的关系(不重复造):
 *   - maxTokensRecovery —— 只在 finish_reason ∈ {length, max_tokens, …} 时续写(真截断)。
 *     本叶子只在**自然 stop**(非 length)且答案可疑地短、中途断句时介入,二者 stopReason 互斥。
 *   - streamRepetitionGuard —— 管单轮流内退化(chanting),与「早停」正交。
 *
 * 契约:纯叶子——零 I/O、确定性、绝不抛。门(KHY_SHORT_STOP_CONTINUATION,默认关)关 → shouldContinue
 * 恒 false(逐字节回退,维持今日「忠实渲染早停」的行为)。
 *
 * @module services/query/shortStopContinuation
 */

// 自然停止(模型自认说完)的 finish_reason。截断类(length/max_*)不在本叶子范围——那是 maxTokensRecovery。
const NATURAL_STOP_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'end']);

// 答案「异常短」的非空白字符上限。短于此且中途断句才可能是早停(长答案就算无终止标点也不续)。
const DEFAULT_MAX_CHARS = 40;

// 终止标点(含中文全角与常见收尾引号/括号)。结尾命中其一 → 视为已把话说完,不续写。
const TERMINAL_PUNCT_RE = /[。！？.!?…；;”"』」）)\]】]$/;

/**
 * 是否启用(opt-in,默认关)。委托 flagRegistry;不可用时逐字节回退「仅 true|1 视为开」。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const flagRegistry = require('../flagRegistry');
    return flagRegistry.isFlagEnabled('KHY_SHORT_STOP_CONTINUATION', e);
  } catch {
    const raw = e && e.KHY_SHORT_STOP_CONTINUATION;
    return raw === 'true' || raw === '1';
  }
}

function _isNaturalStop(stopReason) {
  if (!stopReason) return false;
  return NATURAL_STOP_REASONS.has(String(stopReason).trim().toLowerCase());
}

/**
 * 判定这条回复是否值得追加一次续写。纯函数,绝不抛;门关或不满足 → false。
 *
 * 全部条件:门开 && !alreadyUsed && finish_reason 为自然停止(非 length/tool_use)
 *          && 归一化后非空白字符数 < maxChars && 结尾无终止标点(中途断句)。
 *
 * @param {{reply:string, stopReason:string, alreadyUsed?:boolean, maxChars?:number}} ctx
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldContinue(ctx, env) {
  try {
    if (!isEnabled(env)) return false;
    if (!ctx || typeof ctx !== 'object') return false;
    if (ctx.alreadyUsed === true) return false;
    if (!_isNaturalStop(ctx.stopReason)) return false;

    const reply = typeof ctx.reply === 'string' ? ctx.reply : '';
    const trimmed = reply.replace(/[\s　]+$/g, ''); // 只剥尾部空白以判末字符
    const compact = reply.replace(/[\s　]+/g, '');
    if (compact.length === 0) return false; // 空回复交给别的路径,不在本叶子范围

    const maxChars = ctx && Number.isFinite(ctx.maxChars) ? ctx.maxChars : DEFAULT_MAX_CHARS;
    if (compact.length >= maxChars) return false; // 足够长 → 不是早停

    if (TERMINAL_PUNCT_RE.test(trimmed)) return false; // 有终止标点 → 已说完
    return true; // 短 + 中途断句 + 自然 stop → 值得续写一次
  } catch {
    return false; // fail-soft
  }
}

/**
 * 续写 nudge。要求模型接着上文把话说完、不要重复已说内容。
 * @returns {string}
 */
function buildContinuationMessage() {
  return '[SYSTEM: 续写] 你上一条回复似乎在中途断句、没有把话说完。请**直接接着上文继续**把它说完，'
    + '不要重复已经说过的内容、不要重新开头、不要道歉，只补上后续部分。';
}

module.exports = {
  isEnabled,
  shouldContinue,
  buildContinuationMessage,
  NATURAL_STOP_REASONS,
  DEFAULT_MAX_CHARS,
};
