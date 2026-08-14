'use strict';

/**
 * inputCursorMetricsMemo 单测。
 *
 * 覆盖:
 *  - isEnabled:default-on + CANON off-words。
 *  - getPromptLen:剥 ANSI · 同串命中缓存(正则只跑一次可观测) · prompt 变则重算 · 非字符串安全。
 *  - getMetrics:同元组命中 computeFn 只跑一次 · 任一字段变则重算 · 门控关每次现算 ·
 *    key 缺失/computeFn 非函数回退 · computeFn 抛→null(不抛) · 非对象结果不入槽。
 *  - LIVE wiring:repl.js 经 inputCursorMetricsMemo 委托。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const memo = require('../../src/cli/repl/inputCursorMetricsMemo');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_INPUT_CURSOR_METRICS_MEMO: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(memo.isEnabled({ KHY_INPUT_CURSOR_METRICS_MEMO: off }), false, `off=${off}`);
  }
  assert.deepEqual(memo.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('getPromptLen: strips ANSI, caches by prompt string', () => {
  memo._clear();
  const p = '\x1b[36m> \x1b[39m';
  assert.equal(memo.getPromptLen(p), 2); // "> "
  assert.equal(memo.getPromptLen(p), 2); // cached
  assert.equal(memo.getPromptLen('khy> '), 5); // different prompt → recompute
  assert.equal(memo.getPromptLen('\x1b[1mkhy\x1b[0m> '), 5); // ANSI stripped
});

test('getPromptLen: non-string safe', () => {
  memo._clear();
  assert.equal(memo.getPromptLen(null), 0);
  assert.equal(memo.getPromptLen(undefined), 0);
});

test('getMetrics: same tuple → computeFn once', () => {
  memo._clear();
  let calls = 0;
  const key = { line: 'abc', cursor: 3, cols: 80, promptRaw: '> ' };
  const compute = () => { calls++; return { cols: 80, promptLen: 2, cursorRow: 0, cursorCol: 5, totalRows: 1 }; };
  const a = memo.getMetrics(key, compute, {});
  const b = memo.getMetrics({ line: 'abc', cursor: 3, cols: 80, promptRaw: '> ' }, compute, {});
  assert.equal(calls, 1, 'second identical tuple served from slot');
  assert.strictEqual(a, b, 'same cached object returned');
});

test('getMetrics: any field change → recompute', () => {
  memo._clear();
  let calls = 0;
  const compute = () => { calls++; return { totalRows: calls }; };
  memo.getMetrics({ line: 'abc', cursor: 3, cols: 80, promptRaw: '> ' }, compute, {});
  memo.getMetrics({ line: 'abcd', cursor: 3, cols: 80, promptRaw: '> ' }, compute, {}); // line
  memo.getMetrics({ line: 'abcd', cursor: 4, cols: 80, promptRaw: '> ' }, compute, {}); // cursor
  memo.getMetrics({ line: 'abcd', cursor: 4, cols: 100, promptRaw: '> ' }, compute, {}); // cols
  memo.getMetrics({ line: 'abcd', cursor: 4, cols: 100, promptRaw: 'khy> ' }, compute, {}); // prompt
  assert.equal(calls, 5, 'every field change recomputes');
});

test('getMetrics: gate off → computeFn every call', () => {
  memo._clear();
  let calls = 0;
  const key = { line: 'abc', cursor: 3, cols: 80, promptRaw: '> ' };
  const compute = () => { calls++; return { totalRows: 1 }; };
  const off = { KHY_INPUT_CURSOR_METRICS_MEMO: 'off' };
  memo.getMetrics(key, compute, off);
  memo.getMetrics(key, compute, off);
  assert.equal(calls, 2, 'no memo when gated off');
  assert.equal(memo._hasSlot(), false, 'nothing cached when off');
});

test('getMetrics: missing key / bad computeFn → fallback', () => {
  memo._clear();
  let calls = 0;
  const compute = () => { calls++; return { totalRows: 1 }; };
  memo.getMetrics(null, compute, {});
  assert.equal(calls, 1, 'null key falls back to computeFn');
  assert.equal(memo.getMetrics({ line: 'x', cursor: 0, cols: 80, promptRaw: '> ' }, 'not-a-fn', {}), undefined);
});

test('getMetrics: computeFn throws → null (never throw)', () => {
  memo._clear();
  const r = memo.getMetrics(
    { line: 'x', cursor: 0, cols: 80, promptRaw: '> ' },
    () => { throw new Error('boom'); },
    {},
  );
  assert.equal(r, null);
});

test('getMetrics: non-object result not cached', () => {
  memo._clear();
  let calls = 0;
  const key = { line: 'x', cursor: 0, cols: 80, promptRaw: '> ' };
  const compute = () => { calls++; return 42; };
  memo.getMetrics(key, compute, {});
  memo.getMetrics(key, compute, {});
  assert.equal(calls, 2, 'non-object result → not cached → recomputed');
  assert.equal(memo._hasSlot(), false);
});

test('getMetrics: ON vs OFF produce identical values', () => {
  memo._clear();
  const key = { line: '混合 mixed', cursor: 4, cols: 80, promptRaw: '\x1b[36m> \x1b[39m' };
  const compute = () => ({ cols: 80, promptLen: 2, cursorRow: 0, cursorCol: 6, totalRows: 1 });
  const on = memo.getMetrics(key, compute, { KHY_INPUT_CURSOR_METRICS_MEMO: 'on' });
  memo._clear();
  const off = memo.getMetrics(key, compute, { KHY_INPUT_CURSOR_METRICS_MEMO: 'off' });
  assert.deepEqual(on, off);
});

test('LIVE wiring: repl.js delegates through inputCursorMetricsMemo', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../src/cli/repl.js'), 'utf8');
  assert.ok(/require\(['"]\.\/repl\/inputCursorMetricsMemo['"]\)/.test(src), 'requires the memo');
  assert.ok(/_icmMemo\.getMetrics\(/.test(src), 'delegates via getMetrics');
  assert.ok(/function _computeInputCursorMetrics\(/.test(src), 'compute body extracted to _computeInputCursorMetrics');
  assert.ok(/_icmMemo\.getPromptLen\(/.test(src), 'promptLen delegated to getPromptLen');
});
