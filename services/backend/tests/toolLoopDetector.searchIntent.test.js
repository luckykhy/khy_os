'use strict';

/**
 * toolLoopDetector.searchIntent.test.js — unit coverage for the search-intent
 * dedup signature added to close the "semantically-similar repeated web search"
 * gap (small models re-asking the same question three different ways).
 *
 * Design contract:
 *   - Reformulations of the SAME search (same meaningful keyword set, any order)
 *     must collapse to one signature → they dedup.
 *   - Genuinely DIFFERENT searches (different keywords) must NOT collide → no
 *     false-positive blocking of legitimate distinct searches.
 *   - Empty / stopword-only queries yield null (never treated as a repeat).
 *   - _isSearchTool stays narrow: real web-search tool names only, not bare
 *     "search" (which may be a codebase grep/glob).
 */

const {
  extractSearchIntent,
  _isSearchTool,
} = require('../src/services/toolLoopDetector');

describe('_isSearchTool', () => {
  test('matches web-search tool name variants (normalized)', () => {
    for (const name of ['web_search', 'webSearch', 'websearch', 'web-search',
      'searchWeb', 'WebSearchTool', 'web_query', 'searchEngine']) {
      expect(_isSearchTool(name)).toBe(true);
    }
  });

  test('does NOT match generic / non-search tools', () => {
    for (const name of ['search', 'grep', 'glob', 'find', 'read_file',
      'shell_command', 'web_fetch', 'curl', 'browser']) {
      expect(_isSearchTool(name)).toBe(false);
    }
  });
});

describe('extractSearchIntent', () => {
  test('order-independent: reformulations collapse to the same signature', () => {
    const a = extractSearchIntent({ query: 'weather in Tokyo today' });
    const b = extractSearchIntent({ query: "today's Tokyo weather" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test('punctuation and casing are normalized away', () => {
    const a = extractSearchIntent({ query: 'Node.js, streaming SSE!' });
    const b = extractSearchIntent({ query: 'nodejs streaming sse' });
    // "node.js" → "node js"; "nodejs" → "nodejs" — these legitimately differ,
    // so they must NOT collapse. Guards against over-aggressive normalization.
    expect(a).not.toBe(b);
  });

  test('distinct searches do NOT collide (no false positive)', () => {
    const tokyo = extractSearchIntent({ query: 'weather in Tokyo' });
    const osaka = extractSearchIntent({ query: 'weather in Osaka' });
    expect(tokyo).not.toBe(osaka);
  });

  test('stopword-only / empty query → null (never a repeat)', () => {
    expect(extractSearchIntent({ query: 'how to the of' })).toBeNull();
    expect(extractSearchIntent({ query: '   ' })).toBeNull();
    expect(extractSearchIntent({ query: '' })).toBeNull();
  });

  test('reads alternate param field names', () => {
    expect(extractSearchIntent({ q: 'khy os kernel' })).toBe(
      extractSearchIntent({ query: 'khy os kernel' }));
    expect(extractSearchIntent({ keywords: 'khy os kernel' })).toBe(
      extractSearchIntent({ search: 'khy os kernel' }));
  });

  test('non-object / missing query → null', () => {
    expect(extractSearchIntent(null)).toBeNull();
    expect(extractSearchIntent(undefined)).toBeNull();
    expect(extractSearchIntent({})).toBeNull();
    expect(extractSearchIntent({ query: 42 })).toBeNull();
  });

  test('duplicate keywords are de-duplicated in the signature', () => {
    const a = extractSearchIntent({ query: 'rust rust rust tokenizer' });
    const b = extractSearchIntent({ query: 'tokenizer rust' });
    expect(a).toBe(b);
  });

  test('unicode (CJK) keywords survive normalization', () => {
    const a = extractSearchIntent({ query: '内核 调度器 抢占' });
    const b = extractSearchIntent({ query: '抢占 内核 调度器' });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});
