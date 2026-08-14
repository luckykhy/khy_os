'use strict';

// ccFormatCost / ccFormatCostOr 契约测试 — 纯叶子。对齐 CC
// src/cost-tracker.ts::formatCost 的**幅度自适应精度**后端逻辑:
//   cost > 0.5 → round(cost,100).toFixed(2) (2 位);cost ≤ 0.5 → toFixed(4)。
// 货币符号由调用方拼,本叶子只产纯数字串。零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const ccf = require('../../src/cli/ccFormat');

test('ccFormatCost:大额(>0.5)→ 2 位角分精度', () => {
  assert.strictEqual(ccf.ccFormatCost(1.2345), '1.23');
  assert.strictEqual(ccf.ccFormatCost(123.456), '123.46'); // round(123.456,100)=123.46
  assert.strictEqual(ccf.ccFormatCost(2.5), '2.50');
});

test('ccFormatCost:0.5 边界(恰 0.5 不算 >0.5)→ 4 位', () => {
  assert.strictEqual(ccf.ccFormatCost(0.5), '0.5000');
});

test('ccFormatCost:微额(≤0.5)→ 默认 4 位(保留亚分)', () => {
  assert.strictEqual(ccf.ccFormatCost(0.0042), '0.0042');
  assert.strictEqual(ccf.ccFormatCost(0.005), '0.0050'); // 防止塌成 0
  assert.strictEqual(ccf.ccFormatCost(0.1), '0.1000');
});

test('ccFormatCost:maxDecimalPlaces 覆盖(仅影响微额档)', () => {
  assert.strictEqual(ccf.ccFormatCost(0.0042, 2), '0.00');
  assert.strictEqual(ccf.ccFormatCost(0.0042, 6), '0.004200');
});

test('ccFormatCost:与 CC 表达式逐值一致(round-to-cents)', () => {
  const round = (n, p) => Math.round(n * p) / p;
  const cc = (cost, mdp = 4) => (cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(mdp));
  for (const v of [0, 0.0001, 0.01, 0.5, 0.50001, 0.99, 1, 7.255, 42.005, 1000.999]) {
    assert.strictEqual(ccf.ccFormatCost(v), cc(v), `值 ${v} 应与 CC 一致`);
  }
});

test('ccFormatCost:防呆 — 非有限 / 负 → 空串', () => {
  assert.strictEqual(ccf.ccFormatCost(NaN), '');
  assert.strictEqual(ccf.ccFormatCost(Infinity), '');
  assert.strictEqual(ccf.ccFormatCost(-1), '');
  assert.strictEqual(ccf.ccFormatCost('abc'), '');
  assert.strictEqual(ccf.ccFormatCost(null), '');
});

test('ccFormatCost:非法 maxDecimalPlaces 回退 4', () => {
  assert.strictEqual(ccf.ccFormatCost(0.0042, NaN), '0.0042');
  assert.strictEqual(ccf.ccFormatCost(0.0042, -2), '0.0042');
});

test('ccFormatCostOr:门控开 → 返回 CC 自适应精度', () => {
  assert.strictEqual(ccf.ccFormatCostOr(1.2345, 'LEGACY', {}), '1.23');
  assert.strictEqual(ccf.ccFormatCostOr(0.0042, 'LEGACY', { KHY_CC_FORMAT: 'on' }), '0.0042');
});

test('ccFormatCostOr:门控关 → 逐字节返回 legacy', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      ccf.ccFormatCostOr(1.2345, '9.9999', { KHY_CC_FORMAT: off }),
      '9.9999',
      `门控关(${off})应回退 legacy`,
    );
  }
});

test('ccFormatCostOr:门控开但非有限 → 回退 legacy(out 空)', () => {
  assert.strictEqual(ccf.ccFormatCostOr(NaN, 'LEGACY', {}), 'LEGACY');
  assert.strictEqual(ccf.ccFormatCostOr(-5, 'LEGACY', {}), 'LEGACY');
});
