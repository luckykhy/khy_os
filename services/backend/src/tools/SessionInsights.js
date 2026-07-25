'use strict';

/**
 * SessionInsights — 让模型按需生成「会话洞见」报告(对齐 Claude Code 的 /insights)。
 *
 * 回顾一段会话:多少轮、最常用哪些工具、聊了什么话题、耗时多久。只读,绝不修改会话。
 * 统计与排版的全部逻辑在纯叶子 sessionInsights;本工具只负责载入 transcript 再委派。
 */

const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'SessionInsights',
  description:
    'Generate an insights report for a conversation session (Claude Code-aligned /insights): '
    + 'turn count, most-used tools, topic keywords, duration. Read-only. '
    + 'Defaults to the current session; pass sessionId to inspect a specific one.',
  category: 'analysis',
  risk: 'low',
  aliases: ['insights', 'sessionInsights'],
  isReadOnly: () => true,
  isConcurrencySafe: true,
  inputSchema: {
    sessionId: {
      type: 'string',
      required: false,
      description: 'Session id to analyze. Omit to use the current session (or the most recent one).',
    },
  },
  async execute(params, context) {
    const leaf = require('../services/sessionInsights');
    if (!leaf.isEnabled()) {
      return { success: false, error: 'Session insights are disabled (KHY_INSIGHTS=off).' };
    }
    let persistence;
    try {
      persistence = require('../services/sessionPersistence');
    } catch (e) {
      return { success: false, error: 'session persistence unavailable: ' + ((e && e.message) || e) };
    }

    try {
      // 解析目标 sessionId:显式参数 > 当前会话(traceContext)> 最近一条持久化会话。
      let sessionId = (params && params.sessionId) || (context && context.traceContext && context.traceContext.sessionId) || '';
      if (!sessionId) {
        const recent = persistence.listPersistedSessions({ limit: 1 });
        if (recent && recent.length) sessionId = recent[0].sessionId;
      }
      if (!sessionId) {
        return { success: true, data: { report: '会话洞见:暂无已持久化的会话可分析。', insights: null } };
      }

      const session = persistence.restoreSession(sessionId);
      if (!session) {
        return { success: false, error: `session not found: ${sessionId}` };
      }

      const insights = leaf.computeInsights(session);
      const report = leaf.buildInsightsReport(insights);
      return {
        success: true,
        data: {
          sessionId,
          report,
          insights: {
            turns: insights.turns,
            messageCount: insights.messageCount,
            durationMs: insights.durationMs,
            tools: insights.tools,
            keywords: insights.keywords,
            toolCallTotal: insights.toolCallTotal,
          },
        },
      };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
