'use strict';

/**
 * unifiedSearch.test.js (node:test)
 *
 * The DI orchestrator that fans one query across web + local-file (grep) +
 * session-history sources in parallel and routes them through crossSourceMerge.
 * Searchers are injected, so these tests use fakes — no network, no FS, no DB.
 * Contract under test: parallel fan-out, per-source fail-soft, ripgrep-safe
 * keyword pattern building, and graceful handling of empty/short queries.
 */

const test = require('node:test');
const assert = require('node:assert');

const { unifiedSearch, buildGrepPattern } = require('../../src/services/search/unifiedSearch');

// ── buildGrepPattern ──────────────────────────────────────────────────────────

test('buildGrepPattern builds a regex-safe alternation and drops single CJK chars', () => {
  const p = buildGrepPattern('rust ownership 借用检查');
  const terms = p.split('|');
  // ascii words survive; CJK bigrams (借用/用检/检查) survive; single chars dropped.
  assert.ok(terms.includes('rust'));
  assert.ok(terms.includes('ownership'));
  assert.ok(terms.some(t => /[一-鿿]{2}/.test(t)), 'has a CJK bigram term');
  assert.ok(!terms.includes('借'), 'single CJK char dropped');
});

test('buildGrepPattern yields a ripgrep-safe pattern (no unescaped regex metachars)', () => {
  // The tokenizer keeps only CJK / [a-z0-9_], so punctuation is stripped before
  // it can reach the pattern; the only structural char left is the '|' separator.
  const p = buildGrepPattern('c++ a.b net_io 借用');
  assert.ok(p.split('|').includes('net_io'), 'underscored word survives intact');
  const withoutSeparators = p.replace(/\|/g, '');
  assert.ok(!/[.+*?^${}()[\]\\]/.test(withoutSeparators), 'no stray regex metacharacters');
});

test('buildGrepPattern caps the number of terms', () => {
  const p = buildGrepPattern('alpha beta gamma delta epsilon zeta eta theta', { maxTerms: 3 });
  assert.strictEqual(p.split('|').length, 3);
});

test('buildGrepPattern returns empty when nothing useful remains', () => {
  assert.strictEqual(buildGrepPattern('的 了 是'), ''); // all single CJK chars
  assert.strictEqual(buildGrepPattern('   '), '');
});

// ── fan-out + merge ───────────────────────────────────────────────────────────

function fakeDeps(overrides = {}) {
  return {
    webSearch: async () => [
      { title: '网络结果', url: 'https://w.com/a', snippet: '联网摘要 关于某主题' },
    ],
    grepSearch: async () => ({
      matches: [{ file: 'src/x.js', line: 10, content: '本地文件命中 关于某主题' }],
    }),
    historySearch: () => [
      { sessionId: 's1', content: '历史会话片段', uuid: 'u1', rank: -2 },
    ],
    ...overrides,
  };
}

test('fans out all three sources and merges them', async () => {
  const r = await unifiedSearch('某主题 关键词', fakeDeps());
  assert.strictEqual(r.sources.web, 1);
  assert.strictEqual(r.sources.localFile, 1);
  assert.strictEqual(r.sources.localHistory, 1);
  const sources = new Set(r.items.map(i => i.source));
  assert.ok(sources.has('web') && sources.has('local-file') && sources.has('local-history'));
});

test('fail-soft: a source that throws contributes nothing, others still merge', async () => {
  const r = await unifiedSearch('某主题 关键词', fakeDeps({
    grepSearch: async () => { throw new Error('rg not installed'); },
    historySearch: () => { throw new Error('index unavailable'); },
  }));
  assert.strictEqual(r.sources.localFile, 0);
  assert.strictEqual(r.sources.localHistory, 0);
  assert.strictEqual(r.sources.web, 1, 'web survives the other sources failing');
  assert.ok(r.items.length >= 1);
});

test('web-only deps yield a web-only merged list', async () => {
  const r = await unifiedSearch('hello world', {
    webSearch: async () => ({ results: [{ title: 'W', url: 'https://w.com/1', snippet: 's' }] }),
  });
  assert.strictEqual(r.sources.localFile, 0);
  assert.strictEqual(r.sources.localHistory, 0);
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].source, 'web');
});

test('grep source is skipped when the query yields no useful keywords', async () => {
  let grepCalled = false;
  const r = await unifiedSearch('的 了', fakeDeps({
    grepSearch: async () => { grepCalled = true; return { matches: [] }; },
  }));
  assert.strictEqual(grepCalled, false, 'no pattern → grep not invoked');
  assert.strictEqual(r.sources.localFile, 0);
});

test('short / empty query returns an empty result without calling sources', async () => {
  let called = false;
  const r = await unifiedSearch('x', { webSearch: async () => { called = true; return []; } });
  assert.strictEqual(called, false);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.deduped.total, 0);
});

test('cross-source dedup is applied end-to-end (local absorbs the matching web hit)', async () => {
  const shared = '光合作用 是植物 利用阳光 把二氧化碳和水 转化为有机物 的过程';
  const r = await unifiedSearch('光合作用 过程', {
    webSearch: async () => [{ title: '光合作用', url: 'https://w.com/photo', snippet: shared }],
    historySearch: () => [{ sessionId: 's1', content: shared, uuid: 'u1', rank: -5 }],
  }, { jaccard: 0.8 });
  // The web copy is absorbed by the history hit → one item, annotated.
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].source, 'local-history');
  assert.deepStrictEqual(r.items[0].alsoFoundIn, ['web']);
  assert.strictEqual(r.deduped.droppedCrossSource, 1);
});
