'use strict';

/**
 * webSearchDigest.test.js (node:test)
 *
 * Goal "优化khy的本地模式：搜索结果整理一下". digestResults() is the single
 * source of truth for tidying raw web-search hits before local-mode display:
 * dedupe by canonical URL, group by source authority, clean snippets, cap.
 * Pure (no network) — fully unit-testable.
 */
const test = require('node:test');
const assert = require('node:assert');

const ws = require('../../src/services/webSearchService');
const { cleanSnippet } = ws.__parsersForTests;

function sample() {
  return [
    { title: 'Rust 官方文档', url: 'https://doc.rust-lang.org/book/', snippet: '  The   Rust   Language ', type: 'docs', domain: 'doc.rust-lang.org' },
    { title: 'Rust Book (dup url)', url: 'https://doc.rust-lang.org/book/', snippet: 'dup', type: 'docs' },
    { title: 'Wikipedia: Rust', url: 'https://en.wikipedia.org/wiki/Rust', snippet: 'systems language', type: 'reference' },
    { title: 'CSDN 教程', url: 'https://blog.csdn.net/x/1', snippet: 'blog post', type: 'blog' },
    { title: '知乎讨论', url: 'https://www.zhihu.com/question/1', snippet: 'why', type: 'forum' },
    { title: 'No URL', url: '', snippet: 'skip', type: 'other' },
    { title: '', url: 'https://example.com/empty-title', snippet: 'skip', type: 'other' },
  ];
}

test('dedupes by canonical URL and drops items missing url/title', () => {
  const d = ws.digestResults(sample());
  // 5 valid uniques: docs, reference, blog, forum (dup doc + no-url + no-title dropped)
  assert.strictEqual(d.total, 4);
  const urls = d.items.map(i => i.url);
  assert.strictEqual(new Set(urls).size, urls.length, 'no duplicate urls');
});

test('groups by source type in authority order (reference before docs before forum before blog)', () => {
  const d = ws.digestResults(sample());
  assert.deepStrictEqual(d.groups.map(g => g.type), ['reference', 'docs', 'forum', 'blog']);
  assert.strictEqual(d.groups[0].label, '参考资料');
  assert.strictEqual(d.groups[1].label, '官方文档');
});

test('unknown type falls into "other"', () => {
  const d = ws.digestResults([{ title: 'X', url: 'https://x.io/a', snippet: 's', type: 'weird' }]);
  assert.strictEqual(d.groups[0].type, 'other');
  assert.strictEqual(d.groups[0].label, '其他');
});

test('respects overall limit and per-group cap', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `Doc ${i}`, url: `https://doc.rust-lang.org/p/${i}`, snippet: 's', type: 'docs',
  }));
  const d = ws.digestResults(many, { limit: 6, perGroup: 3 });
  assert.strictEqual(d.items.length, 3, 'per-group cap applies');
  // total after dedup capped at limit (6) before grouping, then perGroup trims to 3
  assert.ok(d.total <= 6);
});

test('cleanSnippet collapses whitespace, strips noise prefixes, truncates', () => {
  assert.strictEqual(cleanSnippet('  来源：新浪 — 实际内容  '), '实际内容');
  assert.strictEqual(cleanSnippet('百度快照 真正的摘要'), '真正的摘要');
  assert.strictEqual(cleanSnippet('2024-01-02 - 摘要文本'), '摘要文本');
  assert.strictEqual(cleanSnippet('a\n\n  b   c'), 'a b c');
  const long = cleanSnippet('x'.repeat(500), 50);
  assert.ok(long.length <= 50 && long.endsWith('…'));
  assert.strictEqual(cleanSnippet(''), '');
  assert.strictEqual(cleanSnippet(null), '');
});

test('formatDigestPlain renders grouped numbered text; empty -> friendly message', () => {
  const d = ws.digestResults(sample());
  const text = ws.formatDigestPlain(d);
  assert.match(text, /【参考资料】/);
  assert.match(text, /【官方文档】/);
  assert.match(text, /1\. Wikipedia: Rust/);
  assert.strictEqual(ws.formatDigestPlain(ws.digestResults([])), '未找到相关结果。');
});

test('handles non-array / garbage input without throwing', () => {
  assert.strictEqual(ws.digestResults(null).total, 0);
  assert.strictEqual(ws.digestResults(undefined).total, 0);
  assert.strictEqual(ws.digestResults('nope').total, 0);
});
