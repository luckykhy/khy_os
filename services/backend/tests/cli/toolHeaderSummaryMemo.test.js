'use strict';

/**
 * toolHeaderSummaryMemo.test.js — 工具头行(显示名+入参摘要)记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - 命中:同一 tool 对象 + 同 cwd → computeFn 只调一次,返**同一 header 对象**。
 *  - cwd 守卫:cwd 变化(用户 cd) → miss 重算,杜绝陈旧相对路径。
 *  - 不同 tool 对象 → 各自计算。
 *  - **逐字节等价**:记忆值恒 === 直接调 computeFn 的值。
 *  - 非对象/假值 tool → 不缓存直算。
 *  - 门控关:每次都调 computeFn(不读/不写缓存)。
 *  - computeFn 抛错 → 兜底 { name:'', argSummary:'' },绝不抛。
 *  - LIVE 接线:ToolLines.js require 叶子、map 外取一次 _cwd、memoHeader 包 name+summarizeArgs。
 *
 * 运行:node --test services/backend/tests/cli/toolHeaderSummaryMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/toolHeaderSummaryMemo');

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_TOOL_HEADER_SUMMARY_MEMO: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_HEADER_SUMMARY_MEMO: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_HEADER_SUMMARY_MEMO: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_HEADER_SUMMARY_MEMO: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_TOOL_HEADER_SUMMARY_MEMO: 'on' }), true);
});

test('命中:同 tool + 同 cwd → computeFn 只调一次,返同一 header 引用', () => {
  const tool = { name: 'Read', input: { file_path: '/a/b.js' } };
  let calls = 0;
  const compute = () => { calls++; return { name: 'Read', argSummary: 'b.js' }; };
  const a = leaf.memoHeader(tool, '/cwd', compute, {});
  const b = leaf.memoHeader(tool, '/cwd', compute, {});
  const c = leaf.memoHeader(tool, '/cwd', compute, {});
  assert.deepEqual(a, { name: 'Read', argSummary: 'b.js' });
  assert.strictEqual(a, b, '命中返同一对象引用');
  assert.strictEqual(b, c);
  assert.equal(calls, 1, '命中不重算');
});

test('cwd 守卫:cwd 变化 → miss 重算(防陈旧相对路径)', () => {
  const tool = { name: 'Read', input: { file_path: '/x/y.js' } };
  let calls = 0;
  const mk = (v) => () => { calls++; return { name: 'Read', argSummary: v }; };
  assert.equal(leaf.memoHeader(tool, '/dir1', mk('y.js @dir1'), {}).argSummary, 'y.js @dir1');
  assert.equal(calls, 1);
  // cwd 变 → 重算
  assert.equal(leaf.memoHeader(tool, '/dir2', mk('y.js @dir2'), {}).argSummary, 'y.js @dir2');
  assert.equal(calls, 2);
  // 回到 dir2 命中(单槽存最后一次 cwd)
  assert.equal(leaf.memoHeader(tool, '/dir2', mk('X'), {}).argSummary, 'y.js @dir2');
  assert.equal(calls, 2, '同 cwd 命中不重算');
});

test('不同 tool 对象 → 各自计算并各自命中', () => {
  const t1 = { name: 'A' };
  const t2 = { name: 'B' };
  let calls = 0;
  const mk = (v) => () => { calls++; return { name: v, argSummary: '' }; };
  assert.equal(leaf.memoHeader(t1, '/c', mk('A'), {}).name, 'A');
  assert.equal(leaf.memoHeader(t2, '/c', mk('B'), {}).name, 'B');
  assert.equal(calls, 2);
  assert.equal(leaf.memoHeader(t1, '/c', mk('X'), {}).name, 'A');
  assert.equal(leaf.memoHeader(t2, '/c', mk('Y'), {}).name, 'B');
  assert.equal(calls, 2, '两 tool 各命中');
});

test('逐字节等价:记忆值 === 直接 computeFn 值', () => {
  const tool = {};
  const header = { name: 'Deterministic', argSummary: 'x=1' };
  const compute = () => header;
  const direct = compute();
  assert.strictEqual(leaf.memoHeader(tool, '/c', compute, {}), direct);
  // 命中路径也等价(输入未变即视为同结果)
  assert.strictEqual(leaf.memoHeader(tool, '/c', () => ({ name: 'OTHER', argSummary: '' }), {}), header);
});

test('非对象/假值 tool → 不缓存直算', () => {
  let calls = 0;
  const compute = () => { calls++; return { name: 'Z', argSummary: '' }; };
  assert.equal(leaf.memoHeader(null, '/c', compute, {}).name, 'Z');
  assert.equal(leaf.memoHeader(undefined, '/c', compute, {}).name, 'Z');
  assert.equal(leaf.memoHeader('str', '/c', compute, {}).name, 'Z');
  assert.equal(calls, 3, '非对象键每次直算');
});

test('门控关:每次都调 computeFn,不读写缓存', () => {
  const tool = {};
  let calls = 0;
  const off = { KHY_TOOL_HEADER_SUMMARY_MEMO: 'off' };
  const compute = () => { calls++; return { name: 'P', argSummary: '' }; };
  leaf.memoHeader(tool, '/c', compute, off);
  leaf.memoHeader(tool, '/c', compute, off);
  assert.equal(calls, 2, '门控关每次都算');
});

test('computeFn 抛错 → 兜底 { name:"", argSummary:"" },绝不抛', () => {
  const boom = () => { throw new Error('boom'); };
  assert.deepEqual(leaf.memoHeader({}, '/c', boom, {}), { name: '', argSummary: '' });
  assert.deepEqual(
    leaf.memoHeader({}, '/c', boom, { KHY_TOOL_HEADER_SUMMARY_MEMO: 'off' }),
    { name: '', argSummary: '' });
});

test('LIVE 接线:ToolLines.js require 叶子 + map 外取一次 _cwd + memoHeader 包头行', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/cli/tui/ink-components/ToolLines.js'), 'utf8');
  assert.ok(/require\('\.\/toolHeaderSummaryMemo'\)/.test(src), 'ToolLines require 叶子');
  assert.ok(/const _cwd = \(\(\) => \{ try \{ return process\.cwd\(\)/.test(src),
    'map 外只取一次 process.cwd()');
  assert.ok(/_toolHeaderSummaryMemo\.memoHeader\(t, _cwd,/.test(src),
    'memoHeader 用 (t, _cwd) 键包头行');
  assert.ok(/argSummary: summarizeArgs\(t\)/.test(src), 'computeFn 内仍调 summarizeArgs(t)');
});
