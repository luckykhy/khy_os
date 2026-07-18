/**
 * WebSearchTool — web search tool, aligned with Claude Code's WebSearch tool.
 *
 * Searches the web for up-to-date information via webSearchService: a keyless
 * multi-engine fan-out (Baidu / Bing 中国 / DuckDuckGo / Mojeek / Sogou / 360)
 * with RRF consensus fusion, falling back to Kiro MCP when the scrapers come up
 * empty. No SerpAPI or other paid key is required.
 */
const { BaseTool } = require('../_baseTool');

class WebSearchTool extends BaseTool {
  static toolName = 'WebSearch';
  static category = 'data';
  static risk = 'low';
  static aliases = ['webSearch', 'web_search', 'search_web'];
  static searchHint = 'search the web for information news documentation';
  static shouldDefer = false;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.toLocaleString('en', { month: 'long' });
    return `Search the web and use the results to inform responses.

Common workflow: First search with WebSearch to find relevant pages, then use WebFetch to read the full content of the most promising results. Do not stop at search snippets when the user needs a detailed answer — fetch the page.

- Provides up-to-date information for current events and recent data
- Returns structured results with titles, snippets, URLs, domain classification, and source type
- Results include domain type tags (Docs, Forum, Code, Blog, News, Reference) for quick triage
- Use this tool for accessing information beyond the knowledge cutoff

Usage notes:
- When search snippets are insufficient to answer the question, use WebFetch on the most relevant URLs
- After answering, include a "Sources:" section listing relevant URLs as markdown hyperlinks
- Domain filtering is supported to include or block specific websites

IMPORTANT — Use the correct year in search queries:
- The current month is ${month} ${year}. Use this year when searching for recent information.

IMPORTANT — Freshness / time filter (REQUIRED for time-sensitive queries):
- Pass \`freshness\` to restrict results by recency and sort newest-first:
  day = past 24h, week = past 7 days, month = past 30 days, year = past 12 months.
- For ANY query about latest/recent/today/this week/news/current prices (最新/最近/今天/本周/新闻/实时),
  you MUST set \`freshness\`. Do NOT run an unbounded search for a time-sensitive question — it returns stale hits.
- Use "auto" to let the engine infer the window from the query; omit only for timeless/reference lookups.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to use',
          minLength: 2,
        },
        allowed_domains: {
          type: 'array',
          description: 'Only include search results from these domains',
          items: { type: 'string' },
        },
        blocked_domains: {
          type: 'array',
          description: 'Never include search results from these domains',
          items: { type: 'string' },
        },
        freshness: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'auto', 'none'],
          description: 'Time filter for recency. day=24h, week=7d, month=30d, year=12mo. REQUIRED for time-sensitive queries (latest/recent/today/news/最新/最近/今天/新闻). "auto" infers the window from the query; omit or "none" for timeless lookups.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional hard timeout in milliseconds for the search (default 30000, range 1000–120000). Set a lower value when you do not want to wait on a slow search backend.',
        },
      },
      required: ['query'],
    };
  }

  getActivityDescription(input) {
    return `搜索网页：${(input.query || '').slice(0, 40)}`;
  }

  async execute(params, _context) {
    const { query, allowed_domains, blocked_domains, freshness } = params;
    const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');
    // 模型可设硬超时(默认 30s,clamp[1000,120000]);门控关 → 逐字节回退 30s。
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params && params.timeoutMs,
      envKey: 'KHY_WEBSEARCH_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 120000,
    });

    try {
      const webSearchService = require('../../services/webSearchService');
      // 墙钟兜底:webSearchService.search 本身无超时,到点返结构化超时而非无限等待。
      const result = await withDeadline(
        () => webSearchService.search(query, { freshness }),
        timeoutMs
      );
      if (result && result.__timedOut) {
        return { success: false, error: `Web search 超时:已达 ${result.timeoutMs}ms 硬上限` };
      }
      if (result && result.__error) {
        return { success: false, error: `Web search failed: ${result.__error.message || result.__error}` };
      }

      if (!result || !result.success) {
        return {
          success: false,
          error: result?.error || 'Web search returned no results',
        };
      }

      // Apply domain filtering if requested
      let results = result.results || [];

      if (allowed_domains && allowed_domains.length > 0) {
        results = results.filter(r => {
          try {
            const url = new URL(r.url || r.link || '');
            return allowed_domains.some(d => url.hostname.includes(d));
          } catch { return false; }
        });
      }

      if (blocked_domains && blocked_domains.length > 0) {
        results = results.filter(r => {
          try {
            const url = new URL(r.url || r.link || '');
            return !blocked_domains.some(d => url.hostname.includes(d));
          } catch { return true; }
        });
      }

      // Use 'content' field so _extractToolOutput picks formatted text (Priority 1)
      // instead of raw 'results' array (Priority 2)
      const formatted = result.formatted || results.map((r, i) =>
        `### ${i + 1}. ${r.title || 'Untitled'}${r.type ? ' [' + r.type + ']' : ''}\nURL: ${r.url || r.link || ''}\n${r.snippet || r.description || ''}`
      ).join('\n\n');

      return {
        success: true,
        query,
        content: formatted || `搜索"${query}"无结果`,
        results,
        count: results.length,
      };
    } catch (err) {
      return { success: false, error: `Web search failed: ${err.message}` };
    }
  }
}

module.exports = new WebSearchTool();
module.exports.WebSearchTool = WebSearchTool;
