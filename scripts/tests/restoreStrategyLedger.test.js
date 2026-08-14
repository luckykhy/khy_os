'use strict';

/**
 * restoreStrategyLedger.test.js — 还原「策略台账 / cross-session learning」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreStrategyLedger.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量（安全优先）：
 *   · 一次推进即永远 productive（一次成功洗清所有失败，绝不误伤）；
 *   · dead 门槛=跨 ≥MIN_SAMPLES 个独立会话次次卡住且从未推进（防单次运气差拉黑）；
 *   · 空/畸形 → 空台账、绝不凭空拉黑；只产 skip 建议，绝不重排安全序。
 */

const test = require('node:test');
const assert = require('node:assert');

const L = require('../lib/restoreStrategyLedger');
const {
  deriveStrategyLedger,
  MIN_SAMPLES,
  CLASS_PRODUCTIVE, CLASS_DEAD, CLASS_UNPROVEN,
} = L;

// ── 事件工厂（模拟 restoreTraceJournal.buildEvent 的产物形状）──────────────────

function ev(strategy, verdict, stop) {
  return { strategy, verdict, stop: stop || (verdict === 'converged' ? 'converged-stop' : 'continue') };
}
function stuck(strategy) { return ev(strategy, 'stalled', 'escalate-human'); }
function progressed(strategy) { return ev(strategy, 'advanced', 'continue'); }
function converged(strategy) { return ev(strategy, 'converged', 'converged-stop'); }

// 一个会话 = 一个事件数组。
function session(...events) { return events; }

// ── 空 / 畸形 ────────────────────────────────────────────────────────────────

test('空输入 → 空台账，不建议跳过任何策略', () => {
  const r = deriveStrategyLedger([]);
  assert.deepStrictEqual(r.recommendedSkips, []);
  assert.strictEqual(r.totalSessions, 0);
  assert.strictEqual(r.strategies.length, 0);
});

test('畸形输入绝不抛，回到空台账', () => {
  for (const bad of [null, undefined, 42, 'x', {}, [null, 1, 'bad'], [[null]]]) {
    const r = deriveStrategyLedger(bad);
    assert.strictEqual(typeof r, 'object');
    assert.deepStrictEqual(r.recommendedSkips, [], '畸形绝不凭空拉黑');
  }
});

// ── 核心：跨会话判 dead（本层存在的理由）────────────────────────────────────────

test('跨 2 个独立会话次次卡住、从未推进 → dead，建议跳过', () => {
  const r = deriveStrategyLedger([
    session(stuck('reprobe'), stuck('reprobe')),   // 会话 A
    session(stuck('reprobe')),                      // 会话 B
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reprobe');
  assert.strictEqual(s.classification, CLASS_DEAD);
  assert.strictEqual(s.recommendSkip, true);
  assert.ok(r.recommendedSkips.includes('reprobe'));
});

test('安全优先：一次推进即 productive，永不判 dead（一次成功洗清所有失败）', () => {
  const r = deriveStrategyLedger([
    session(stuck('reprobe'), stuck('reprobe')),
    session(stuck('reprobe')),
    session(progressed('reprobe')),                 // 曾成功一次
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reprobe');
  assert.strictEqual(s.classification, CLASS_PRODUCTIVE);
  assert.strictEqual(s.recommendSkip, false);
  assert.ok(!r.recommendedSkips.includes('reprobe'));
  assert.ok(r.productive.includes('reprobe'));
});

test('防单次运气差：同一会话内连着失败多次，只算 1 个会话 → 不足 MIN_SAMPLES → unproven', () => {
  const r = deriveStrategyLedger([
    session(stuck('reconcile'), stuck('reconcile'), stuck('reconcile')),  // 全在一个会话
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reconcile');
  assert.strictEqual(s.sessions, 1);
  assert.strictEqual(s.classification, CLASS_UNPROVEN, '单会话反复失败不足以判 dead');
  assert.strictEqual(s.recommendSkip, false);
});

test('恰好达 MIN_SAMPLES 个会话即可判 dead（边界）', () => {
  assert.strictEqual(MIN_SAMPLES, 2);
  const streams = [];
  for (let i = 0; i < MIN_SAMPLES; i += 1) streams.push(session(stuck('trust-pessimistic')));
  const r = deriveStrategyLedger(streams);
  const s = r.strategies.find((x) => x.strategy === 'trust-pessimistic');
  assert.strictEqual(s.classification, CLASS_DEAD);
});

test('minSamples 可覆盖（提高保守度）', () => {
  const r = deriveStrategyLedger(
    [session(stuck('reprobe')), session(stuck('reprobe'))],
    { minSamples: 3 },
  );
  const s = r.strategies.find((x) => x.strategy === 'reprobe');
  assert.strictEqual(s.classification, CLASS_UNPROVEN, '门槛提到 3，2 个会话不够');
});

// ── converged 也算推进 ────────────────────────────────────────────────────────

test('converged 视为推进 → productive', () => {
  const r = deriveStrategyLedger([
    session(stuck('reconcile')),
    session(stuck('reconcile')),
    session(converged('reconcile')),
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reconcile');
  assert.strictEqual(s.classification, CLASS_PRODUCTIVE);
});

// ── 计数正确性 ────────────────────────────────────────────────────────────────

test('progress / stuck / attempts / sessions 计数正确', () => {
  const r = deriveStrategyLedger([
    session(stuck('reprobe'), progressed('reprobe')),   // 会话0：1 stuck + 1 progress
    session(stuck('reprobe')),                           // 会话1：1 stuck
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reprobe');
  assert.strictEqual(s.attempts, 3);
  assert.strictEqual(s.progress, 1);
  assert.strictEqual(s.stuck, 2);
  assert.strictEqual(s.sessions, 2);
});

// ── 隔离性：多策略各自独立分类 ─────────────────────────────────────────────────

test('多策略各自独立：dead 的不牵连 productive 的', () => {
  const r = deriveStrategyLedger([
    session(stuck('reprobe'), progressed('reconcile')),
    session(stuck('reprobe'), progressed('reconcile')),
  ]);
  const rep = r.strategies.find((x) => x.strategy === 'reprobe');
  const rec = r.strategies.find((x) => x.strategy === 'reconcile');
  assert.strictEqual(rep.classification, CLASS_DEAD);
  assert.strictEqual(rec.classification, CLASS_PRODUCTIVE);
  assert.deepStrictEqual(r.recommendedSkips, ['reprobe']);
});

test('strategies 按策略名排序（稳定输出）', () => {
  const r = deriveStrategyLedger([
    session(stuck('zeta'), stuck('alpha')),
    session(stuck('zeta'), stuck('alpha')),
  ]);
  assert.deepStrictEqual(r.strategies.map((s) => s.strategy), ['alpha', 'zeta']);
});

// ── 无策略标注 / 中性事件不计入 ────────────────────────────────────────────────

test('无 strategy 标注的事件不计入学习', () => {
  const r = deriveStrategyLedger([
    session({ verdict: 'stalled', stop: 'escalate-human' }),   // 无 strategy
    session({ verdict: 'stalled', stop: 'escalate-human' }),
  ]);
  assert.strictEqual(r.strategies.length, 0);
  assert.deepStrictEqual(r.recommendedSkips, []);
});

test('未知 verdict（中性）不计入任一侧', () => {
  assert.strictEqual(L._outcomeOf({ verdict: 'mystery', stop: 'continue' }), '');
  const r = deriveStrategyLedger([
    session(ev('reprobe', 'mystery', 'continue')),
    session(ev('reprobe', 'mystery', 'continue')),
  ]);
  const s = r.strategies.find((x) => x.strategy === 'reprobe');
  // 只有中性事件 → attempts 0 → 未进 agg → 无此策略
  assert.strictEqual(s, undefined);
});

test('_outcomeOf：advanced/converged→progress，stalled/regressed→stuck，escalate stop 兜底 stuck', () => {
  assert.strictEqual(L._outcomeOf({ verdict: 'advanced' }), 'progress');
  assert.strictEqual(L._outcomeOf({ verdict: 'converged' }), 'progress');
  assert.strictEqual(L._outcomeOf({ verdict: 'stalled' }), 'stuck');
  assert.strictEqual(L._outcomeOf({ verdict: 'regressed' }), 'stuck');
  assert.strictEqual(L._outcomeOf({ verdict: '', stop: 'escalate-human' }), 'stuck');
});

// ── 诚实边界：只产 skip 建议，不含重排 ────────────────────────────────────────

test('输出只有 recommendedSkips / productive，绝无重排安全序的字段', () => {
  const r = deriveStrategyLedger([session(stuck('reprobe')), session(stuck('reprobe'))]);
  assert.ok(Array.isArray(r.recommendedSkips));
  assert.ok(Array.isArray(r.productive));
  assert.strictEqual(r.reorder, undefined, '台账绝不产出重排指令');
  assert.strictEqual(r.newOrder, undefined);
});
