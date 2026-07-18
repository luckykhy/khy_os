'use strict';

/**
 * toolDiffRowsMemo.test.js — 已完成工具 diff 行按对象身份记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - 门控开:同一 keyObj + 同 expanded 连续多帧 → computeFn 只跑一次(命中返回同一引用)。
 *  - expanded 两档各自独立缓存(true/false 互不覆盖)。
 *  - null 也被缓存(「无可渲染 diff」是确定性结果)→ 命中不再重算。
 *  - 不同 keyObj 独立;运行中工具每帧换新对象 → 每帧 miss 重算(不取陈旧)。
 *  - 门控关 → 每帧都 computeFn(逐字节回退今日)。
 *  - 非对象键(null/字符串)→ 不缓存直算,不抛。
 *  - computeFn 抛错 → 尽力再算,绝不向上抛。
 *
 * 运行:node --test services/backend/tests/cli/toolDiffRowsMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const memo = require('../../src/cli/tui/ink-components/toolDiffRowsMemo');

const ON = {};
const OFF = { KHY_TOOL_DIFF_ROWS_MEMO: 'off' };

test('isEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(memo.isEnabled({}), true);
  assert.equal(memo.isEnabled({ KHY_TOOL_DIFF_ROWS_MEMO: 'off' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_DIFF_ROWS_MEMO: '0' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_DIFF_ROWS_MEMO: 'false' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_DIFF_ROWS_MEMO: 'no' }), false);
  assert.equal(memo.isEnabled({ KHY_TOOL_DIFF_ROWS_MEMO: 'on' }), true);
});

test('门控开:同一 keyObj+expanded 连续多帧只算一次,返回同一引用', () => {
  const key = { beforeContent: 'a', afterContent: 'b' };
  let calls = 0;
  const rows = [{ kind: 'add', text: 'x' }];
  const compute = () => { calls++; return rows; };
  const r1 = memo.memoDiffRows(key, false, compute, ON);
  const r2 = memo.memoDiffRows(key, false, compute, ON);
  const r3 = memo.memoDiffRows(key, false, compute, ON);
  assert.equal(calls, 1, '冻结 key 的多帧应只构造一次');
  assert.equal(r1, rows);
  assert.equal(r2, rows, '命中返回同一行数组引用');
  assert.equal(r3, rows);
});

test('expanded 两档各自独立缓存', () => {
  const key = { x: 1 };
  let calls = 0;
  const compute = (e) => () => { calls++; return [{ kind: 'meta', text: e ? 'exp' : 'col' }]; };
  const cCol = () => { calls++; return ['collapsed']; };
  const cExp = () => { calls++; return ['expanded']; };
  const a = memo.memoDiffRows(key, false, cCol, ON);
  const b = memo.memoDiffRows(key, true, cExp, ON);
  const a2 = memo.memoDiffRows(key, false, cCol, ON); // 命中 collapsed
  const b2 = memo.memoDiffRows(key, true, cExp, ON);  // 命中 expanded
  assert.equal(calls, 2, 'true/false 各算一次,重复命中不再算');
  assert.deepEqual(a, ['collapsed']);
  assert.deepEqual(b, ['expanded']);
  assert.equal(a2, a);
  assert.equal(b2, b);
});

test('null 结果也被缓存,命中不再重算', () => {
  const key = { same: 'same' };
  let calls = 0;
  const compute = () => { calls++; return null; };
  const r1 = memo.memoDiffRows(key, false, compute, ON);
  const r2 = memo.memoDiffRows(key, false, compute, ON);
  assert.equal(calls, 1, 'null 是确定性结果,应缓存');
  assert.equal(r1, null);
  assert.equal(r2, null);
});

test('不同 keyObj 独立;运行中工具每帧新对象 → 每帧重算', () => {
  let calls = 0;
  const compute = () => { calls++; return [{ kind: 'add', text: String(calls) }]; };
  memo.memoDiffRows({ a: 1 }, false, compute, ON); // 新对象
  memo.memoDiffRows({ a: 1 }, false, compute, ON); // 又一个新对象(内容同但引用不同)
  memo.memoDiffRows({ a: 1 }, false, compute, ON);
  assert.equal(calls, 3, '每帧换新 result 对象应每帧 miss 重算,绝不取陈旧');
});

test('门控关:每帧都 computeFn(逐字节回退)', () => {
  const key = { frozen: true };
  let calls = 0;
  const compute = () => { calls++; return ['r']; };
  memo.memoDiffRows(key, false, compute, OFF);
  memo.memoDiffRows(key, false, compute, OFF);
  memo.memoDiffRows(key, false, compute, OFF);
  assert.equal(calls, 3, '门控关应每帧直算不缓存');
});

test('非对象键(null/字符串)→ 不缓存直算,不抛', () => {
  let calls = 0;
  const compute = () => { calls++; return ['r']; };
  assert.deepEqual(memo.memoDiffRows(null, false, compute, ON), ['r']);
  assert.deepEqual(memo.memoDiffRows('str', false, compute, ON), ['r']);
  assert.deepEqual(memo.memoDiffRows(undefined, false, compute, ON), ['r']);
  assert.equal(calls, 3, '非对象键每次直算');
});

test('computeFn 抛错 → 尽力再算,绝不向上抛', () => {
  const key = { k: 1 };
  let attempts = 0;
  const throwing = () => { attempts++; throw new Error('boom'); };
  // 不应抛;返回值为 null(catch 内二次 computeFn 仍抛 → 兜底 null)。
  let result;
  assert.doesNotThrow(() => { result = memo.memoDiffRows(key, false, throwing, ON); });
  assert.equal(result, null, '两次都抛 → 兜底返回 null');
});
