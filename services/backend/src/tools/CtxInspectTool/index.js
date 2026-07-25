'use strict';

const { BaseTool } = require('../_baseTool');

/**
 * CtxInspectTool —— 上下文窗口检视(只读)。对齐 Claude Code 的 CtxInspectTool。
 *
 * 让模型/用户一眼看清「当前上下文用了多少、还剩多少、是否接近上限」:
 *   · 已用 token / 上限(来自 aiGateway 适配器真值,缺失回退 KHY_CONTEXT_WINDOW);
 *   · 占用百分比 + 剩余 token + 健康分级(healthy/warning/critical);
 *   · 会话累计输入/输出 token、请求数、最近模型、会话花费。
 * 可选 `text` 参数:估算任意文本的 token 数(走 token 估算 SSOT,不进上下文)。
 *
 * 背后的逻辑(占用率/余量/分级计算)收敛在纯叶子 services/context/ctxWindowStats.js;
 * 本壳只负责读 HUD 会话态单例(cli/hudRenderer.getState())并喂叶子。**绝不**硬编码
 * 任何 model→上限表。只读、并发安全、不写盘。
 *
 * 门控 KHY_CTX_INSPECT 默认开;关 → 工具返回 disabled 提示(等价工具缺席,字节回退)。
 */
class CtxInspectTool extends BaseTool {
  static toolName = 'CtxInspect';
  static category = 'analysis';
  static risk = 'safe';
  static aliases = ['ctx_inspect', 'context_inspect', 'context_window'];
  static searchHint = '上下文 窗口 token 占用 剩余 余量 context window usage 还剩多少 多少 token 接近上限 健康';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return [
      '上下文窗口检视(只读)。返回当前上下文已用/上限 token、占用百分比、剩余 token、',
      '健康分级(healthy/warning/critical)、会话累计输入/输出 token、请求数、最近模型与花费。',
      '可选 text:估算给定文本的 token 数(不写入上下文)。上限取适配器真值,缺失回退 KHY_CONTEXT_WINDOW。',
      '只读,不改任何状态。',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        breakdown: {
          type: 'boolean',
          description: '可选:为 true 时返回 per-category 上下文分解(System tools 等真实数据源的估算 token + CC 风格 10×10 网格图例行)。对齐 CC /context 的分类可视化。',
        },
        text: {
          type: 'string',
          description: '可选:估算这段文本的 token 数(走 token 估算 SSOT,仅返回数值,不进上下文)。',
        },
      },
      required: [],
    };
  }

  _enabled(env) {
    const FALSY = new Set(['0', 'false', 'off', 'no']);
    const raw = env && env.KHY_CTX_INSPECT;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !FALSY.has(v);
  }

  async execute(params = {}) {
    if (!this._enabled(process.env)) {
      return { success: false, disabled: true, message: 'CtxInspect 已关闭(KHY_CTX_INSPECT=off)。' };
    }

    const { computeContextStats } = require('../../services/context/ctxWindowStats');

    // 读 HUD 会话态单例(只读快照);拿不到则退化为空态(诚实标注)。
    let hud = null;
    try {
      const hudRenderer = require('../../cli/hudRenderer');
      if (hudRenderer && typeof hudRenderer.getState === 'function') hud = hudRenderer.getState();
    } catch { /* HUD 未就绪 */ }

    const cw = (hud && hud.contextWindow) || { used: 0, limit: 0 };
    const st = (hud && hud.sessionTokens) || { input: 0, output: 0, total: 0 };

    const stats = computeContextStats(
      {
        used: cw.used,
        limit: cw.limit,
        sessionInput: st.input,
        sessionOutput: st.output,
        requestCount: hud ? hud.requestCount : 0,
        model: hud ? hud.lastModel : '',
      },
      process.env,
    );

    const result = {
      success: true,
      ...stats,
      sessionCostUSD: hud && hud.sessionCostUSD ? hud.sessionCostUSD : 0,
      hudAvailable: !!hud,
    };

    // 可选:估算给定文本 token 数(走 SSOT 估算器)。
    if (params && typeof params.text === 'string' && params.text.length > 0) {
      try {
        const { estimateTokens } = require('../../services/textHeuristics');
        result.query = { textLength: params.text.length, estimatedTokens: estimateTokens(params.text) };
      } catch { /* 估算器不可用则略过 */ }
    }

    // 可选:per-category 上下文分解(对齐 CC /context 分类网格)。收集**真实可得**的
    // 数据源(System tools = 工具定义 JSON 的估算,即 API 实发的工具 schema 开销),按
    // token 估算 SSOT 分解;拿不到的类别省略(honest-NA,不臆造)。走纯叶子后端逻辑。
    if (params && params.breakdown === true) {
      try {
        const { analyzeContextBreakdown, renderContextBreakdownLines } = require('../../services/context/contextBreakdown');
        const { estimateTokens } = require('../../services/textHeuristics');
        const sections = [];
        try {
          const { getToolDefinitions } = require('../../services/toolCalling');
          const defs = getToolDefinitions();
          if (Array.isArray(defs) && defs.length > 0) {
            // 工具定义 JSON = 上下文里 System tools 类别的真实开销(发给模型的 schema)。
            sections.push({ name: 'System tools', text: JSON.stringify(defs) });
          }
        } catch { /* 注册表不可用则该类别省略 */ }

        const _win = Number.isFinite(Number(stats.limit)) && Number(stats.limit) > 0 ? Math.floor(Number(stats.limit)) : 0;
        const b = analyzeContextBreakdown(
          { contextWindow: _win, sections, estimateTokens },
          process.env,
        );
        if (b) {
          result.breakdown = {
            categories: b.categories.map((c) => ({
              name: c.name,
              tokens: c.tokens,
              isDeferred: !!c.isDeferred,
            })),
            totalTokens: b.totalTokens,
            contextWindow: b.contextWindow,
            percentage: b.percentage,
            lines: renderContextBreakdownLines(b, { model: stats.model, width: 10, height: 10 }, process.env),
          };

          // 配套:基于同一分解结果生成可操作优化建议(near-capacity → /compact、
          // Memory 膨胀等)。用真实可得信号 percentage + categories 驱动;并尝试从
          // 活动会话消息计算 per-tool-call 分解(真实数据),激活大工具结果 / Read
          // 膨胀检查;取不到消息则该部分自动跳过(honest-NA)。
          try {
            const { analyzeContextSuggestions, renderContextSuggestionLines } = require('../../services/context/contextSuggestions');

            // 真实 per-tool-call 分解(数据源:ai.js 活动 _messages 快照)。
            let toolCallsByType = null;
            try {
              const { analyzeMessageBreakdown } = require('../../services/context/messageBreakdown');
              const { getConversation } = require('../../cli/ai');
              if (typeof getConversation === 'function') {
                const mb = analyzeMessageBreakdown(
                  { messages: getConversation(), estimateTokens },
                  process.env,
                );
                if (mb && Array.isArray(mb.toolCallsByType) && mb.toolCallsByType.length > 0) {
                  toolCallsByType = mb.toolCallsByType;
                }
              }
            } catch { /* 消息不可得 → honest-NA */ }

            const suggestions = analyzeContextSuggestions(
              { percentage: b.percentage, contextWindow: b.contextWindow, categories: b.categories, toolCallsByType },
              process.env,
            );
            if (suggestions.length > 0) {
              result.breakdown.suggestions = suggestions;
              result.breakdown.suggestionLines = renderContextSuggestionLines(suggestions, {}, process.env);
            }
          } catch { /* 建议 best-effort */ }
        }
      } catch { /* 分解 best-effort:失败不影响主结果 */ }
    }

    return result;
  }

  getActivityDescription() {
    return '上下文窗口检视(只读)';
  }
}

module.exports = CtxInspectTool;
