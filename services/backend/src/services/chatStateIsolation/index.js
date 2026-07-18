'use strict';

/**
 * chatStateIsolation — [EvoRequirement] 聊天状态污染与回复截断治理（DESIGN-ARCH-046）。
 *
 * 单一职责：把「失败的一轮模型调用」隔离在本次请求的沙箱内，绝不让其副产物
 * （兜底文案、错误占位、被截断的半截话）写入会话历史污染后续对话。
 *
 * 病灶：会话历史的 push 站点对「真实回答」与「兜底错误文案」一视同仁——只要
 * `reply` 非空就 push。于是一次异常（网络/超时/空回复）把「抱歉，我无法回答」
 * 这类罐头文案写进 `_messages`，下一轮作为上下文重放，模型照抄，从此「复读」。
 *
 * 设计：把「这一轮该不该落历史」收敛成一个纯函数判定，并以**原子提交**语义落地：
 *   - 成功轮：push assistant 回复，按 maxHistory 截断（保持原行为）。
 *   - 失败轮：回滚到本轮开始前的历史快照（连同本轮已 push 的 user 消息一并撤回），
 *     使下一次请求从干净状态开始——这正是「异常后自动重置对话上下文」的期望行为，
 *     同时避免「孤儿 user 消息」破坏角色交替（部分 API 要求 user/assistant 严格交替）。
 *
 * 纯函数 + 就地变异调用方持有的数组（不重新赋值引用），零依赖、可单测。
 */

/**
 * 判定一轮的最终结果是否为「错误/兜底轮」。
 *
 * toolUseLoop 在异常路径上一律给 finalResult 打上 `errorType`（timeout/network/
 * empty_reply/content_filter/...）和/或 `error_code`（E01..E08）。正常回答两者皆无。
 * 这是结构化信号（DESIGN-ARCH-028 精准归因的产物），不依赖对文案做字符串匹配。
 *
 * @param {any} finalResult
 * @returns {boolean}
 */
function isErrorTurn(finalResult) {
  if (!finalResult || typeof finalResult !== 'object') return false;
  if (finalResult.errorType) return true;
  if (finalResult.error_code) return true;
  return false;
}

/**
 * 原子提交一轮的会话历史。就地变异 `messages`（不重新赋值，调用方引用保持有效）。
 *
 * @param {Array<object>} messages   会话历史数组（this._messages）
 * @param {object} opts
 * @param {string} [opts.reply]          本轮最终回复文本
 * @param {any}    [opts.finalResult]    toolUseLoop 的 finalResult（用于判错）
 * @param {number} [opts.maxHistory]     历史上限（成功轮截断用）
 * @param {number} [opts.historyMark]    本轮开始前的历史长度快照（失败轮回滚目标）
 * @returns {{ persisted: boolean, rolledBack: boolean }}
 */
function commitTurn(messages, opts = {}) {
  if (!Array.isArray(messages)) return { persisted: false, rolledBack: false };
  const { reply, finalResult, maxHistory, historyMark } = opts;

  if (isErrorTurn(finalResult)) {
    // 失败轮：回滚到本轮开始前的快照（撤回本轮 user 消息，不落 assistant 兜底文案）。
    // 边界防呆：mark 必须是落在当前长度内的合法下标，否则保守地「至少不落兜底文案」。
    if (Number.isInteger(historyMark) && historyMark >= 0 && historyMark <= messages.length) {
      messages.length = historyMark;
      return { persisted: false, rolledBack: true };
    }
    return { persisted: false, rolledBack: false };
  }

  const text = String(reply || '');
  if (!text) return { persisted: false, rolledBack: false };

  messages.push({ role: 'assistant', content: text });
  if (Number.isInteger(maxHistory) && maxHistory > 0 && messages.length > maxHistory) {
    const trimmed = messages.slice(-maxHistory);
    messages.length = 0;
    for (const m of trimmed) messages.push(m);
  }
  return { persisted: true, rolledBack: false };
}

module.exports = { isErrorTurn, commitTurn };
