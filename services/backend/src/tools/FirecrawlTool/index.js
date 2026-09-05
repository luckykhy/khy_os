const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class FirecrawlTool extends BaseTool {
  static toolName = 'Firecrawl';
  static category = 'mcp';
  static risk = 'medium';
  static aliases = ['firecrawl_search', 'firecrawl_scrape'];
  static searchHint = 'firecrawl web search scrape url content';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Web search and page scraping via Firecrawl.

Two actions:
- "search": General web search. Returns titles, snippets, URLs. Use for finding information.
- "scrape_url": Fetch and extract content from a specific URL. Returns full page content as markdown.

Timeout: 60 seconds per call.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'scrape_url'],
          description: 'Action to perform. "search" for web search, "scrape_url" for fetching a specific page.',
        },
        query: {
          type: 'string',
          description: 'Search query (for search action). Example: "latest AI news 2026"',
        },
        url: {
          type: 'string',
          description: 'URL to scrape (for scrape_url action). Example: "https://example.com"',
        },
        limit: {
          type: 'number',
          description: 'Maximum search results (default: 5, max: 20).',
          minimum: 1,
          maximum: 20,
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000, max: 120000).',
          minimum: 1000,
          maximum: 120000,
        },
      },
      required: ['action'],
    };
  }

  async execute(params) {
    const { action } = params;
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_FIRECRAWL_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const firecrawl = require('../../services/mcp/firecrawl');

      if (action === 'search') {
        if (!params.query) {
          return { success: false, error: 'query is required for search action' };
        }
        const result = await withDeadline(
          () => firecrawl.search(params.query, { limit: params.limit || 5 }),
          timeoutMs
        );
        if (result?.__timedOut) {
          return { success: false, error: `Firecrawl search timeout after ${timeoutMs}ms` };
        }
        return { success: true, results: result?.results || [], count: result?.results?.length || 0 };
      }

      if (action === 'scrape_url') {
        if (!params.url) {
          return { success: false, error: 'url is required for scrape_url action' };
        }
        const result = await withDeadline(
          () => firecrawl.scrapeUrl(params.url),
          timeoutMs
        );
        if (result?.__timedOut) {
          return { success: false, error: `Firecrawl scrape timeout after ${timeoutMs}ms` };
        }
        return { success: true, content: result?.content || '', url: params.url };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (err) {
      return { success: false, error: `Firecrawl error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `Firecrawl ${input.action}: ${input.query || input.url || ''}`;
  }
}

module.exports = FirecrawlTool;
