'use strict';

/**
 * promptCaretMarginMemo.test.js — 补全下拉 caret 边距单槽记忆(纯叶子,node:test)。
 *
 * 关键不变量:
 *  - 门控:默认 on;off/0/false/no 关。
 *  - 命中:(value,offset,cols) 三者严格相等 → 复用上次 margin,computeFn 不再调用。
 *  - 未命中:任一输入变化 → 重算 + 存槽。
 *  - **逐字节等价**:记忆值恒 === 直接调 computeFn 的值(单槽只是跳过重复计算)。
 *  - 门控关:每次都调 computeFn(不读/不写槽)。
 *  - computeFn 抛错 → 兜底(门控关再抛 → 0),绝不抛。
 *
 * 运行:node --test services/backend/tests/cli/promptCaretMarginMemo.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/tui/ink-components/promptCaretMarginMemo');

function fresh() { leaf._reset(); }

test('isEnabled:默认 on;off/0/false/no 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_MARGIN_MEMO: 'off' }), false);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_MARGIN_MEMO: '0' }), false);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_MARGIN_MEMO: 'false' }), false);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_MARGIN_MEMO: 'no' }), false);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_MARGIN_MEMO: 'on' }), true);
});

test('命中:三输入不变 → computeFn 只调一次,复用同值', () => {
  fresh();
  let calls = 0;
  const compute = () => { calls++; return 7; };
  const a = leaf.memoCompletionMargin('/help', 5, 80, compute, {});
  const b = leaf.memoCompletionMargin('/help', 5, 80, compute, {});
  const c = leaf.memoCompletionMargin('/help', 5, 80, compute, {});
  assert.equal(a, 7);
  assert.equal(b, 7);
  assert.equal(c, 7);
  assert.equal(calls, 1, '命中不重算');
});

test('未命中:value/offset/cols 任一变化 → 重算', () => {
  fresh();
  let calls = 0;
  const compute = (v) => () => { calls++; return v; };
  leaf.memoCompletionMargin('@a', 2, 80, compute(1), {});
  assert.equal(calls, 1);
  leaf.memoCompletionMargin('@ab', 3, 80, compute(2), {}); // value+offset 变
  assert.equal(calls, 2);
  leaf.memoCompletionMargin('@ab', 3, 120, compute(3), {}); // cols 变
  assert.equal(calls, 3);
  leaf.memoCompletionMargin('@ab', 3, 120, compute(9), {}); // 全不变 → 命中
  assert.equal(calls, 3, '全不变命中不重算');
});

test('逐字节等价:记忆值恒 === 直接 computeFn 值', () => {
  fresh();
  const compute = () => 13;
  const direct = compute();
  const memoized = leaf.memoCompletionMargin('x', 0, 80, compute, {});
  assert.equal(memoized, direct);
  // 命中路径也等价
  assert.equal(leaf.memoCompletionMargin('x', 0, 80, () => 999, {}), 13, '命中返旧值(输入未变即视为同结果)');
});

test('门控关:每次都调 computeFn,不读写槽', () => {
  fresh();
  let calls = 0;
  const off = { KHY_COMPLETION_MARGIN_MEMO: 'off' };
  const compute = () => { calls++; return 4; };
  assert.equal(leaf.memoCompletionMargin('s', 1, 80, compute, off), 4);
  assert.equal(leaf.memoCompletionMargin('s', 1, 80, compute, off), 4);
  assert.equal(calls, 2, '门控关每次都算');
});

test('computeFn 抛错 → 门控关再抛 → 兜底 0,绝不抛', () => {
  fresh();
  const boom = () => { throw new Error('boom'); };
  // 门控开:命中前 computeFn 抛 → catch → 再调 computeFn 又抛 → 0
  assert.equal(leaf.memoCompletionMargin('e', 0, 80, boom, {}), 0);
  // 门控关:直接 computeFn 抛 → catch → 再抛 → 0
  assert.equal(leaf.memoCompletionMargin('e', 0, 80, boom, { KHY_COMPLETION_MARGIN_MEMO: 'off' }), 0);
});

test('LIVE 接线:App.js 用 memoCompletionMargin 包裹 caret 边距计算', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/cli/tui/ink-components/App.js'), 'utf8');
  assert.ok(/require\('\.\/promptCaretMarginMemo'\)/.test(src), 'App.js require 叶子');
  assert.ok(/_caretMarginMemo\.memoCompletionMargin\(value, offset, _cols, _computeMargin/.test(src),
    'App.js 用 memoCompletionMargin 包裹 (value,offset,cols) 计算');
  assert.ok(/_caretMarginMemo\s*\?[\s\S]*?:\s*_computeMargin\(\)/.test(src),
    'App.js 门控/缺叶子回退直接 _computeMargin()');
});
