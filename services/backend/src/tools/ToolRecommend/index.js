'use strict';

/**
 * ToolRecommend — proactively recommend tools based on user intent.
 *
 * When the user asks a question or gives a task, this tool returns the most
 * relevant tools they could use. The model can then call ToolSearch to reveal
 * deferred tools, or directly call the recommended tools if already available.
 *
 * This reduces the "tool discovery cost" — instead of the model having to know
 * all 100+ tools upfront, it gets a shortlist of the most relevant ones.
 *
 * @module tools/ToolRecommend
 */

const { BaseTool } = require('../_baseTool');
const { scoreTool } = require('../toolRecommend');

let _mapService = null;
function _getMapService() {
  if (!_mapService) {
    _mapService = require('../../services/projectAnalysis/projectMapService');
  }
  return _mapService;
}

class ToolRecommendTool extends BaseTool {
  static toolName = 'ToolRecommend';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['tool_recommend', 'recommend_tools', 'find_tools'];
  static searchHint = 'recommend tools find relevant tools for task discover what tools can do';
  static alwaysLoad = false;

  isReadOnly() {
    return true;
  }
  isDestructive() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return [
      '- Recommends the most relevant tools for a given task or query.',
      '- Use this when you are unsure which tools are available for a specific task.',
      '- Returns a shortlist of tools with name, category, and a brief description.',
      '- After getting recommendations, call ToolSearch with "select:ToolName" to reveal deferred tools.',
      '- For finding files by pattern, use Glob. For searching content, use Grep.',
    ].join('\n');
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A short description of the task or user query. Example: "edit a file", "search for code", "analyze project structure"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tools to recommend (default: 5, max: 10). Example: 3',
        },
      },
      required: ['query'],
    };
  }

  getActivityDescription(input) {
    return `推荐工具：${input.query}`;
  }

  async execute(params, _context) {
    try {
      const query = (params.query || '').trim();
      if (!query) {
        return { success: false, error: 'Query is required' };
      }

      const limit = Math.min(10, Math.max(1, parseInt(params.limit, 10) || 5));

      // Get all tools from registry
      const toolRegistry = require('../index');
      const allTools = toolRegistry.getAll();

      // Score all tools against the query
      const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const scored = [];

      for (const [name, tool] of allTools) {
        if (name === 'ToolRecommend' || name === 'toolSearch') continue;
        const score = scoreTool(tool, queryTerms);
        if (score > 0) {
          scored.push({ name, score, tool });
        }
      }

      // Sort by score and take top N
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit);

      const recommendations = top.map(({ name, score, tool }) => ({
        name,
        score,
        category: tool.category || 'custom',
        risk: tool.risk || 'medium',
        description: tool.description || '',
        isDeferred: tool.shouldDefer && !tool.alwaysLoad,
        isAvailable: !tool.shouldDefer || tool.alwaysLoad,
      }));

      return {
        success: true,
        query,
        recommendations,
        count: recommendations.length,
        totalAvailable: allTools.size,
        hint: recommendations.some(r => r.isDeferred)
          ? 'Some recommended tools are deferred. Call ToolSearch with "select:ToolName" to reveal them.'
          : undefined,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = new ToolRecommendTool();
module.exports.ToolRecommendTool = ToolRecommendTool;
