'use strict';

/**
 * toolLiteralOutputMemo.test.js — 已完成工具 LITERAL 输出体记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - memoPreview:按 result 对象身份命中(computeFn 只调一次);非对象/假值 → 不缓存直算。
 *  - memoFoldedLines:按 (result, expanded) 命中;expanded 切换 → 各自独立槽,不串味。
 *  - **逐字节等价**:记忆值恒 === 直接调 computeFn 的值。
 *  - 门控关:每次都调 computeFn(不读/不写缓存)。
 *  - computeFn 抛错 → 兜底(preview→''、lines→[]),绝不抛。
 *  - LIVE 接线:ToolLines.js 用 memoPreview 包 formatShellOutputJson、memoFoldedLines 包折叠管线。
 *
 * 运行:node --test services/backend/tests/cli/toolLiteralOutputMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/toolLiteralOutputMemo');

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_TOOL_LITERAL_OUTPUT_MEMO: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_LITERAL_OUTPUT_MEMO: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_LITERAL_OUTPUT_MEMO: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_LITERAL_OUTPUT_MEMO: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_LITERAL_OUTPUT_MEMO: 'on' }), true);
});

test('memoPreview:同一 result 命中,computeFn 只调一次', () => {
  const result = { text: 'hello\nworld' };
  let calls = 0;
  const compute = () => { calls++; return 'PREVIEW'; };
  const a = leaf.memoPreview(result, compute, {});
  const b = leaf.memoPreview(result, compute, {});
  const c = leaf.memoPreview(result, compute, {});
  assert.equal(a, 'PREVIEW');
  assert.equal(b, 'PREVIEW');
  assert.equal(c, 'PREVIEW');
  assert.equal(calls, 1, '命中不重算');
});

test('memoPreview:不同 result 对象 → 各自计算', () => {
  const r1 = { text: 'a' };
  const r2 = { text: 'b' };
  let calls = 0;
  const mk = (v) => () => { calls++; return v; };
  assert.equal(leaf.memoPreview(r1, mk('P1'), {}), 'P1');
  assert.equal(leaf.memoPreview(r2, mk('P2'), {}), 'P2');
  assert.equal(calls, 2);
  // 各自再取一次命中
  assert.equal(leaf.memoPreview(r1, mk('X'), {}), 'P1');
  assert.equal(leaf.memoPreview(r2, mk('Y'), {}), 'P2');
  assert.equal(calls, 2, '两 result 各命中,不重算');
});

test('memoPreview:非对象/假值 → 不缓存直算(每次调 computeFn)', () => {
  let calls = 0;
  const compute = () => { calls++; return 'Z'; };
  assert.equal(leaf.memoPreview(null, compute, {}), 'Z');
  assert.equal(leaf.memoPreview(undefined, compute, {}), 'Z');
  assert.equal(leaf.memoPreview('str', compute, {}), 'Z');
  assert.equal(calls, 3, '非对象键每次直算');
});

test('memoPreview:逐字节等价 —— 记忆值 === 直接 computeFn 值', () => {
  const result = {};
  const compute = () => 'DETERMINISTIC';
  const direct = compute();
  assert.equal(leaf.memoPreview(result, compute, {}), direct);
  // 命中路径也等价(输入未变即视为同结果)
  assert.equal(leaf.memoPreview(result, () => 'OTHER', {}), 'DETERMINISTIC');
});

test('memoPreview:门控关 → 每次都调 computeFn', () => {
  const result = {};
  let calls = 0;
  const off = { KHY_TOOL_LITERAL_OUTPUT_MEMO: 'off' };
  const compute = () => { calls++; return 'P'; };
  assert.equal(leaf.memoPreview(result, compute, off), 'P');
  assert.equal(leaf.memoPreview(result, compute, off), 'P');
  assert.equal(calls, 2, '门控关每次都算');
});

test('memoPreview:computeFn 抛错 → 兜底 空串,绝不抛', () => {
  const boom = () => { throw new Error('boom'); };
  assert.equal(leaf.memoPreview({}, boom, {}), '');
  assert.equal(leaf.memoPreview({}, boom, { KHY_TOOL_LITERAL_OUTPUT_MEMO: 'off' }), '');
});

test('memoFoldedLines:同一 (result, expanded) 命中一次', () => {
  const result = { text: 'x' };
  let calls = 0;
  const compute = () => { calls++; return ['a', 'b']; };
  const a = leaf.memoFoldedLines(result, false, compute, {});
  const b = leaf.memoFoldedLines(result, false, compute, {});
  assert.deepEqual(a, ['a', 'b']);
  assert.strictEqual(a, b, '命中返回同一数组引用');
  assert.equal(calls, 1);
});

test('memoFoldedLines:expanded 分档 —— 折叠/展开各自独立槽', () => {
  const result = { text: 'x' };
  let calls = 0;
  const mk = (v) => () => { calls++; return [v]; };
  assert.deepEqual(leaf.memoFoldedLines(result, false, mk('folded'), {}), ['folded']);
  assert.deepEqual(leaf.memoFoldedLines(result, true, mk('expanded'), {}), ['expanded']);
  assert.equal(calls, 2, '两档各算一次');
  // 各档再取命中
  assert.deepEqual(leaf.memoFoldedLines(result, false, mk('X'), {}), ['folded']);
  assert.deepEqual(leaf.memoFoldedLines(result, true, mk('Y'), {}), ['expanded']);
  assert.equal(calls, 2, '两档各命中,不串味');
});

test('memoFoldedLines:门控关每次都算 · 非对象直算 · 抛错兜底 []', () => {
  const result = {};
  let calls = 0;
  const off = { KHY_TOOL_LITERAL_OUTPUT_MEMO: 'off' };
  const compute = () => { calls++; return ['L']; };
  leaf.memoFoldedLines(result, false, compute, off);
  leaf.memoFoldedLines(result, false, compute, off);
  assert.equal(calls, 2, '门控关每次都算');
  // 非对象键直算
  let c2 = 0;
  leaf.memoFoldedLines(null, false, () => { c2++; return []; }, {});
  leaf.memoFoldedLines(null, false, () => { c2++; return []; }, {});
  assert.equal(c2, 2, '非对象键不缓存');
  // 抛错兜底
  assert.deepEqual(leaf.memoFoldedLines({}, false, () => { throw new Error('x'); }, {}), []);
});

test('LIVE 接线:ToolLines.js require 叶子并包裹 preview / 折叠管线', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/cli/tui/ink-components/ToolLines.js'), 'utf8');
  assert.ok(/require\('\.\/toolLiteralOutputMemo'\)/.test(src), 'ToolLines require 叶子');
  assert.ok(/_toolLiteralOutputMemo\.memoPreview\(\s*result,/.test(src),
    'memoPreview 包 formatShellOutputJson');
  assert.ok(/_toolLiteralOutputMemo\.memoFoldedLines\(result, expanded,/.test(src),
    'memoFoldedLines 包折叠管线');
});
