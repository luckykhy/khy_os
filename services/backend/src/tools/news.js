/**
 * news — dedicated news-query tool for the CLI agent.
 *
 * Strategy (see plan crystalline-imagining-liskov.md):
 *   - Backbone: general web search constrained/ranked toward news sources via
 *     `webSearchService.search` (= searchUnified). Always available; covers
 *     general queries like "latest tech news".
 *   - Optional enrichment: when FINLIGHT_API_KEY is configured AND the query is
 *     financial (explicit `financial:true` or a lightweight keyword heuristic),
 *     fetch real financial news with sentiment analysis from Finlight.me and
 *     merge it ahead of web results.
 *
 * Zero-hardcoding rule: the Finlight API key is read ONLY from
 * process.env.FINLIGHT_API_KEY. When absent, Finlight is silently skipped and
 * `meta.note` transparently states how to enable it — no default key, no throw.
 *
 * State transparency: every result carries `meta` describing which providers
 * ran and whether Finlight was available, so callers and the LLM can see the
 * path taken.
 */

const { defineTool } = require('./_baseTool');

// Lightweight financial-intent heuristic. Used ONLY to decide whether to attempt
// the optional Finlight enrichment — it never affects the web-search backbone,
// so a miss simply means "web-only", never a wrong answer.
const FINANCIAL_HINT = /\b(stock|stocks|share[s]?|equit|nasdaq|nyse|dow|s&p|index|etf|forex|crypto|bitcoin|earnings|ipo|dividend|bond|yield|ticker|market cap)\b|股票|股市|大盘|涨停|跌停|财报|证券|基金|期货|外汇|加密货币|比特币|纳斯达克|道琼斯|上证|深证|创业板|港股|美股|A股/i;

/**
 * Hostnames that are strong news sources but are NOT in webSearchService's tiny
 * _DOMAIN_TYPE_MAP. Used purely to BOOST ranking — results are never dropped,
 * so this list affects ordering only, not correctness or completeness.
 */
const NEWS_HOST_HINT = /(^|\.)(news|cnn|bbc|reuters|nytimes|wsj|bloomberg|theverge|techcrunch|engadget|arstechnica|wired|guardian|apnews|aljazeera|xinhua|chinadaily|sina|163|sohu|ifeng|thepaper|36kr|cnbeta|ithome|gizmodo|zdnet|venturebeat)\b/i;

/**
 * Determine whether a web result looks like news (for soft ranking, not filtering).
 * @param {{type?: string, domain?: string, url?: string}} r
 * @returns {boolean}
 */
function _looksLikeNews(r) {
  if (r && r.type === 'news') return true;
  const host = String((r && (r.domain || r.url)) || '');
  return NEWS_HOST_HINT.test(host);
}

/**
 * Normalize a webSearchService result item into the shared article shape used
 * by both web and Finlight paths (aligned with finlightNewsService output so
 * summarizeForPrompt works on either).
 */
function _webResultToArticle(r) {
  return {
    title: (r && r.title) || '',
    content: (r && r.snippet) || '',
    source: (r && r.domain) || '',
    url: (r && r.url) || '',
    publishedAt: (r && r.publishedDate) || '',
    sentiment: null,
    sentimentScore: null,
  };
}

/** Stable de-dup key for merging Finlight + web articles. */
function _articleKey(a) {
  const url = String((a && a.url) || '').trim().toLowerCase();
  if (url) return `u:${url}`;
  return `t:${String((a && a.title) || '').trim().toLowerCase()}`;
}

module.exports = defineTool({
  name: 'news',
  description:
    'Query recent news for a topic. Searches news-oriented web sources and, when a financial '
    + 'query is detected and FINLIGHT_API_KEY is configured, enriches results with real '
    + 'financial news and sentiment from Finlight.me. Returns normalized articles plus a '
    + 'compact summary suitable for grounding an answer.',
  category: 'data',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'news',
  aliases: ['get_news', 'news_query', 'search_news', '查新闻', '新闻查询'],
  inputSchema: {
    query: {
      type: 'string',
      required: true,
      maxLength: 200,
      description: 'News search keywords, e.g. "latest tech news" or a company/topic.',
    },
    limit: {
      type: 'number',
      min: 1,
      max: 30,
      default: 10,
      description: 'Maximum number of articles to return (1-30, default 10).',
    },
    financial: {
      type: 'boolean',
      default: false,
      description: 'Set true to force financial-news enrichment via Finlight (requires FINLIGHT_API_KEY).',
    },
  },

  getActivityDescription(input) {
    const q = input && input.query ? String(input.query) : '';
    return `查询新闻: "${q}"`;
  },

  async execute(params, _context) {
    const query = String((params && params.query) || '').trim();
    const rawLimit = Number(params && params.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(30, Math.max(1, Math.floor(rawLimit))) : 10;
    const explicitFinancial = !!(params && params.financial);

    const webSearchService = require('../services/webSearchService');
    const finlightNewsService = require('../services/finlightNewsService');

    // ── Transparency scaffold (always populated) ──────────────────────
    const apiKey = process.env.FINLIGHT_API_KEY || '';
    const providers = [];
    const meta = {
      providers,
      finlightAvailable: !!apiKey,
      note: apiKey ? undefined : '设置 FINLIGHT_API_KEY 可启用金融新闻情绪增强',
    };

    // ── 1. Web backbone ───────────────────────────────────────────────
    let webArticles = [];
    let webError = '';
    let webDepId = ''; // 透传 searchUnified 标的缺失依赖，供 executeTool 自愈漏斗接管
    try {
      const web = await webSearchService.search(query);
      if (web && web.success && Array.isArray(web.results) && web.results.length > 0) {
        providers.push('web');
        // Soft ranking: news-like results first, original order otherwise. Stable
        // sort keeps relevance order within each group; nothing is discarded.
        const ranked = web.results
          .map((r, i) => ({ r, i, news: _looksLikeNews(r) }))
          .sort((a, b) => (Number(b.news) - Number(a.news)) || (a.i - b.i))
          .map((x) => x.r);
        webArticles = ranked.map(_webResultToArticle);
      } else if (web && web.error) {
        webError = web.error;
        webDepId = web.depId || '';
      }
    } catch (err) {
      webError = err && err.message ? err.message : String(err);
    }

    // ── 2. Optional Finlight enrichment (financial only) ──────────────
    let finlightArticles = [];
    const wantFinancial = explicitFinancial || FINANCIAL_HINT.test(query);
    if (apiKey && wantFinancial) {
      try {
        const fetched = await finlightNewsService.fetchNews(query, apiKey, { limit });
        if (Array.isArray(fetched) && fetched.length > 0) {
          providers.push('finlight');
          finlightArticles = fetched;
        }
      } catch {
        // Non-critical: enrichment failure must never break the web backbone.
      }
    }

    // ── 3. Merge (Finlight first), de-dup, clamp to limit ─────────────
    const merged = [];
    const seen = new Set();
    for (const a of [...finlightArticles, ...webArticles]) {
      const key = _articleKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(a);
      if (merged.length >= limit) break;
    }

    // ── 4. Failure path: nothing from any provider ────────────────────
    if (merged.length === 0) {
      const error = webError || 'No news results found for the query.';
      return require('../services/toolErrorCodes').enrich({
        success: false,
        error,
        content: error,
        query,
        meta,
        // 透传缺失依赖标记，让 executeTool 自愈漏斗能精确接管（而非靠文本匹配）。
        ...(webDepId ? { depId: webDepId } : {}),
      });
    }

    // ── 4.5. Fetch real article bodies for snippet-poor web results ────
    // The keyless scrapers only return a SERP snippet (百度 often returns none),
    // which left news degraded to a bare title list. Best-effort enrich: any
    // fetch failure leaves the snippet untouched — never breaks the backbone.
    // Skipped entirely when only Finlight provided results (already has bodies).
    let enriched = merged;
    if (webArticles.length > 0) {
      try {
        const newsContentFetcher = require('../services/newsContentFetcher');
        const out = await newsContentFetcher.enrichArticles(merged);
        enriched = out.articles;
        meta.contentFetch = out.meta;
      } catch {
        // Enrichment is non-critical; fall back to snippet-only on any error.
      }
    }

    // ── 5. Success ────────────────────────────────────────────────────
    const summary = finlightNewsService.summarizeForPrompt(enriched);
    const header = `News for "${query}" — ${enriched.length} article(s) via ${providers.join('+') || 'web'}:`;
    return {
      success: true,
      query,
      count: enriched.length,
      articles: enriched,
      summary,
      // Explicit human/LLM-facing content so the result normalizer does not
      // JSON-stringify the whole payload (summary is not a recognized field).
      content: `${header}\n${summary}`,
      meta,
    };
  },
});
