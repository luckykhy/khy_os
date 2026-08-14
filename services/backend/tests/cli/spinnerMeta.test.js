'use strict';

// spinner byline reveal-gate 契约测试:纯叶子。对齐 CC SpinnerAnimationRow
// 的 SHOW_TOKENS_AFTER_MS(30s)逻辑——前 30s 只显动词,30s 后才露
// 计时+token byline;effort 后缀不受 30s 门控。零网络零 IO。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/spinnerMeta');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_SPINNER_META_GATE: off }), false, `应关: ${off}`);
  }
});

test('shouldShowTimerAndTokens:前 30s 隐藏,过 30s 显示', () => {
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 0, gateEnabled: true }), false);
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 30000, gateEnabled: true }), false, '恰 30000 不算 >');
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 30001, gateEnabled: true }), true);
});

test('shouldShowTimerAndTokens:verbose / teammates 立即显示', () => {
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 0, verbose: true, gateEnabled: true }), true);
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 0, hasTeammates: true, gateEnabled: true }), true);
});

test('shouldShowTimerAndTokens:门控关 → 恒显示(字节回退)', () => {
  assert.strictEqual(leaf.shouldShowTimerAndTokens({ elapsedMs: 0, gateEnabled: false }), true);
});

test('buildStatusParts:前 30s 只留 effort,隐藏计时+token', () => {
  const parts = leaf.buildStatusParts({
    timerText: '5s', inputTokensText: '↑ 1.2k tokens', outputTokensText: '↓ 800 tokens',
    effortText: 'extended thinking · high', elapsedMs: 5000, gateEnabled: true,
  });
  assert.deepStrictEqual(parts, ['extended thinking · high']);
});

test('buildStatusParts:30s 后露全 byline(顺序 timer,in,out,effort)', () => {
  const parts = leaf.buildStatusParts({
    timerText: '35s', inputTokensText: '↑ 1.2k tokens', outputTokensText: '↓ 800 tokens',
    effortText: 'high', elapsedMs: 35000, gateEnabled: true,
  });
  assert.deepStrictEqual(parts, ['35s', '↑ 1.2k tokens', '↓ 800 tokens', 'high']);
});

test('buildStatusParts:前 30s 无 effort → 空数组(只显动词,无空括号)', () => {
  const parts = leaf.buildStatusParts({
    timerText: '5s', inputTokensText: '', outputTokensText: '', effortText: '',
    elapsedMs: 5000, gateEnabled: true,
  });
  assert.deepStrictEqual(parts, []);
});

test('buildStatusParts:门控关 → 恒含 timer + 现有 token(字节回退,顺序同 legacy)', () => {
  const parts = leaf.buildStatusParts({
    timerText: '5s', inputTokensText: '↑ 1.2k tokens', outputTokensText: '',
    effortText: '', elapsedMs: 5000, gateEnabled: false,
  });
  assert.deepStrictEqual(parts, ['5s', '↑ 1.2k tokens']);
});

test('buildStatusParts:空 token 文本被丢弃(只 push 非空)', () => {
  const parts = leaf.buildStatusParts({
    timerText: '40s', inputTokensText: '', outputTokensText: '↓ 5 tokens',
    effortText: '', elapsedMs: 40000, gateEnabled: true,
  });
  assert.deepStrictEqual(parts, ['40s', '↓ 5 tokens']);
});
