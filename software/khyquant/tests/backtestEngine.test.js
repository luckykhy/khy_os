'use strict';
/**
 * backtestEngine 单元测试（node:test）。
 * 验证 A股执行现实性三件套（[MGMT-RPT-026] P0 落地）：
 *   1. T+1 结算锁定 —— 当日买入份额不可当日卖出
 *   2. 交易成本模型 —— 佣金 + 印花税（仅卖出）+ 滑点
 *   3. 结果指纹 —— 确定性 SHA-1（freqtrade 风格）
 *
 * 运行：node --test software/khyquant/tests/backtestEngine.test.js
 *
 * 数据层（klineDataService / comprehensiveDataService）通过 require.cache
 * 预置桩模块注入，避免触发真实数据源（AKShare/AData/mock 生成）。
 * 注意：backtestEngine 顶部用顶层 require 捕获两个数据服务，因此每个
 * 子测试前须先注入桩、再 delete require.cache[engine] 强制重新 require。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE_PATH = path.join(ROOT, 'services', 'backtestEngine.js');
const KLINE_PATH = path.join(ROOT, 'services', 'klineDataService.js');
const COMPREHENSIVE_PATH = path.join(ROOT, 'services', 'comprehensiveDataService.js');

const BARS = [
  { date: '2024-01-01', open: 10, high: 11, low: 9, close: 10, volume: 1000 },
  { date: '2024-01-02', open: 10, high: 12, low: 10, close: 11, volume: 1000 },
  { date: '2024-01-03', open: 11, high: 12, low: 11, close: 12, volume: 1000 },
];

function stubDataModules() {
  const stub = {
    getKlineData: async () => ({ kline: BARS }),
    getComprehensiveData: async () => ({ kline: BARS }),
  };
  require.cache[KLINE_PATH] = {
    id: KLINE_PATH,
    filename: KLINE_PATH,
    loaded: true,
    exports: stub,
  };
  require.cache[COMPREHENSIVE_PATH] = {
    id: COMPREHENSIVE_PATH,
    filename: COMPREHENSIVE_PATH,
    loaded: true,
    exports: stub,
  };
}

function loadEngine() {
  delete require.cache[ENGINE_PATH];
  return require(ENGINE_PATH);
}

// ── Pure helpers (no data loading) ──────────────────────────────────────────

test('resolveCosts: defaults match strategyEngine A-share conventions', () => {
  const e = loadEngine();
  const c = e.resolveCosts({});
  assert.strictEqual(c.tPlus1, true, 'T+1 defaults on for A-share');
  assert.strictEqual(c.commissionRate, 0.0003, 'commission 0.0003');
  assert.strictEqual(c.stampDutyRate, 0.001, 'stamp duty 0.001 (sell only)');
  assert.strictEqual(c.slippage, 0.001, 'slippage 0.001');
});

test('resolveCosts: numeric overrides apply, unspecified keep defaults', () => {
  const e = loadEngine();
  const c = e.resolveCosts({ commissionRate: 0.0005, tPlus1: false });
  assert.strictEqual(c.commissionRate, 0.0005, 'commission overridden');
  assert.strictEqual(c.tPlus1, false, 'T+1 can be disabled');
  assert.strictEqual(c.stampDutyRate, 0.001, 'stamp duty kept');
});

test('buildFingerprint: deterministic and input-sensitive', () => {
  const e = loadEngine();
  const base = {
    signalCode: 'function strategy(d,p){return []}',
    params: { fast: 5 },
    symbol: '600000.SH',
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    costs: e.resolveCosts({}),
  };
  const a = e.buildFingerprint(base);
  const b = e.buildFingerprint({ ...base });
  assert.strictEqual(a, b, 'same inputs → same fingerprint');
  assert.strictEqual(a.length, 16, '16-hex-char fingerprint');

  const changed = e.buildFingerprint({ ...base, signalCode: 'function strategy(d,p){return [1]}' });
  assert.notStrictEqual(a, changed, 'code change → different fingerprint');

  const changedParams = e.buildFingerprint({ ...base, params: { fast: 10 } });
  assert.notStrictEqual(a, changedParams, 'param change → different fingerprint');

  const changedCosts = e.buildFingerprint({ ...base, costs: e.resolveCosts({ tPlus1: false }) });
  assert.notStrictEqual(a, changedCosts, 'cost-model change → different fingerprint');
});

// ── Full run() with stubbed data (T+1 + cost semantics) ────────────────────

test('T+1: same-day buy is locked until the next bar', async () => {
  stubDataModules();
  const e = loadEngine();

  // Strategy: buy on bar 0, signal sell on bar 1 (shares just unlocked),
  // force-close on the final bar.
  const sig = (bar, i) => {
    if (i === 0) return 'buy';
    if (i === 1) return 'sell';
    return null;
  };

  // T+1: the explicit sell happens on bar 1 (the buy bar is locked).
  const withT1 = await e.run({
    symbol: 'T1STUB', startDate: '2024-01-01', endDate: '2024-01-03',
    initialCapital: 10000, signalFn: sig, params: {}, tPlus1: true,
  });
  const sells = withT1.trades.filter((t) => t.side === 'sell' && !t.forced);
  assert.strictEqual(sells.length, 1, 'one explicit sell under T+1');
  assert.strictEqual(sells[0].date, BARS[1].date, 'sell happened on the bar after the buy');
  assert.ok(
    !withT1.trades.some((t) => t.side === 'sell' && t.date === BARS[0].date),
    'no sell on the buy bar under T+1 (same-day purchase is locked)'
  );
});

test('costs: sell-side stamp duty + both-side commission reduce final capital', async () => {
  stubDataModules();
  const e = loadEngine();

  const sig = (bar, i) => (i === 0 ? 'buy' : i === 1 ? 'sell' : null);

  // With zero costs the final capital is higher than with full A-share costs.
  const free = await e.run({
    symbol: 'FREE', startDate: '2024-01-01', endDate: '2024-01-03',
    initialCapital: 100000, signalFn: sig, params: {},
    commissionRate: 0, stampDutyRate: 0, slippage: 0,
  });
  const costly = await e.run({
    symbol: 'COSTLY', startDate: '2024-01-01', endDate: '2024-01-03',
    initialCapital: 100000, signalFn: sig, params: {},
    commissionRate: 0.0003, stampDutyRate: 0.001, slippage: 0.001,
  });

  assert.ok(
    costly.finalCapital < free.finalCapital,
    `costly final (${costly.finalCapital}) < free final (${free.finalCapital})`
  );
  // Trades carry the fee fields.
  const buy = costly.trades.find((t) => t.side === 'buy');
  const sell = costly.trades.find((t) => t.side === 'sell' && !t.forced);
  assert.ok(buy.commission > 0, 'buy side has commission');
  assert.strictEqual(buy.stampDuty, undefined, 'no stamp duty on buy');
  assert.ok(sell.stampDuty > 0, 'sell side has stamp duty');
  assert.ok(sell.commission > 0, 'sell side has commission');
  // Execution metadata recorded for reproducibility.
  assert.strictEqual(costly.execution.tPlus1, true, 'T+1 on by default');
  assert.strictEqual(costly.execution.stampDutyRate, 0.001);
  // Cost aggregates surface at both top level and inside execution metadata.
  assert.ok(costly.totalCommission > 0, 'top-level totalCommission');
  assert.ok(costly.totalStampDuty > 0, 'top-level totalStampDuty');
  assert.ok(costly.totalSlippageCost > 0, 'top-level totalSlippageCost');
  // result object carries a fingerprint.
  assert.strictEqual(typeof costly.fingerprint, 'string');
  assert.strictEqual(costly.fingerprint.length, 16);
});
