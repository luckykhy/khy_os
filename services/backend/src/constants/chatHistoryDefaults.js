'use strict';

/**
 * chatHistoryDefaults.js — 「会话消息历史上限」的单一真源(纯常量叶)。
 *
 * 契约 (CONTRACT): 零依赖、零 IO、确定性、绝不抛、无副作用;env 经入参注入。
 *
 * 为什么存在:复杂任务(多轮工具循环)会把大量消息塞进 _chatState.messages,
 * 旧值 80 条会让早期任务上下文被静默 slice 掉 —— 模型"失忆"后无法推进。
 * 本模块把默认上限提到 160 并允许 KHY_MAX_HISTORY 覆盖,三处消费方
 * (ai.js 注入 aiChatCore / aiConversationOps / aiSession)共用同一个数,
 * 避免历史上 80 散落三处、一处改不动其余的问题(见 AGENTS.md「零硬编码」)。
 */

/** 默认会话消息历史上限(条数)。复杂任务保留更多早期上下文。 */
const MAX_HISTORY_DEFAULT = 160;

/** 历史上限的硬地板,防止被配成 0 或负数导致消息永不被裁剪。 */
const MAX_HISTORY_FLOOR = 20;

/** 安全转正整数;非有限/非正 → 0。 */
function _posInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
}

/**
 * 从注入 env 解析消息历史上限(KHY_MAX_HISTORY),未设/非法 → 默认。
 * @param {Record<string,string>} [env] 注入环境(默认空对象,绝不读 process.env)
 * @returns {number} 上限条数(>= MAX_HISTORY_FLOOR)
 */
function resolveMaxHistory(env = {}) {
  const n = _posInt(env && env.KHY_MAX_HISTORY);
  return n > 0 ? n : MAX_HISTORY_DEFAULT;
}

module.exports = {
  MAX_HISTORY_DEFAULT,
  MAX_HISTORY_FLOOR,
  resolveMaxHistory,
};
