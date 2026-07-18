'use strict';

/**
 * rawPasteChunkClassify 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - isPasteChunk:短 chunk 快路径 false(免正则)· 长 chunk + >=2 换行 true · 长 chunk + <2 换行 false ·
 *    长度恰达阈值边界 · 门控关走历史正则路径(逐字节等价)· 坏输入不抛。
 *  - 逐字节等价:大量随机形状 chunk,ON(快路径)与历史正则实现布尔结果完全一致。
 *  - _countNewlinesUpTo:数到 cap 即提前退出。
 *  - LIVE wiring:repl.js 经 rawPasteChunkClassify.isPasteChunk 门控粘贴判定 + 保留正则回退。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cls = require('../../src/cli/repl/rawPasteChunkClassify');

const THRESHOLD = 40;

// 历史正则参考实现(逐字节回退基准)。
function refIsPaste(raw, th) {
  const s = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
  return s.length >= th && (s.match(/[\r\n]/g) || []).length >= 2;
}

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(cls.isEnabled({}), true);
  assert.equal(cls.isEnabled({ KHY_RAW_PASTE_CHUNK_FASTPATH: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cls.isEnabled({ KHY_RAW_PASTE_CHUNK_FASTPATH: off }), false, `off=${off}`);
  }
  assert.deepEqual(cls.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('isPasteChunk: short chunk → false (fast path, no regex needed)', () => {
  assert.equal(cls.isPasteChunk('a', THRESHOLD, {}), false);
  assert.equal(cls.isPasteChunk('hello world', THRESHOLD, {}), false);
  // even a short chunk WITH newlines is not a paste (below length threshold)
  assert.equal(cls.isPasteChunk('a\nb\nc', THRESHOLD, {}), false);
});

test('isPasteChunk: long chunk + >=2 newlines → true', () => {
  const long = 'x'.repeat(40) + '\nfoo\nbar'; // length >=40, 2 newlines
  assert.equal(cls.isPasteChunk(long, THRESHOLD, {}), true);
  assert.equal(refIsPaste(long, THRESHOLD), true, 'matches historical');
});

test('isPasteChunk: long chunk + <2 newlines → false', () => {
  const oneNl = 'x'.repeat(50) + '\nfoo'; // length >=40 but only 1 newline
  assert.equal(cls.isPasteChunk(oneNl, THRESHOLD, {}), false);
  const zeroNl = 'x'.repeat(50); // long, no newline
  assert.equal(cls.isPasteChunk(zeroNl, THRESHOLD, {}), false);
});

test('isPasteChunk: length exactly at threshold boundary', () => {
  // exactly threshold length with 2 newlines → true
  const at = 'x'.repeat(THRESHOLD - 2) + '\n\n'; // length === THRESHOLD, 2 newlines
  assert.equal(at.length, THRESHOLD);
  assert.equal(cls.isPasteChunk(at, THRESHOLD, {}), true);
  // one below threshold → false
  const below = 'x'.repeat(THRESHOLD - 3) + '\n\n'; // length === THRESHOLD - 1
  assert.equal(below.length, THRESHOLD - 1);
  assert.equal(cls.isPasteChunk(below, THRESHOLD, {}), false);
});

test('isPasteChunk: \\r counts as newline (same as historical [\\r\\n])', () => {
  const cr = 'x'.repeat(45) + '\r\r'; // 2 carriage returns
  assert.equal(cls.isPasteChunk(cr, THRESHOLD, {}), true);
  assert.equal(refIsPaste(cr, THRESHOLD), true);
  const crlf = 'x'.repeat(45) + '\r\n'; // CRLF = 2 chars (\r and \n) → count 2
  assert.equal(cls.isPasteChunk(crlf, THRESHOLD, {}), true);
  assert.equal(refIsPaste(crlf, THRESHOLD), true);
});

test('isPasteChunk: gate off → historical regex path (byte-identical)', () => {
  const off = { KHY_RAW_PASTE_CHUNK_FASTPATH: 'off' };
  const long = 'x'.repeat(40) + '\nfoo\nbar';
  assert.equal(cls.isPasteChunk(long, THRESHOLD, off), refIsPaste(long, THRESHOLD));
  assert.equal(cls.isPasteChunk('a\nb\nc', THRESHOLD, off), refIsPaste('a\nb\nc', THRESHOLD));
});

test('isPasteChunk: bad input never throws', () => {
  assert.equal(cls.isPasteChunk(null, THRESHOLD, {}), false);
  assert.equal(cls.isPasteChunk(undefined, THRESHOLD, {}), false);
  assert.equal(cls.isPasteChunk(42, THRESHOLD, {}), false);
  // missing threshold → defaults to 40
  assert.equal(cls.isPasteChunk('x'.repeat(50) + '\n\n', undefined, {}), true);
});

test('byte-identical: fast path (ON) == historical regex across many shapes', () => {
  // deterministic pseudo-random-ish shapes (no Math.random — reproducible)
  const alphabets = ['x', '\n', '\r', ' ', 'ab'];
  let mismatches = 0;
  let checked = 0;
  for (let len = 0; len < 90; len++) {
    for (let seed = 0; seed < 5; seed++) {
      let s = '';
      for (let i = 0; i < len; i++) {
        s += alphabets[(i * 7 + seed * 13 + len) % alphabets.length];
      }
      const on = cls.isPasteChunk(s, THRESHOLD, {});
      const ref = refIsPaste(s, THRESHOLD);
      if (on !== ref) mismatches++;
      checked++;
    }
  }
  assert.equal(mismatches, 0, `all ${checked} shapes byte-identical to historical`);
});

test('_countNewlinesUpTo: early-exits at cap', () => {
  assert.equal(cls._countNewlinesUpTo('abc', 2), 0);
  assert.equal(cls._countNewlinesUpTo('a\nb', 2), 1);
  assert.equal(cls._countNewlinesUpTo('a\nb\nc\nd', 2), 2, 'capped at 2 even with 3 newlines');
  assert.equal(cls._countNewlinesUpTo('\r\r\r\r', 2), 2);
});

test('_countNewlinesRegex: matches [\\r\\n] semantics', () => {
  assert.equal(cls._countNewlinesRegex('a\nb\rc\r\nd'), 4);
  assert.equal(cls._countNewlinesRegex('abc'), 0);
  assert.equal(cls._countNewlinesRegex(null), 0);
});

test('LIVE wiring: repl.js gates paste detection via isPasteChunk + regex fallback', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(/require\(['"]\.\/repl\/rawPasteChunkClassify['"]\)/.test(src), 'requires the classify leaf');
  assert.ok(/_pasteClassify\.isPasteChunk\(raw,\s*RAW_PASTE_THRESHOLD,\s*process\.env\)/.test(src), 'gates via isPasteChunk');
  // byte-identical fallback preserved when leaf unavailable
  assert.ok(/raw\.length >= RAW_PASTE_THRESHOLD && \(raw\.match\(\/\[\\r\\n\]\/g\) \|\| \[\]\)\.length >= 2/.test(src), 'historical regex fallback preserved');
});
