'use strict';

// costByModel 叶子契约测试(node:test)。
// 覆盖:门控开关、按模型归组(注入 labelFn)、排序(cost 降→total 降→label 升)、
// cache-less 诚实(只 input/output/total/cost/requests 五键)、空/非法 → []、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const { costByModelEnabled, aggregateSessionUsageByModel } = require('../src/services/costByModel');

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(costByModelEnabled({}), true);
  assert.strictEqual(costByModelEnabled({ KHY_COST_BY_MODEL: '' }), true);
  assert.strictEqual(costByModelEnabled({ KHY_COST_BY_MODEL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(costByModelEnabled({ KHY_COST_BY_MODEL: off }), false, JSON.stringify(off));
  }
});

test('aggregateSessionUsageByModel: 按模型归组并累加', () => {
  const records = [
    { model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 20, total: 120, costUSD: 0.30 },
    { model: 'claude-opus-4-8', inputTokens: 50, outputTokens: 10, total: 60, costUSD: 0.10 },
    { model: 'claude-haiku-4-5', inputTokens: 200, outputTokens: 5, total: 205, costUSD: 0.05 },
  ];
  const rows = aggregateSessionUsageByModel(records); // 默认 labelFn 恒等 → 按 raw slug 归组
  const opus = rows.find((r) => r.label === 'claude-opus-4-8');
  const haiku = rows.find((r) => r.label === 'claude-haiku-4-5');
  assert.deepStrictEqual(
    { input: opus.input, output: opus.output, total: opus.total, cost: Math.round(opus.cost * 100) / 100, requests: opus.requests },
    { input: 150, output: 30, total: 180, cost: 0.40, requests: 2 },
  );
  assert.strictEqual(haiku.input, 200);
  assert.strictEqual(haiku.requests, 1);
});

test('aggregateSessionUsageByModel: 注入 labelFn 折叠到友好显示名', () => {
  const labelFn = (m) => (String(m).startsWith('claude-opus') ? 'Opus 4.8' : m);
  const rows = aggregateSessionUsageByModel([
    { model: 'claude-opus-4-8', inputTokens: 10, costUSD: 0.1 },
    { model: 'claude-opus-4-8-1m', inputTokens: 5, costUSD: 0.2 }, // 两个 raw 折叠到同一友好名
  ], labelFn);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].label, 'Opus 4.8');
  assert.strictEqual(rows[0].input, 15);
  assert.strictEqual(rows[0].requests, 2);
});

test('aggregateSessionUsageByModel: 排序 cost 降 → total 降 → label 升', () => {
  const rows = aggregateSessionUsageByModel([
    { model: 'a', inputTokens: 1, costUSD: 0.1 },
    { model: 'b', inputTokens: 1, costUSD: 0.5 },
    { model: 'c', inputTokens: 1, costUSD: 0.5 }, // 与 b 同 cost 同 total → 按 label 升 b<c
  ]);
  assert.deepStrictEqual(rows.map((r) => r.label), ['b', 'c', 'a']);
});

test('aggregateSessionUsageByModel: cache-less 诚实 — 只五键,不含 cache 列', () => {
  const rows = aggregateSessionUsageByModel([{ model: 'x', inputTokens: 1, outputTokens: 2, costUSD: 0.01 }]);
  assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['cost', 'input', 'label', 'output', 'requests', 'total'].sort());
});

test('aggregateSessionUsageByModel: total 缺失时由 input+output 派生', () => {
  const rows = aggregateSessionUsageByModel([{ model: 'x', inputTokens: 7, outputTokens: 3, costUSD: 0 }]);
  assert.strictEqual(rows[0].total, 10);
});

test('aggregateSessionUsageByModel: 缺 model → (unknown) 归组', () => {
  const rows = aggregateSessionUsageByModel([{ inputTokens: 5, costUSD: 0 }, { model: '  ', inputTokens: 5, costUSD: 0 }]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].label, '(unknown)');
  assert.strictEqual(rows[0].requests, 2);
});

test('aggregateSessionUsageByModel: 空/非法输入 → [](绝不抛)', () => {
  assert.deepStrictEqual(aggregateSessionUsageByModel([]), []);
  assert.deepStrictEqual(aggregateSessionUsageByModel(null), []);
  assert.deepStrictEqual(aggregateSessionUsageByModel(undefined), []);
  assert.deepStrictEqual(aggregateSessionUsageByModel('nope'), []);
  assert.doesNotThrow(() => aggregateSessionUsageByModel([null, 1, 'x', {}]));
  // labelFn 抛出 → 回退 raw model,不冒泡
  const rows = aggregateSessionUsageByModel([{ model: 'm', inputTokens: 1, costUSD: 0 }], () => { throw new Error('boom'); });
  assert.strictEqual(rows[0].label, 'm');
});
