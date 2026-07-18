'use strict';

// chatErrorGuard.js — 主循环模型调用的「防御纵深」纯叶子(零 IO、绝不抛)。
//
// 背景:网关 generate() 的契约是「返回 success:false 而非抛出」——瞬时/工具/模型错误都被
// 归一成返回值,主循环据此优雅结束本轮。但真正*意外*的异常(适配器编程 bug、解析崩溃、
// 非预期的 TypeError 等)会从 `await chat(...)` 穿透到调用方,杀掉整个多日无人值守 run。
// 连续几天像 CC 一样不中断的底气,不该被一次意外抛出打断。
//
// 本叶子把这类意外异常归一成一个「诚实的本轮结束」结果:如实说明发生了意外错误、本轮已安全
// 结束、会话未中断、可继续下一步。接线处据此 return(结束本轮),而非让异常炸掉整个会话。
//
// 门 KHY_TOOL_LOOP_CHAT_GUARD 默认*开*(防御纵深本就该常开);仅显式 falsy 关闭 →
// 接线处逐字节回退到今日行为(重新抛出,异常穿透到调用方)。

// HOW-TO-EXTEND: 若要按错误形态给更贴切的诚实措辞,只在 _classifyKind 增加一条形态判定
// (小写正则命中 → 返回一个稳定 kind 串)。绝不在此做 IO / 抛出 / 依赖其他叶子。

const ON_FALSY = ['0', 'false', 'off', 'no'];

/**
 * Gate: default ON (defense-in-depth). Only an explicit falsy value disables it,
 * in which case the wiring re-throws — byte-identical to today's behavior.
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_TOOL_LOOP_CHAT_GUARD;
    const v = (raw == null ? '' : String(raw)).trim().toLowerCase();
    if (v === '') return true;
    return !ON_FALSY.includes(v);
  } catch {
    return true; // never throw; conservative = guard on
  }
}

/**
 * Extract a human-usable message from any thrown value without ever throwing.
 * @param {*} err
 * @returns {string}
 */
function _messageOf(err) {
  try {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err.message != null) return String(err.message);
    return String(err);
  } catch {
    return '';
  }
}

/**
 * Lightweight, dependency-free shape classification. We deliberately do NOT
 * require errorClassifier here: keeping the leaf zero-cross-dependency makes it
 * impossible for this guard (the last line of defense) to itself throw.
 * @param {string} msg
 * @returns {string} a stable kind token
 */
function _classifyKind(msg) {
  try {
    const m = String(msg || '').toLowerCase();
    if (/timeout|etimedout|timed out|deadline/.test(m)) return 'timeout';
    if (/econnreset|econnrefused|enotfound|socket hang|network|dns|getaddrinfo/.test(m)) return 'network';
    if (/abort|cancell?ed/.test(m)) return 'cancelled';
    return 'unexpected_error';
  } catch {
    return 'unexpected_error';
  }
}

/**
 * Build an honest "this turn ended safely" result from an unexpected chat throw.
 * The wiring returns this so the current TURN ends gracefully while the SESSION
 * (the REPL / gateway caller) continues to the next step.
 * @param {*} err the thrown value
 * @param {object} [opts] { iteration }
 * @returns {{finalResponse:string, errorType:string, errorCode:string, continueHint:string, message:string}}
 */
function buildUnexpectedChatErrorResult(err, opts = {}) {
  try {
    const msg = _messageOf(err);
    const kind = _classifyKind(msg);
    const detail = msg ? `具体错误:${msg}` : '未获取到具体错误信息。';
    const finalResponse =
      '抱歉,本轮模型调用遇到意外异常,已安全结束这一轮(会话未中断,可继续下一步)。\n\n'
      + detail
      + '\n\n提示:回复「继续」即可重试或推进;若反复出现,请检查模型通道 / 网络配置。';
    return {
      finalResponse,
      errorType: kind,
      errorCode: 'E01',
      continueHint: '回复「继续」以重试或推进。',
      message: msg,
    };
  } catch {
    // Absolute fail-soft: even the shaping must never throw on this degraded path.
    return {
      finalResponse:
        '抱歉,本轮模型调用遇到意外异常,已安全结束这一轮(会话未中断,可继续下一步)。回复「继续」以重试。',
      errorType: 'unexpected_error',
      errorCode: 'E01',
      continueHint: '回复「继续」以重试或推进。',
      message: '',
    };
  }
}

module.exports = {
  ON_FALSY,
  isEnabled,
  buildUnexpectedChatErrorResult,
  _messageOf,
  _classifyKind,
};
