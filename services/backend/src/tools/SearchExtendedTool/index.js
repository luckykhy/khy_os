const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class SearchExtendedTool extends BaseTool {
  static toolName = 'SearchExtended';
  static category = 'data';
  static risk = 'low';
  static aliases = ['search_extended', 'web_search_extended'];
  static searchHint = 'web search serper tavily you';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Search the web using multiple providers.

Supported providers:
- "serper" — Serper (Google search)
- "tavily" — Tavily
- "you" — You.com

Returns structured search results with titles, snippets, and URLs.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        provider: {
          type: 'string',
          enum: ['serper', 'tavily', 'you', 'auto'],
          description: 'Search provider (default: auto)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          minimum: 1,
          maximum: 30,
        },
      },
      required: ['query'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_SEARCH_EXTENDED_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const search = require('../../services/searchProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of search.listProviders()) {
          if (search.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No search provider configured. Set KHY_SEARCH_SERPER_API_KEY, KHY_SEARCH_TAVILY_API_KEY, or KHY_SEARCH_YOU_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => search.search(provider, params.query, { limit: params.limit }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `Search timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Search error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `搜索：${input.query?.slice(0, 40) || ''}`;
  }
}

module.exports = SearchExtendedTool;
