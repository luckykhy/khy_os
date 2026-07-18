'use strict';

/**
 * debugToolCall.js — `/debug-tool-call` 薄壳:读当前会话 transcript,委托纯叶子
 * `cli/debugToolCall.js` 配对最近 N 个 tool_use↔tool_result 并渲染。对齐 Claude Code
 * `/debug-tool-call`。
 *
 * **背后逻辑**(配对/截断/渲染)全在叶子;本壳只做四件事:门控、解析当前 sessionId
 * (既有 `sessionForestService.getCurrentSessionId`,不另写)、读 chain(既有
 * `sessionPersistence.buildConversationChain`,不另写)、打印。
 *
 * 用法:`/debug-tool-call [N]`(N=展示最近几个,默认 5)。
 * 门控 KHY_DEBUG_TOOL_CALL 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo, printError } = require('../formatters');
const leaf = require('../debugToolCall');

async function handleDebugToolCall(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('debug-tool-call 命令未启用(KHY_DEBUG_TOOL_CALL=off)。');
    return false;
  }

  // limit:子命令或 args 里第一个正整数;缺省 5。
  let limit = 5;
  const tokens = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  for (const t of tokens) {
    const n = parseInt(t, 10);
    if (Number.isInteger(n) && n > 0) { limit = n; break; }
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /debug-tool-call 查看最近的工具调用。');
    return true;
  }

  let chain = [];
  try {
    chain = require('../../services/sessionPersistence').buildConversationChain(sessionId);
  } catch (e) {
    printError('读取会话 transcript 失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  const pairs = leaf.extractToolCalls(chain, { limit });
  console.log(leaf.formatToolCallDebug(pairs, {}));
  return true;
}

module.exports = { handleDebugToolCall };
