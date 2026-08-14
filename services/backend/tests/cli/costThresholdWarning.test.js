'use strict';

// costThresholdWarning 契约测试 — 纯叶子(会话花费阈值一次性警告)。对齐 CC
// src/components/CostThresholdDialog.tsx 的背后逻辑:累计会话 API 花费首次越过
// 阈值(CC 硬编码 $5)时一次性提醒。零 IO 零网络,一次性由调用方 alreadyWarned 守。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/costThresholdWarning');

test('costThresholdWarningEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.costThresholdWarningEnabled({}), true);
  assert.strictEqual(leaf.costThresholdWarningEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      leaf.costThresholdWarningEnabled({ KHY_COST_THRESHOLD_WARNING: off }),
      false,
      `应关: ${off}`,
    );
  }
});

test('getCostThreshold:默认 5,env 覆盖须 > 0 否则回退', () => {
  assert.strictEqual(leaf.getCostThreshold({}), 5);
  assert.strictEqual(leaf.DEFAULT_COST_THRESHOLD_USD, 5);
  assert.strictEqual(leaf.getCostThreshold({ KHY_COST_THRESHOLD_USD: '10' }), 10);
  assert.strictEqual(leaf.getCostThreshold({ KHY_COST_THRESHOLD_USD: '0.5' }), 0.5);
  assert.strictEqual(leaf.getCostThreshold({ KHY_COST_THRESHOLD_USD: '0' }), 5, '<=0 回退');
  assert.strictEqual(leaf.getCostThreshold({ KHY_COST_THRESHOLD_USD: '-3' }), 5, '负数回退');
  assert.strictEqual(leaf.getCostThreshold({ KHY_COST_THRESHOLD_USD: 'x' }), 5, '非数回退');
});

test('buildCostThresholdLine:含实际花费(两位小数)与阈值,并指向 /cost', () => {
  const line = leaf.buildCostThresholdLine({ sessionCostUSD: 5.234, threshold: 5 });
  assert.match(line, /\$5\.23/, '实际花费两位小数');
  assert.match(line, /\$5\.00/, '阈值两位小数');
  assert.match(line, /\/cost/, '指向 /cost');
});

test('buildCostThresholdLine:CC 幅度自适应精度(>$0.5→2位·≤$0.5→4位)与 ccFormatCost 一致', () => {
  const ccFmt = require('../../src/cli/ccFormat');
  // 大额:2 位小数
  assert.match(leaf.buildCostThresholdLine({ sessionCostUSD: 12.5, threshold: 5 }), /\$12\.50/);
  // 小额阈值($0.30):4 位小数(对齐 CC 让 sub-cent 阈值仍可读)
  const small = leaf.buildCostThresholdLine({ sessionCostUSD: 0.42, threshold: 0.3 });
  assert.match(small, /\$0\.4200/, '≤$0.5 用 4 位');
  assert.match(small, /\$0\.3000/, '阈值 ≤$0.5 用 4 位');
  // 与 canonical ccFormatCost 逐字节对齐(门控开)
  const env = { KHY_CC_FORMAT: '1' };
  assert.strictEqual('$' + ccFmt.ccFormatCost(0.42), '$0.4200');
  assert.strictEqual('$' + ccFmt.ccFormatCost(12.5), '$12.50');
});

test('costThresholdFor:未达阈值 → null(不警告)', () => {
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: 4.99, alreadyWarned: false }, {}), null);
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: 0, alreadyWarned: false }, {}), null);
});

test('costThresholdFor:首次越阈 → { text }(对齐 CC 首次越过 $5)', () => {
  const r = leaf.costThresholdFor({ sessionCostUSD: 5.01, alreadyWarned: false }, {});
  assert.ok(r && typeof r.text === 'string', '应返回 text');
  assert.match(r.text, /\$5\.01/);
});

test('costThresholdFor:边界 == 阈值即触发(>= 语义)', () => {
  const r = leaf.costThresholdFor({ sessionCostUSD: 5, alreadyWarned: false }, {});
  assert.ok(r && r.text, '恰好等于阈值应触发');
});

test('costThresholdFor:已警告过 → null(一次性,对齐 hasShownCostDialog)', () => {
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: 99, alreadyWarned: true }, {}), null);
});

test('costThresholdFor:门控关 → null(逐字节 no-op 回退)', () => {
  assert.strictEqual(
    leaf.costThresholdFor({ sessionCostUSD: 99, alreadyWarned: false }, { KHY_COST_THRESHOLD_WARNING: '0' }),
    null,
  );
});

test('costThresholdFor:自定义阈值($10)', () => {
  const env = { KHY_COST_THRESHOLD_USD: '10' };
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: 9.99, alreadyWarned: false }, env), null, '未达 10');
  const r = leaf.costThresholdFor({ sessionCostUSD: 10.5, alreadyWarned: false }, env);
  assert.ok(r && r.text, '越过 10 触发');
  assert.match(r.text, /\$10\.00/, '阈值显示 10');
});

test('costThresholdFor:花费非有限数 → null(不臆造)', () => {
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: null, alreadyWarned: false }, {}), null);
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: NaN, alreadyWarned: false }, {}), null);
  assert.strictEqual(leaf.costThresholdFor({ sessionCostUSD: 'abc', alreadyWarned: false }, {}), null);
});

test('costThresholdFor:坏输入/无 input → null(fail-soft)', () => {
  assert.strictEqual(leaf.costThresholdFor(undefined, {}), null);
  assert.strictEqual(leaf.costThresholdFor(null, {}), null);
  assert.strictEqual(leaf.costThresholdFor({}, {}), null);
});
