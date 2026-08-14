'use strict';

/**
 * crossSourceMerge.test.js (node:test)
 *
 * Goal「搜索本地项目与联网搜索做去重」. crossSourceMerge is the single source of
 * truth for merging heterogeneous search results (local files / session history /
 * web) into one deduped, provenance-carrying list:
 *   - within-source EXACT dedup (url / path:line / sessionId:uuid),
 *   - cross-source NEAR dedup by token-set Jaccard, LOCAL-first (the user's own
 *     project wins; the web duplicate is dropped but annotated as corroboration).
 * Pure (no I/O) — fully unit-testable.
 */

const test = require('node:test');
const assert = require('node:assert');

const m = require('../../src/services/search/crossSourceMerge');

// ── normalizers ───────────────────────────────────────────────────────────────

test('normalizeWeb maps web shape and drops items missing both title and url', () => {
  const out = m.normalizeWeb([
    { title: 'Rust 所有权', url: 'https://doc.rust-lang.org/book/ch04', snippet: 'ownership', type: 'docs', domain: 'doc.rust-lang.org' },
    { title: '', url: '', snippet: 'skip' },
    null,
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'web');
  assert.strictEqual(out[0].url, 'https://doc.rust-lang.org/book/ch04');
  assert.strictEqual(out[0].type, 'docs');
});

test('normalizeLocalFiles accepts {matches} or a bare array; builds file:line title', () => {
  const fromObj = m.normalizeLocalFiles({ matches: [{ file: 'src/a.rs', line: 12, content: 'fn own()' }] });
  assert.strictEqual(fromObj.length, 1);
  assert.strictEqual(fromObj[0].source, 'local-file');
  assert.strictEqual(fromObj[0].title, 'src/a.rs:12');
  assert.strictEqual(fromObj[0].path, 'src/a.rs');
  assert.strictEqual(fromObj[0].line, 12);
  const fromArr = m.normalizeLocalFiles([{ file: 'b.js', content: 'x' }]);
  assert.strictEqual(fromArr[0].title, 'b.js'); // no line → bare path
});

test('normalizeHistory maps FTS5 rows; bm25 rank → score = -rank (more negative = more relevant)', () => {
  const out = m.normalizeHistory([
    { sessionId: 'sess-1234abcd', title: '聊 Rust', content: '我们讨论了所有权', uuid: 'u1', rank: -3.2 },
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].source, 'local-history');
  assert.strictEqual(out[0].path, 'sess-1234abcd');
  assert.strictEqual(out[0].score, 3.2);
});

// ── pure helpers ──────────────────────────────────────────────────────────────

test('urlKey mirrors _dedupKey: lowercases host, strips www./trailing slash/utm, keeps real query', () => {
  assert.strictEqual(m.urlKey('https://WWW.Example.com/a/b/'), 'example.com/a/b');
  assert.strictEqual(m.urlKey('https://example.com/p?utm_source=x'), 'example.com/p');
  assert.strictEqual(m.urlKey('https://example.com/p?id=7'), 'example.com/p?id=7');
  assert.strictEqual(m.urlKey(''), '');
});

test('jaccard is 0 on empty and 1 on identical token sets', () => {
  assert.strictEqual(m.jaccard(new Set(), new Set(['a'])), 0);
  const s = m.fingerprint('rust 所有权 借用');
  assert.strictEqual(m.jaccard(s, s), 1);
});

// ── within-source exact dedup ─────────────────────────────────────────────────

test('within-source exact dedup: dup url / dup file:line / dup session:uuid collapse', () => {
  const web = m.normalizeWeb([
    { title: 'A', url: 'https://x.io/a' },
    { title: 'A again', url: 'https://www.x.io/a/' }, // same canonical url
  ]);
  const files = m.normalizeLocalFiles([
    { file: 'a.rs', line: 1, content: 'foo' },
    { file: 'a.rs', line: 1, content: 'foo' }, // same path:line
    { file: 'a.rs', line: 2, content: 'bar' }, // different line → kept
  ]);
  const hist = m.normalizeHistory([
    { sessionId: 's1', content: 'hello', uuid: 'u1' },
    { sessionId: 's1', content: 'hello again', uuid: 'u1' }, // same session:uuid
  ]);
  const r = m.mergeAndDedupe([files, hist, web], { jaccard: 0.99 });
  const urls = r.items.filter(i => i.source === 'web');
  const fileLines = r.items.filter(i => i.source === 'local-file');
  const histItems = r.items.filter(i => i.source === 'local-history');
  assert.strictEqual(urls.length, 1, 'dup url collapsed');
  assert.strictEqual(fileLines.length, 2, 'a.rs:1 deduped, a.rs:2 kept');
  assert.strictEqual(histItems.length, 1, 'dup session:uuid collapsed');
  assert.ok(r.droppedWithinSource >= 3);
});

// ── cross-source near dedup (local-first) ─────────────────────────────────────

test('cross-source near dedup: web duplicate of a local hit is dropped, local survives + annotated', () => {
  const text = 'Rust 的所有权机制 通过借用检查器 保证内存安全 无需垃圾回收';
  const files = m.normalizeLocalFiles([{ file: 'notes/rust.md', line: 3, content: text }]);
  const web = m.normalizeWeb([
    { title: 'Rust 所有权', url: 'https://blog.example.com/rust', snippet: text, type: 'blog' },
    { title: '无关页面', url: 'https://other.com/z', snippet: '今天天气晴朗 适合出门散步', type: 'other' },
  ]);
  const r = m.mergeAndDedupe([files, web], { jaccard: 0.8 });

  const local = r.items.find(i => i.source === 'local-file');
  const webKept = r.items.filter(i => i.source === 'web');
  assert.ok(local, 'local hit survives');
  assert.deepStrictEqual(local.alsoFoundIn, ['web'], 'local annotated 网络也收录');
  assert.deepStrictEqual(local.corroboratingUrls, ['https://blog.example.com/rust']);
  assert.strictEqual(webKept.length, 1, 'the duplicate web result dropped, the unrelated one kept');
  assert.strictEqual(webKept[0].url, 'https://other.com/z');
  assert.strictEqual(r.droppedCrossSource, 1);
});

test('local always wins the collision regardless of input order (local sorted first)', () => {
  const text = '量子纠缠 是两个粒子 即使相隔遥远 也保持关联的现象';
  const web = m.normalizeWeb([{ title: '量子纠缠', url: 'https://w.com/q', snippet: text }]);
  const hist = m.normalizeHistory([{ sessionId: 's9', content: text, uuid: 'uX' }]);
  // Pass web FIRST to prove ordering does not let the web copy win.
  const r = m.mergeAndDedupe([web, hist], { jaccard: 0.8 });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].source, 'local-history');
  assert.deepStrictEqual(r.items[0].alsoFoundIn, ['web']);
});

test('low Jaccard does NOT over-merge: distinct content from different sources both kept', () => {
  const files = m.normalizeLocalFiles([{ file: 'a.rs', line: 1, content: 'Rust 的所有权与借用机制' }]);
  const web = m.normalizeWeb([{ title: 'Go 并发', url: 'https://g.com/goroutine', snippet: 'Go 的 goroutine 与 channel 并发模型' }]);
  const r = m.mergeAndDedupe([files, web], { jaccard: 0.82 });
  assert.strictEqual(r.items.length, 2, 'unrelated local + web both survive');
  assert.strictEqual(r.droppedCrossSource, 0);
});

// ── ordering, caps, robustness ────────────────────────────────────────────────

test('local sources rank before web in the merged output', () => {
  const web = m.normalizeWeb([{ title: 'W', url: 'https://w.com/1', snippet: 'web only' }]);
  const files = m.normalizeLocalFiles([{ file: 'f.rs', line: 5, content: 'local only abc' }]);
  const r = m.mergeAndDedupe([web, files], { jaccard: 0.95 });
  assert.strictEqual(r.items[0].source, 'local-file');
  assert.strictEqual(r.items[1].source, 'web');
});

test('respects totalCap', () => {
  const web = m.normalizeWeb(Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://w.com/${i}`, snippet: `s${i}` })));
  const r = m.mergeAndDedupe([web], { totalCap: 5, jaccard: 0.99 });
  assert.strictEqual(r.items.length, 5);
});

test('handles garbage / empty input without throwing', () => {
  assert.strictEqual(m.mergeAndDedupe(null).total, 0);
  assert.strictEqual(m.mergeAndDedupe(undefined).total, 0);
  assert.strictEqual(m.mergeAndDedupe('nope').total, 0);
  assert.strictEqual(m.mergeAndDedupe([null, [null, undefined], 'x']).total, 0);
  assert.strictEqual(m.normalizeWeb(null).length, 0);
  assert.strictEqual(m.normalizeLocalFiles(null).length, 0);
  assert.strictEqual(m.normalizeHistory(null).length, 0);
});
