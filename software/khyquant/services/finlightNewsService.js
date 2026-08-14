/**
 * Finlight.me Financial News Service
 *
 * Fetches real-time financial news with sentiment analysis
 * from the Finlight.me API (https://api.finlight.me/v2/articles).
 *
 * Requires an API key — users configure this in the frontend
 * Token Management dialog.
 */
const logger = require('../utils/logger');
const cacheService = require('./cacheService');

const FINLIGHT_API_URL = 'https://api.finlight.me/v2/articles';
const CACHE_TTL = 600; // 10 minutes

class FinlightNewsService {
  /**
   * Fetch financial news articles from Finlight.me.
   *
   * @param {string} query - Search query (e.g. stock name, symbol, sector)
   * @param {string} apiKey - Finlight.me API key
   * @param {Object} options - { limit }
   * @returns {Array} Normalized news articles
   */
  async fetchNews(query, apiKey, options = {}) {
    if (!apiKey) {
      logger.warn('Finlight API key not provided');
      return [];
    }
    if (!query) {
      logger.warn('Finlight query is empty');
      return [];
    }

    const { limit = 10 } = options;

    // Check cache
    const cacheKey = `finlight:${query}:${limit}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      logger.info('Finlight cache hit', { query });
      return cached;
    }

    try {
      // Dynamic import of node-fetch for Node.js < 18 compatibility
      const fetchFn = typeof fetch !== 'undefined' ? fetch : (await import('node-fetch')).default;

      const response = await fetchFn(FINLIGHT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': apiKey,
        },
        body: JSON.stringify({
          query,
          limit,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn('Finlight API error', { status: response.status, body: text });
        return [];
      }

      const data = await response.json();

      // The API returns an array of articles directly, or wrapped in { articles: [...] }
      const articles = Array.isArray(data) ? data : (data.articles || data.data || []);

      // Normalize to a consistent format
      const normalized = articles.slice(0, limit).map((article) => ({
        title: article.title || '',
        content: (article.description || article.content || article.summary || '').slice(0, 500),
        source: article.source?.name || article.sourceName || article.source || '',
        url: article.url || article.link || '',
        publishedAt: article.publishedAt || article.date || article.time || '',
        sentiment: article.sentiment || null,
        sentimentScore: article.sentimentScore ?? article.sentiment_score ?? null,
        imageUrl: article.imageUrl || article.image || null,
      }));

      // Cache results
      if (normalized.length > 0) {
        await cacheService.set(cacheKey, normalized, CACHE_TTL);
      }

      logger.info('Finlight news fetched', { query, count: normalized.length });
      return normalized;
    } catch (error) {
      logger.error('Finlight fetch failed', { query, error: error.message });
      return [];
    }
  }

  /**
   * Build a search query from a Chinese stock symbol.
   * Maps common A-share codes to company names for better search results.
   */
  buildQueryFromSymbol(symbol) {
    if (!symbol) return '';

    // Strip exchange prefix (sh/sz)
    const code = symbol.replace(/^(sh|sz)/i, '');

    // Map well-known stock codes to English company names for global search
    const SYMBOL_MAP = {
      '000001': 'Ping An Bank China',
      '000300': 'CSI 300 China index',
      '000002': 'China Vanke',
      '600000': 'Shanghai Pudong Development Bank',
      '600036': 'China Merchants Bank',
      '600519': 'Kweichow Moutai',
      '601318': 'Ping An Insurance China',
      '399001': 'Shenzhen Component Index',
      '399006': 'ChiNext Index',
    };

    if (SYMBOL_MAP[code]) {
      return SYMBOL_MAP[code];
    }

    // For indices
    if (/^000\d{3}$/.test(code) || /^399\d{3}$/.test(code)) {
      return `China stock index ${code}`;
    }

    // For general A-share stocks
    return `China stock ${code}`;
  }

  /**
   * Summarize news articles into a compact text block for LLM prompts.
   */
  summarizeForPrompt(articles) {
    if (!articles || articles.length === 0) {
      return '';
    }

    const lines = articles.map((a, i) => {
      const sentiment = a.sentiment
        ? ` [sentiment: ${a.sentiment}]`
        : a.sentimentScore != null
          ? ` [sentiment score: ${a.sentimentScore}]`
          : '';
      const source = a.source ? ` — ${a.source}` : '';
      const time = a.publishedAt ? ` (${a.publishedAt})` : '';
      const snippet = a.content ? `\n   ${a.content.slice(0, 150)}` : '';
      return `${i + 1}. ${a.title}${sentiment}${source}${time}${snippet}`;
    });

    return lines.join('\n');
  }
}

module.exports = new FinlightNewsService();
