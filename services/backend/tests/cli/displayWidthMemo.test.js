'use strict';

/**
 * displayWidthMemo 单测 + formatters.displayWidth 集成(byte-identity)。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - getDisplayWidth:命中缓存 computeFn 只跑一次 · LRU 移最新 · 门控关每次现算 · 空串/超长串不缓存 ·
 *    非字符串回退 · computeFn 抛→0 · NaN 不污染缓存 · 有界封顶淘汰最旧。
 *  - 集成:formatters.displayWidth ON vs OFF 对一批(ASCII/CJK/emoji/ANSI/空)逐字节一致;
 *    重复调用同串命中(通过副作用计数不可测,改由等值断言 + 一致性覆盖)。
 *  - LIVE wiring:formatters.js 确实经 displayWidthMemo 委托。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/displayWidthMemo');
const fmt = require('../../src/cli/formatters');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_DISPLAY_WIDTH_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_DISPLAY_WIDTH_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getDisplayWidth: cache hit → computeFn once', () => {
  memo._clearCache();
  let calls = 0;
  const compute = (s) => { calls++; return s.length; };
  const a = memo.getDisplayWidth('hello', compute, {});
  const b = memo.getDisplayWidth('hello', compute, {});
  assert.equal(a, 5);
  assert.equal(b, 5);
  assert.equal(calls, 1, 'second identical call served from cache');
});

test('getDisplayWidth: gate off → computeFn every call', () => {
  memo._clearCache();
  let calls = 0;
  const compute = (s) => { calls++; return s.length; };
  const off = { KHY_DISPLAY_WIDTH_MEMO: 'off' };
  memo.getDisplayWidth('hello', compute, off);
  memo.getDisplayWidth('hello', compute, off);
  assert.equal(calls, 2, 'no caching when gated off');
});

test('getDisplayWidth: empty string not cached (computeFn each time)', () => {
  memo._clearCache();
  let calls = 0;
  const compute = (s) => { calls++; return 0; };
  memo.getDisplayWidth('', compute, {});
  memo.getDisplayWidth('', compute, {});
  assert.equal(calls, 2, 'empty string bypasses cache');
  assert.equal(memo._size(), 0);
});

test('getDisplayWidth: over-long string not cached', () => {
  memo._clearCache();
  const big = 'x'.repeat(memo.MAX_KEY_LEN + 1);
  let calls = 0;
  const compute = (s) => { calls++; return s.length; };
  memo.getDisplayWidth(big, compute, {});
  memo.getDisplayWidth(big, compute, {});
  assert.equal(calls, 2, 'over-long string bypasses cache');
  assert.equal(memo._size(), 0);
});

test('getDisplayWidth: non-string → computeFn (fail-soft)', () => {
  memo._clearCache();
  let calls = 0;
  const compute = () => { calls++; return 0; };
  memo.getDisplayWidth(null, compute, {});
  memo.getDisplayWidth(undefined, compute, {});
  memo.getDisplayWidth(42, compute, {});
  assert.equal(calls, 3);
  assert.equal(memo._size(), 0, 'non-string never cached');
});

test('getDisplayWidth: computeFn throws → 0 not throw', () => {
  memo._clearCache();
  assert.equal(memo.getDisplayWidth('x', () => { throw new Error('boom'); }, {}), 0);
});

test('getDisplayWidth: NaN result not cached (no pollution)', () => {
  memo._clearCache();
  let calls = 0;
  const compute = () => { calls++; return NaN; };
  memo.getDisplayWidth('weird', compute, {});
  memo.getDisplayWidth('weird', compute, {});
  assert.equal(calls, 2, 'NaN not cached → recomputed');
  assert.equal(memo._size(), 0);
});

test('getDisplayWidth: bounded eviction (>MAX_ENTRIES) drops oldest', () => {
  memo._clearCache();
  const compute = (s) => s.length;
  for (let i = 0; i < memo.MAX_ENTRIES + 5; i++) memo.getDisplayWidth('k' + i, compute, {});
  assert.ok(memo._size() <= memo.MAX_ENTRIES, 'cache stays bounded');
  // 'k0' should have been evicted (oldest)
  let recomputed = 0;
  memo.getDisplayWidth('k0', (s) => { recomputed++; return s.length; }, {});
  assert.equal(recomputed, 1, 'k0 was evicted → recomputed');
});

test('getDisplayWidth: LRU touch keeps recently-used alive', () => {
  memo._clearCache();
  const compute = (s) => s.length;
  memo.getDisplayWidth('keep', compute, {});
  // fill to just under cap, touching 'keep' periodically
  for (let i = 0; i < memo.MAX_ENTRIES - 1; i++) {
    memo.getDisplayWidth('f' + i, compute, {});
    if (i % 100 === 0) memo.getDisplayWidth('keep', compute, {}); // touch → moves to newest
  }
  // add a few more to force eviction of oldest (not 'keep', which was recently touched)
  for (let i = 0; i < 10; i++) memo.getDisplayWidth('g' + i, compute, {});
  let recomputed = 0;
  memo.getDisplayWidth('keep', (s) => { recomputed++; return s.length; }, {});
  assert.equal(recomputed, 0, 'recently-touched key survived eviction');
});

test('integration: formatters.displayWidth ON vs OFF byte-identical', () => {
  const samples = [
    '', 'hello world', '/src/index.js', '你好世界', '混合 mixed 文本',
    '😀 emoji 🚀', '\x1b[36mcolored\x1b[39m', 'a'.repeat(200),
    '日本語テキスト', 'café résumé', '  + src/',
  ];
  const prev = process.env.KHY_DISPLAY_WIDTH_MEMO;
  try {
    for (const s of samples) {
      process.env.KHY_DISPLAY_WIDTH_MEMO = 'on';
      const on = fmt.displayWidth(s);
      process.env.KHY_DISPLAY_WIDTH_MEMO = 'off';
      const off = fmt.displayWidth(s);
      assert.equal(on, off, `displayWidth("${s.slice(0, 20)}") ON=${on} OFF=${off}`);
    }
  } finally {
    if (prev == null) delete process.env.KHY_DISPLAY_WIDTH_MEMO;
    else process.env.KHY_DISPLAY_WIDTH_MEMO = prev;
  }
});

test('integration: repeated identical measurement is stable', () => {
  const s = '混合 mixed 文本 with émojis 😀';
  const first = fmt.displayWidth(s);
  for (let i = 0; i < 50; i++) {
    assert.equal(fmt.displayWidth(s), first, 'repeated measurement stable (cache-safe)');
  }
});

test('LIVE wiring: formatters.js delegates through displayWidthMemo', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/formatters.js'), 'utf8');
  assert.ok(/require\(['"]\.\/displayWidthMemo['"]\)/.test(src), 'requires the memo');
  assert.ok(/getDisplayWidth\(str,\s*_computeDisplayWidth/.test(src), 'delegates via getDisplayWidth(str, _computeDisplayWidth, ...)');
  assert.ok(/function _computeDisplayWidth\(str\)/.test(src), 'compute body renamed to _computeDisplayWidth');
});
