const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class NewsSearchTool extends BaseTool {
  static toolName = 'NewsSearch';
  static category = 'data';
  static risk = 'low';
  static aliases = ['news_search', 'search_news', 'news'];
  static searchHint = 'news search current events headlines';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Search for news articles and current events.

Returns structured news results with titles, snippets, sources, and publication dates.
Use for time-sensitive queries about latest events, news, and current affairs.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Example: "AI news 2026", "latest technology headlines"',
          minLength: 2,
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'auto'],
          description: 'Time filter for recency. "auto" infers from query. Required for time-sensitive queries.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10, max: 30).',
          minimum: 1,
          maximum: 30,
        },
        language: {
          type: 'string',
          description: 'Language filter (e.g., "zh", "en"). Default: "auto"',
        },
      },
      required: ['query'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_NEWS_SEARCH_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const newsService = require('../../services/finlightNewsService');

      const result = await withDeadline(
        () => newsService.search(params.query, {
          freshness: params.freshness || 'auto',
          limit: params.limit || 10,
          language: params.language || 'auto',
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `News search timeout after ${timeoutMs}ms` };
      }

      return {
        success: true,
        results: result?.articles || result?.results || [],
        count: result?.articles?.length || result?.results?.length || 0,
      };
    } catch (err) {
      return { success: false, error: `News search error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `新闻搜索：${input.query || ''}`;
  }
}

module.exports = NewsSearchTool;
