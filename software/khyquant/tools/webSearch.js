const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'webSearch',
  description: 'Search the web for information using a query string',
  category: 'data',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  // Chapter 5 additions
  aliases: ['web_search', 'search_web'],
  shouldDefer: true,
  searchHint: 'search the web for information, news, documentation',

  async prompt() {
    return `Search the web for information using a query string.
Returns search results with titles, snippets, URLs, and a Published date when available.

Use this whenever a fact may have changed since your training cutoff — dates,
prices, schedules, release/announcement times, "latest" anything. For such
time-sensitive facts, TRUST the fetched results (especially their Published dates
and the authoritative/official source) OVER your prior knowledge; do not answer
from memory when the search disagrees with it.

Result count is on-demand: pass \`count\` to request more or fewer than the
default (8). Use a larger count (e.g. 15-20) for broad surveys or when the
authoritative source may not be in the top few hits; a smaller one for a quick
single-fact lookup.

FRESHNESS / time filter — REQUIRED for time-sensitive queries. Pass \`freshness\`
to restrict results by recency and sort newest-first:
  - "day"   → past 24 hours (今天/实时/breaking news, prices, scores)
  - "week"  → past 7 days   (本周/近期 updates)
  - "month" → past 30 days  (本月/recent developments)
  - "year"  → past 12 months
For any query about "最新/最近/今天/本周/本月/新闻/实时/current/latest/recent",
you MUST pass an appropriate \`freshness\` — do NOT run an unbounded search for a
time-sensitive question, or you will get stale results. When unsure of the
window, pass "auto" and the engine infers it from the query. Omit \`freshness\`
only for timeless/reference lookups.`;
  },

  inputSchema: {
    query: { type: 'string', required: true, description: 'Search query' },
    count: {
      type: 'number',
      required: false,
      description: 'How many results to return (default 8, max 30). Request more for broad/time-sensitive queries, fewer for a quick lookup.',
    },
    freshness: {
      type: 'string',
      required: false,
      enum: ['day', 'week', 'month', 'year', 'auto', 'none'],
      description: 'Time filter for recency. day=24h, week=7d, month=30d, year=12mo. REQUIRED for time-sensitive queries (最新/最近/今天/新闻/latest/recent). "auto" infers the window from the query; omit or "none" for timeless lookups.',
    },
  },
  async execute(params, context) {
    const toolErrorCodes = require('../services/toolErrorCodes');
    try {
      const webSearchService = require('../services/webSearchService');
      const result = await webSearchService.search(params.query, { count: params.count, freshness: params.freshness });
      // 如实传播内层失败（含自愈所需的 depId），而非一律包成 success:true ——
      // 否则 executeTool 的依赖自愈漏斗看到的是「假成功」，永远不会接管缺失依赖。
      // 再经 toolErrorCodes 叠语义分类:有 depId → MISSING_DEPENDENCY,否则 UNKNOWN
      // (零假阳性,不臆测网络/服务原因),供调用方分支(P2#5)。
      if (result && result.success === false) {
        return toolErrorCodes.enrich({ success: false, error: result.error || 'web search failed', depId: result.depId, data: result });
      }
      return { success: true, data: result };
    } catch (err) {
      return toolErrorCodes.enrich({ success: false, error: err.message });
    }
  },
});
