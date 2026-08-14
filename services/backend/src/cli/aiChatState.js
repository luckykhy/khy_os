'use strict';

/**
 * Shared chat session state (god-file split, Option C).
 *
 * The 12 module-level mutable bindings that ai.js (host) and aiChatCore.js both read AND reassign
 * are collected here as a single required-once singleton object. Because require() returns the cached
 * object, property reads/writes propagate across both modules — this is what lets the chat mega-construct
 * move into aiChatCore.js while the surrounding stateless helpers stay in ai.js. Initial values mirror the
 * original `let` declarations verbatim. NOT byte-identical (each `_messages` becomes `_chatState.messages`).
 */
module.exports = {
  gateway: null,
  messages: [],
  studyMode: false,
  gatewayPreflightDone: false,
  gatewayPreflightInFlight: null,
  pendingTaskGuard: null,
  lastSubstantivePrompt: '',
  lastSubstantiveAt: 0,
  // 上一轮工具循环的执行计划快照(仅当本会话拆解过任务)。「继续」时据此恢复
  // 步骤状态(已完成/失败/下一步),让断网/token 失效/中途中断后能回到任务主线。
  lastExecutionPlan: null,
  primedSessionId: null,
  lastPrimeTopicTokens: null,
  currentEffort: 'medium',
  thinkingEnabled: true,
  _scopeSwitching: false, // guard flag: true while scopeSession is switching messages
  _scopeSwitchStart: 0, // timestamp when _scopeSwitching was set to true
};
