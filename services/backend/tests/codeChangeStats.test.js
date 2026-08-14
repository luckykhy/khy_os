'use strict';

// codeChangeStats 叶子契约测试(node:test)。
// 覆盖:门控开关、countEditChurn 净增/净删公式(行语义)、collectUncountedChurn 幂等
// (只计未打标的成功 Edit/Write、失败/去重/循环拦截不计、Write 只增不减)、
// buildCodeChangesValue 文案(无改动 → '')、空/非法输入 → 零、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  codeChangesEnabled,
  countEditChurn,
  collectUncountedChurn,
  buildCodeChangesValue,
} = require('../src/services/codeChangeStats');

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(codeChangesEnabled({}), true);
  assert.strictEqual(codeChangesEnabled({ KHY_CODE_CHANGES: '' }), true);
  assert.strictEqual(codeChangesEnabled({ KHY_CODE_CHANGES: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(codeChangesEnabled({ KHY_CODE_CHANGES: off }), false, off);
  }
});

test('countEditChurn 净增/净删(行语义)', () => {
  // 3 行 → 5 行:净 +2 / -0
  assert.deepStrictEqual(countEditChurn('a\nb\nc', 'a\nb\nc\nd\ne'), { added: 2, removed: 0 });
  // 5 行 → 2 行:净 +0 / -3
  assert.deepStrictEqual(countEditChurn('a\nb\nc\nd\ne', 'x\ny'), { added: 0, removed: 3 });
  // 同行数:0/0
  assert.deepStrictEqual(countEditChurn('a\nb', 'x\ny'), { added: 0, removed: 0 });
  // 空 old(纯插入):新增 = 新行数
  assert.deepStrictEqual(countEditChurn('', 'a\nb\nc'), { added: 3, removed: 0 });
  // 非字符串输入 → 不抛
  assert.deepStrictEqual(countEditChurn(null, undefined), { added: 0, removed: 0 });
});

test('collectUncountedChurn 汇总成功 Edit 净增删,回传 counted', () => {
  const log = [
    { tool: 'edit_file', params: { old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, result: { success: true } },
    { tool: 'Edit', params: { oldString: 'x\ny\nz', newString: 'x' }, result: { success: true } },
  ];
  const r = collectUncountedChurn(log);
  assert.strictEqual(r.added, 2);   // 第一条 +2
  assert.strictEqual(r.removed, 2); // 第二条 -2
  assert.strictEqual(r.counted.length, 2);
});

test('幂等:已打 _khyChurnCounted 的条目跳过', () => {
  const log = [
    { tool: 'edit', params: { old_string: '', new_string: 'a\nb\nc' }, result: { success: true }, _khyChurnCounted: true },
    { tool: 'edit', params: { old_string: '', new_string: 'x\ny' }, result: { success: true } },
  ];
  const r = collectUncountedChurn(log);
  assert.strictEqual(r.added, 2);          // 只计第二条(2 行)
  assert.strictEqual(r.counted.length, 1); // 只回传未打标的那条
  assert.strictEqual(r.counted[0], log[1]);
});

test('失败 / 去重 / 循环拦截的 Edit 不计入,但失败项仍被消费(打标)', () => {
  const failed = { tool: 'edit', params: { old_string: '', new_string: 'a\nb\nc' }, result: { success: false } };
  const deduped = { tool: 'edit', params: { old_string: '', new_string: 'a\nb' }, result: { _deduped: true } };
  const looped = { tool: 'edit', params: { old_string: '', new_string: 'a' }, result: { _loopDetected: true } };
  const r = collectUncountedChurn([failed, deduped, looped]);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.removed, 0);
  // 失败/去重/循环项被消费打标(counted),避免下轮重复扫描误计。
  assert.strictEqual(r.counted.length, 3);
});

test('Write 按写入行数计入新增(只增不减);优先 _khyWriteDiff.afterContent', () => {
  const log = [
    { tool: 'write_file', params: { content: 'ignored' }, result: { success: true, _khyWriteDiff: { afterContent: 'l1\nl2\nl3\nl4' } } },
    { tool: 'Write', params: { content: 'p1\np2' }, result: { success: true } },
  ];
  const r = collectUncountedChurn(log);
  assert.strictEqual(r.added, 6);   // 4(diff)+ 2(params.content)
  assert.strictEqual(r.removed, 0); // 覆盖写只增不减
});

test('非改动工具(read/bash)不计、不消费', () => {
  const log = [
    { tool: 'read_file', params: { path: '/x' }, result: { success: true } },
    { tool: 'bash', params: { command: 'ls' }, result: { success: true } },
  ];
  const r = collectUncountedChurn(log);
  assert.strictEqual(r.added, 0);
  assert.strictEqual(r.removed, 0);
  assert.strictEqual(r.counted.length, 0); // 未消费:非改动工具不打标
});

test('collectUncountedChurn 不改写输入条目(叶子零副作用,打标交给壳)', () => {
  const entry = { tool: 'edit', params: { old_string: '', new_string: 'a\nb' }, result: { success: true } };
  collectUncountedChurn([entry]);
  assert.strictEqual(entry._khyChurnCounted, undefined);
});

test('空 / 非数组输入 → 零、绝不抛', () => {
  for (const bad of [null, undefined, {}, 42, 'x']) {
    const r = collectUncountedChurn(bad);
    assert.deepStrictEqual({ added: r.added, removed: r.removed, n: r.counted.length }, { added: 0, removed: 0, n: 0 });
  }
});

test('buildCodeChangesValue:有改动 → 文案;无改动 → 空串', () => {
  assert.strictEqual(buildCodeChangesValue(128, 34), '128 行新增 · 34 行删除');
  assert.strictEqual(buildCodeChangesValue(5, 0), '5 行新增 · 0 行删除');
  assert.strictEqual(buildCodeChangesValue(0, 3), '0 行新增 · 3 行删除');
  assert.strictEqual(buildCodeChangesValue(0, 0), '');
  assert.strictEqual(buildCodeChangesValue(-1, -2), '');
  assert.strictEqual(buildCodeChangesValue('x', null), '');
  // 千分位
  assert.strictEqual(buildCodeChangesValue(1234, 0), '1,234 行新增 · 0 行删除');
});
