'use strict';

/**
 * replyGuard — 空回复守卫**单一真源**(纯叶子)。
 *
 * Goal:「对 Khyos 制作一个回复守卫,如果是空回复主动丢弃,并要求 ai 重发新消息」。
 *
 * 背景(已核实的真因漏路):
 *   真正空的模型回合(`!aiResult.reply`)早有 toolUseLoop 的恢复块「丢弃 + 重发」覆盖,
 *   但 cli/ai.js 的 chat() 对真正空的回合会塞入**非空诊断占位串**
 *   (如「抱歉，AI 未能生成有效回复…」)并返回 `errorType:'empty_reply'`。这条结果先命中
 *   errorType 分支,而 `_isTransientLoopErrorType` 只认裸 'empty' 不认 'empty_reply',于是
 *   跳过所有重发机制,把占位串当 stopped:true 失败抛给用户——既没丢弃也没要求重发。
 *
 * 本守卫是「什么算应丢弃并重发的空回复」的唯一判定真源,供 toolUseLoop 在 errorType 分支
 * 接线,把这条漏路也纳入「主动丢弃 + 有界重发」。
 *
 * 纯叶子契约:零 IO、确定性、**绝不抛**、fail-soft。仅 require 同为纯叶子的
 * query/continuation 复用 NON_RESUMABLE 真源(内容安全/拒答/权限绝不重发),不重复定义。
 *
 * 门控 `KHY_REPLY_GUARD` 默认开;关闭时 shouldDiscardAndRerequest 恒 false,调用方 seam
 * 整体 no-op,逐字节回退到现状。
 */

const continuation = require('./query/continuation');

const ENV_FLAG = 'KHY_REPLY_GUARD';

// 中断(cancelled/timeout/network/process…可恢复但非空回复类型)排除开关。默认开;
// 关闭 → 逐字节回退到「replyBlank 早退把中断也当空回复」的历史行为。仅显式 falsy 关。
const INTERRUPT_EXCL_FLAG = 'KHY_REPLY_GUARD_INTERRUPT_EXCL';

function _interruptExclusionEnabled(env = process.env) {
  try {
    const raw = env ? env[INTERRUPT_EXCL_FLAG] : undefined;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true; // fail-soft:默认开
  }
}

/**
 * 应被「主动丢弃 + 重发」的空回复 errorType(口语化类型,来自 cli/ai.js / 适配器 / 循环层)。
 * 刻意**不含**:
 *   - 'empty_reply_salvaged' —— 已有真实兜底数据=真回答,绝不丢弃;
 *   - 'content_filter' / 'refusal' / 'safety' / 'permission' —— NON_RESUMABLE,绝不重发
 *     (由 shouldDiscardAndRerequest 内的 continuation.isResumableError 再挡一道,防御纵深)。
 */
const EMPTY_ERROR_TYPES = new Set(['empty_reply', 'empty_response', 'empty']);

/**
 * 守卫是否启用。默认开;仅显式 falsy(0/false/off/no)关闭。
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function isReplyGuardEnabled(env = process.env) {
  try {
    const raw = env ? env[ENV_FLAG] : undefined;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true; // fail-soft:默认开
  }
}

/**
 * 单一真源谓词:这次 chat 结果是否为「应丢弃重发的空回复」。
 * 满足任一即真:
 *   (a) 裸空 —— 无结果 / reply 去空白后为空;
 *   (b) errorType ∈ EMPTY_ERROR_TYPES 且非已兜底(salvaged 真实数据不算空)。
 * 绝不对 NON_RESUMABLE(内容安全/拒答/权限)返回 true。
 * @param {object} aiResult
 * @returns {boolean}
 */
function isEmptyReply(aiResult) {
  try {
    if (!aiResult) return true; // 无结果 = 裸空
    const errorType = aiResult.errorType
      ? String(aiResult.errorType).trim().toLowerCase()
      : '';
    // NON_RESUMABLE(内容安全/拒答/权限)绝不视作可丢弃重发的空回复。
    if (errorType && !continuation.isResumableError(errorType)) return false;
    // 已有真实兜底数据 = 真回答,绝不当空丢弃。
    if (aiResult.salvaged) return false;
    // 中断 ≠ 空回复(单一真源修正,门控 KHY_REPLY_GUARD_INTERRUPT_EXCL 默认开)。
    // 'cancelled'/'timeout'/'network'/'process' 等**可恢复但非空回复类型**的中断,本身携带
    // errorType 且已由 toolUseLoop 的 transient 恢复块专门处理(有界重试后落终态)。它们通常
    // reply 为空,若被下方 replyBlank 早退当作「空回复」,会二次消费 emptyRecovery 预算 → 用户
    // 明确 cancel 后仍被静默重发数次(浪费 token、延迟兑现取消)。故:有 errorType 且**不在**
    // EMPTY_ERROR_TYPES 时,空 reply 是「中断」而非「空回复」,交回 transient 路径,本守卫放行。
    // 真正的空回复路径不受影响:裸空(无 errorType)与 EMPTY_ERROR_TYPES 仍照旧丢弃重发。
    if (errorType
        && !EMPTY_ERROR_TYPES.has(errorType)
        && _interruptExclusionEnabled()) {
      return false;
    }
    const replyBlank = !String(aiResult.reply == null ? '' : aiResult.reply).trim();
    if (replyBlank) return true; // 裸空(含 whitespace-only)
    // 非空 reply 但携带空回复 errorType(cli/ai.js 的诊断占位串)= 漏路本体。
    if (EMPTY_ERROR_TYPES.has(errorType)) return true;
    return false;
  } catch {
    return false; // fail-soft:不确定就不丢弃,绝不误杀正常回复
  }
}

/**
 * 是否应主动丢弃这次空回复并要求模型重发。
 * 门控开 + 未中止 + 是空回复 + 可恢复(防御纵深) + 未超有界预算。
 * @param {{aiResult:object, attemptsUsed:number, maxAttempts:number, aborted?:boolean, env?:object}} p
 * @returns {boolean}
 */
function shouldDiscardAndRerequest(p) {
  try {
    const { aiResult, attemptsUsed, maxAttempts, aborted, env } = p || {};
    if (!isReplyGuardEnabled(env)) return false; // 门控关 → no-op,字节回退
    if (aborted) return false;                    // 用户中止 → 不重发
    if (!isEmptyReply(aiResult)) return false;
    const errorType = aiResult && aiResult.errorType ? aiResult.errorType : '';
    if (!continuation.isResumableError(errorType)) return false; // NON_RESUMABLE 红线
    const used = Number.isFinite(attemptsUsed) ? attemptsUsed : 0;
    const max = Number.isFinite(maxAttempts) ? maxAttempts : 0;
    return used < max; // 预算内才重发;耗尽 → 调用方落回终端报真因
  } catch {
    return false; // fail-soft:任何异常都不重发,避免误入循环
  }
}

/**
 * 重发指令(确定性模板,不回显用户输入、无随机/时钟)。追加到下一轮 currentMessage,
 * 明确告知模型:上一条回复为空已被丢弃,必须重新生成一条完整的新回复。
 * 与 inertialContinuation 的 empty_reply 指令互补(那条说「from scratch」,本条点明「已丢弃」)。
 * @param {{attempt?:number, maxAttempts?:number}} [p]
 * @returns {string}
 */
function buildResendDirective(p) {
  try {
    return '\n\n[SYSTEM: 你上一条回复为空,已被系统主动丢弃。'
      + '请重新生成一条**完整的新回复**,直接给出最终答案,绝不能返回空白或仅有空格。]';
  } catch {
    return '';
  }
}

/**
 * `_system_retry` 状态行文案(给用户看的进度提示)。
 * @param {{attempt?:number, maxAttempts?:number}} [p]
 * @returns {string}
 */
function buildRetryStatusLabel(p) {
  try {
    const { attempt, maxAttempts } = p || {};
    const n = Number.isFinite(attempt) ? attempt : null;
    const m = Number.isFinite(maxAttempts) ? maxAttempts : null;
    if (n != null && m != null) {
      return `空回复已丢弃，正在要求重新生成（${n}/${m}）…`;
    }
    return '空回复已丢弃，正在要求重新生成…';
  } catch {
    return '空回复已丢弃，正在要求重新生成…';
  }
}

module.exports = {
  ENV_FLAG,
  EMPTY_ERROR_TYPES,
  isReplyGuardEnabled,
  isEmptyReply,
  shouldDiscardAndRerequest,
  buildResendDirective,
  buildRetryStatusLabel,
};
