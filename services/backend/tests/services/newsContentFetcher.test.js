'use strict';

/**
 * newsContentFetcher.test.js — locks for the article-body enrichment helper.
 *
 * Network is never touched: enrichArticles accepts an injected `fetchText`, and
 * the pure helpers (_condense/_runPool/_truthyDisabled) are exercised directly.
 */

const fetcher = require('../../src/services/newsContentFetcher');
const { _condense, _runPool, _truthyDisabled } = fetcher.__internals;

describe('newsContentFetcher.enrichArticles', () => {
  test('fills body text for short-snippet articles via injected fetcher', async () => {
    const articles = [
      { title: 'A', content: '', url: 'https://news.example/a' },
      { title: 'B', content: 'short', url: 'https://news.example/b' },
    ];
    const fetchText = jest.fn(async (url) => `FULL BODY for ${url} — long enough to replace the snippet.`);

    const { articles: out, meta } = await fetcher.enrichArticles(articles, { fetchText, minSnippet: 80, max: 5 });

    expect(meta.attempted).toBe(2);
    expect(meta.enriched).toBe(2);
    expect(out[0].content).toMatch(/FULL BODY/);
    expect(out[1].content).toMatch(/FULL BODY/);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  test('leaves articles whose snippet is already long enough', async () => {
    const longSnippet = 'x'.repeat(120);
    const articles = [{ title: 'A', content: longSnippet, url: 'https://news.example/a' }];
    const fetchText = jest.fn(async () => 'should not be used');

    const { articles: out, meta } = await fetcher.enrichArticles(articles, { fetchText, minSnippet: 80 });

    expect(meta.attempted).toBe(0);
    expect(out[0].content).toBe(longSnippet);
    expect(fetchText).not.toHaveBeenCalled();
  });

  test('skips non-http(s) urls', async () => {
    const articles = [{ title: 'A', content: '', url: 'ftp://x/y' }, { title: 'B', content: '', url: '' }];
    const fetchText = jest.fn(async () => 'body');

    const { meta } = await fetcher.enrichArticles(articles, { fetchText });

    expect(meta.attempted).toBe(0);
    expect(fetchText).not.toHaveBeenCalled();
  });

  test('never overwrites when fetch returns empty or shorter text (fail-soft)', async () => {
    const articles = [{ title: 'A', content: 'keep', url: 'https://news.example/a' }];
    const fetchText = jest.fn(async () => ''); // fetch failed → empty

    const { articles: out, meta } = await fetcher.enrichArticles(articles, { fetchText, minSnippet: 80 });

    expect(meta.attempted).toBe(1);
    expect(meta.enriched).toBe(0);
    expect(out[0].content).toBe('keep');
  });

  test('a throwing fetcher does not break the batch', async () => {
    const articles = [
      { title: 'A', content: '', url: 'https://news.example/a' },
      { title: 'B', content: '', url: 'https://news.example/b' },
    ];
    const fetchText = jest.fn(async (url) => {
      if (url.endsWith('/a')) throw new Error('boom');
      return 'Recovered body long enough to count as enrichment.';
    });

    const { articles: out, meta } = await fetcher.enrichArticles(articles, { fetchText, minSnippet: 80 });

    expect(meta.enriched).toBe(1);
    expect(out[1].content).toMatch(/Recovered body/);
  });

  test('honors max cap (only top-N candidates fetched)', async () => {
    const articles = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, content: '', url: `https://news.example/${i}` }));
    const fetchText = jest.fn(async () => 'Fetched body text that is sufficiently long.');

    const { meta } = await fetcher.enrichArticles(articles, { fetchText, minSnippet: 80, max: 2 });

    expect(meta.attempted).toBe(2);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  test('disabled via opts returns articles untouched', async () => {
    const articles = [{ title: 'A', content: '', url: 'https://news.example/a' }];
    const fetchText = jest.fn(async () => 'body');

    const { meta } = await fetcher.enrichArticles(articles, { fetchText, enabled: false });

    expect(meta.enabled).toBe(false);
    expect(meta.attempted).toBe(0);
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe('newsContentFetcher internals', () => {
  test('_truthyDisabled recognizes the off switches', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
      expect(_truthyDisabled(v)).toBe(true);
    }
    for (const v of ['1', 'true', 'on', '', undefined, null, 'yes']) {
      expect(_truthyDisabled(v)).toBe(false);
    }
  });

  test('_condense strips the Page Structure TOC and short nav lines', () => {
    const text = '## Page Structure\n  - Heading A\n  - Heading B\n---\nReal body sentence number one. Real body sentence number two.';
    const out = _condense(text);
    expect(out).not.toMatch(/Page Structure/);
    expect(out).toMatch(/Real body sentence number one/);
  });

  test('_condense caps length', () => {
    const long = Array.from({ length: 500 }, (_, i) => `sentence number ${i} here`).join('\n');
    expect(_condense(long).length).toBeLessThanOrEqual(1200);
  });

  test('_runPool processes every item with bounded concurrency', async () => {
    const items = [1, 2, 3, 4, 5];
    let active = 0; let maxActive = 0;
    const worker = async (n) => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    };
    const out = await _runPool(items, worker, 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
