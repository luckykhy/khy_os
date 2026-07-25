'use strict';

/**
 * news.test.js — unit locks for the `news` tool (src/tools/news.js).
 *
 * The tool is a thin orchestrator over webSearchService (always-on backbone)
 * and finlightNewsService (optional financial enrichment, gated on
 * FINLIGHT_API_KEY). Both deps are mocked so the tests are hermetic and assert
 * the orchestration contract: news-domain ranking, Finlight merge, graceful
 * key-less degradation, total-failure path, transparent meta, and schema.
 */

const mockSearch = jest.fn();
const mockFetchNews = jest.fn();
const mockSummarize = jest.fn((articles) => `SUMMARY(${(articles || []).length})`);
const mockEnrich = jest.fn(async (articles) => ({
  articles,
  meta: { enabled: true, attempted: 0, enriched: 0 },
}));

jest.mock('../../src/services/webSearchService', () => ({
  search: mockSearch,
}));
jest.mock('../../src/services/finlightNewsService', () => ({
  fetchNews: mockFetchNews,
  summarizeForPrompt: mockSummarize,
}));
jest.mock('../../src/services/newsContentFetcher', () => ({
  enrichArticles: mockEnrich,
}));

const newsTool = require('../../src/tools/news');

describe('news tool', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FINLIGHT_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── 1. Web-only path, news-domain ranking ─────────────────────────────
  test('returns web articles with news-type ranked first; web-only meta when no key', async () => {
    mockSearch.mockResolvedValue({
      success: true,
      results: [
        { title: 'Blog post', url: 'https://medium.com/a', snippet: 'b', domain: 'medium.com', type: 'blog', publishedDate: '' },
        { title: 'Breaking news', url: 'https://reuters.com/x', snippet: 'n', domain: 'reuters.com', type: 'news', publishedDate: '2026-06-06' },
      ],
    });

    const res = await newsTool.execute({ query: 'latest tech news', limit: 10 });

    expect(res.success).toBe(true);
    // News-type result must be ranked ahead of the blog despite later input order.
    expect(res.articles[0].title).toBe('Breaking news');
    expect(res.articles[0].source).toBe('reuters.com');
    expect(res.articles[0].publishedAt).toBe('2026-06-06');
    expect(res.meta.providers).toEqual(['web']);
    expect(res.meta.finlightAvailable).toBe(false);
    expect(res.meta.note).toContain('FINLIGHT_API_KEY');
    expect(mockFetchNews).not.toHaveBeenCalled();
    // Explicit content (not a JSON dump of the payload).
    expect(typeof res.content).toBe('string');
    expect(res.content).toContain('latest tech news');
  });

  // ── 2. Finlight enrichment path ───────────────────────────────────────
  test('merges Finlight articles ahead of web results when key set and query financial', async () => {
    process.env.FINLIGHT_API_KEY = 'test-key';
    mockSearch.mockResolvedValue({
      success: true,
      results: [
        { title: 'Web Tesla piece', url: 'https://example.com/t', snippet: 'w', domain: 'example.com', type: 'other', publishedDate: '' },
      ],
    });
    mockFetchNews.mockResolvedValue([
      { title: 'Tesla earnings beat', content: 'c', source: 'Finlight', url: 'https://fin.me/1', publishedAt: '2026-06-05', sentiment: 'positive', sentimentScore: 0.8 },
    ]);

    const res = await newsTool.execute({ query: 'Tesla', financial: true, limit: 10 });

    expect(res.success).toBe(true);
    expect(mockFetchNews).toHaveBeenCalledWith('Tesla', 'test-key', { limit: 10 });
    // Finlight article ranked first, carries sentiment.
    expect(res.articles[0].title).toBe('Tesla earnings beat');
    expect(res.articles[0].sentiment).toBe('positive');
    expect(res.meta.providers).toEqual(['web', 'finlight']);
    expect(res.meta.finlightAvailable).toBe(true);
  });

  // ── 3. Financial query but NO key → graceful degrade ──────────────────
  test('does not call Finlight when key absent, even for explicit financial query', async () => {
    mockSearch.mockResolvedValue({
      success: true,
      results: [{ title: 'Stock web', url: 'https://e.com/s', snippet: 's', domain: 'e.com', type: 'other', publishedDate: '' }],
    });

    const res = await newsTool.execute({ query: 'AAPL stock', financial: true });

    expect(res.success).toBe(true);
    expect(mockFetchNews).not.toHaveBeenCalled();
    expect(res.meta.providers).toEqual(['web']);
    expect(res.meta.finlightAvailable).toBe(false);
    expect(res.meta.note).toContain('FINLIGHT_API_KEY');
  });

  // ── 4. Total failure path ─────────────────────────────────────────────
  test('returns success:false with the proxy hint when web search fails and no Finlight', async () => {
    mockSearch.mockResolvedValue({ success: false, error: '当前环境无法访问外网搜索引擎。请配置代理' });

    const res = await newsTool.execute({ query: 'anything' });

    expect(res.success).toBe(false);
    expect(res.error).toContain('配置代理');
    expect(res.content).toContain('配置代理');
    expect(res.meta.providers).toEqual([]);
  });

  // ── 5. Schema validation ──────────────────────────────────────────────
  test('schema requires query and constrains limit/financial', () => {
    expect(newsTool.name).toBe('news');
    expect(newsTool.isReadOnly()).toBe(true);
    expect(newsTool.isConcurrencySafe()).toBe(true);

    const missing = newsTool.validate({});
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(' ')).toMatch(/query is required/i);

    const ok = newsTool.validate({ query: 'x', limit: 5, financial: true });
    expect(ok.valid).toBe(true);

    const tooBig = newsTool.validate({ query: 'x', limit: 99 });
    expect(tooBig.valid).toBe(false);
  });

  // ── 6. limit is clamped, not trusted blindly ──────────────────────────
  test('clamps an out-of-range limit when executing', async () => {
    process.env.FINLIGHT_API_KEY = 'k';
    mockSearch.mockResolvedValue({ success: true, results: [{ title: 'a', url: 'https://e.com/a', snippet: '', domain: 'e.com', type: 'news', publishedDate: '' }] });
    mockFetchNews.mockResolvedValue([]);

    await newsTool.execute({ query: 'stock market', limit: 999, financial: true });

    // fetchNews receives the clamped limit (<=30), never the raw 999.
    expect(mockFetchNews).toHaveBeenCalledWith('stock market', 'k', { limit: 30 });
  });

  // ── 7. Content enrichment wiring ──────────────────────────────────────
  test('enriches web articles via newsContentFetcher and surfaces meta.contentFetch', async () => {
    mockSearch.mockResolvedValue({
      success: true,
      results: [{ title: 'Thin', url: 'https://news.example/x', snippet: '', domain: 'news.example', type: 'news', publishedDate: '' }],
    });
    mockEnrich.mockResolvedValueOnce({
      articles: [{ title: 'Thin', content: 'Full fetched body text.', source: 'news.example', url: 'https://news.example/x', publishedAt: '', sentiment: null, sentimentScore: null }],
      meta: { enabled: true, attempted: 1, enriched: 1 },
    });

    const res = await newsTool.execute({ query: 'breaking', limit: 5 });

    expect(res.success).toBe(true);
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    // Enriched body flows into the returned articles and the meta is transparent.
    expect(res.articles[0].content).toBe('Full fetched body text.');
    expect(res.meta.contentFetch).toEqual({ enabled: true, attempted: 1, enriched: 1 });
  });

  // ── 8. Enrichment is skipped on the Finlight-only path ────────────────
  test('does not call content enrichment when there are no web articles', async () => {
    process.env.FINLIGHT_API_KEY = 'key';
    mockSearch.mockResolvedValue({ success: true, results: [] });
    mockFetchNews.mockResolvedValue([
      { title: 'Fin only', content: 'has body', source: 'Finlight', url: 'https://fin.me/9', publishedAt: '', sentiment: 'neutral', sentimentScore: 0 },
    ]);

    const res = await newsTool.execute({ query: 'AAPL earnings', financial: true });

    expect(res.success).toBe(true);
    expect(res.meta.providers).toEqual(['finlight']);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(res.meta.contentFetch).toBeUndefined();
  });
});
