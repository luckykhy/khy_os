'use strict';

/**
 * restoreSkipApplier.test.js — 还原「学习应用器」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreSkipApplier.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：
 *   · 保序不删不重排(诚实边界，继承台账约束)；
 *   · 死策略只有在有活替身兜底时才 safeToSkip，否则 mustTryDespiteDead(绝不搁浅冲突)；
 *   · escalate 安全网永不 safeToSkip(学习绝不吞掉交人出口)；
 *   · 空/畸形 → 保守透传、零跳过。
 */

const test = require('node:test');
const assert = require('node:assert');

const A = require('../lib/restoreSkipApplier');
const { applyLearnedSkips } = A;

// ── move 工厂(镜像 resolver 产出形状)──────────────────────────────────────────

function mv(strategy, action, covers, order) {
  return {
    strategy, action: action || (strategy + '-action'),
    autonomy: strategy === 'escalate' ? 'human' : 'agent',
    order: order == null ? 0 : order,
    covers: covers || ['c1'],
  };
}

// ── 空 / 畸形 ────────────────────────────────────────────────────────────────

test('空 moves → 空计划', () => {
  const r = applyLearnedSkips([], ['reprobe']);
  assert.deepStrictEqual(r.plan, []);
  assert.strictEqual(r.skippedCount, 0);
});

test('空 skips → 原样透传，零跳过建议', () => {
  const moves = [mv('reprobe'), mv('reconcile')];
  const r = applyLearnedSkips(moves, []);
  assert.strictEqual(r.plan.length, 2);
  assert.strictEqual(r.safeToSkip.length, 0);
  assert.ok(r.plan.every((p) => p.learnedDead === false));
  assert.strictEqual(r.liveCount, 2);
});

test('畸形输入绝不抛，保守透传不删不跳', () => {
  for (const bad of [null, undefined, 42, 'x', [null, 1, {}]]) {
    const r = applyLearnedSkips(bad, ['reprobe']);
    assert.strictEqual(typeof r, 'object');
    assert.strictEqual(r.skippedCount, 0);
    assert.ok(Array.isArray(r.plan));
  }
  // 畸形 skips 也不炸
  const r2 = applyLearnedSkips([mv('reprobe')], 'nope');
  assert.strictEqual(r2.skippedCount, 0);
});

// ── 保序不删(诚实边界)────────────────────────────────────────────────────────

test('保序不删：plan 与 moves 一一对应、顺序不变，绝不移除任何 move', () => {
  const moves = [mv('reprobe', 'a', ['c1'], 0), mv('reconcile', 'b', ['c1'], 1), mv('escalate', 'c', ['c1'], 3)];
  const r = applyLearnedSkips(moves, ['reprobe']);
  assert.strictEqual(r.plan.length, 3, '一个都不能少');
  assert.deepStrictEqual(r.plan.map((p) => p.strategy), ['reprobe', 'reconcile', 'escalate']);
});

// ── 核心：safeToSkip 需有活替身 ────────────────────────────────────────────────

test('死策略有活替身(同冲突另有非死 move)→ safeToSkip', () => {
  const moves = [
    mv('reprobe', 'a', ['c1'], 0),        // 死
    mv('reconcile', 'b', ['c1'], 1),      // 活，也 covers c1 → 替身
  ];
  const r = applyLearnedSkips(moves, ['reprobe']);
  const rep = r.plan.find((p) => p.strategy === 'reprobe');
  assert.strictEqual(rep.learnedDead, true);
  assert.strictEqual(rep.safeToSkip, true, '有活替身 → 可安全跳');
  assert.strictEqual(rep.mustTryDespiteDead, false);
  assert.deepStrictEqual(r.safeToSkip.map((p) => p.strategy), ['reprobe']);
});

test('死策略是唯一出路(无活替身)→ mustTryDespiteDead，绝不搁浅冲突', () => {
  const moves = [mv('reprobe', 'a', ['c1'], 0)]; // 唯一 move covers c1
  const r = applyLearnedSkips(moves, ['reprobe']);
  const rep = r.plan[0];
  assert.strictEqual(rep.learnedDead, true);
  assert.strictEqual(rep.safeToSkip, false, '唯一出路绝不可跳(否则搁浅 c1)');
  assert.strictEqual(rep.mustTryDespiteDead, true);
});

test('替身也是死策略 → 不算活替身 → 原死策略 mustTry', () => {
  const moves = [
    mv('reprobe', 'a', ['c1'], 0),        // 死
    mv('reconcile', 'b', ['c1'], 1),      // 也死
  ];
  const r = applyLearnedSkips(moves, ['reprobe', 'reconcile']);
  // 两个都死且互为唯一非死替身缺失 → 都 mustTry
  assert.ok(r.plan.every((p) => p.learnedDead));
  assert.strictEqual(r.safeToSkip.length, 0);
  assert.strictEqual(r.mustTryDespiteDead.length, 2);
});

// ── escalate 安全网永不跳 ──────────────────────────────────────────────────────

test('escalate 即便被判死也永不 safeToSkip(学习绝不吞交人出口)', () => {
  const moves = [
    mv('reconcile', 'b', ['c1'], 1),      // 活替身存在
    mv('escalate', 'c', ['c1'], 3),       // 假设也进了 skips
  ];
  const r = applyLearnedSkips(moves, ['escalate']);
  const esc = r.plan.find((p) => p.strategy === 'escalate');
  assert.strictEqual(esc.learnedDead, true);
  assert.strictEqual(esc.safeToSkip, false, 'escalate 永不可跳');
  assert.strictEqual(esc.mustTryDespiteDead, true);
});

// ── 多冲突：只有每个冲突都有活替身才可跳 ────────────────────────────────────────

test('死 move covers 多冲突：仅当每个冲突都有活替身才 safeToSkip', () => {
  const moves = [
    mv('reprobe', 'a', ['c1', 'c2'], 0),  // 死，covers c1+c2
    mv('reconcile', 'b', ['c1'], 1),      // 活，只 covers c1
  ];
  // c2 没有活替身 → reprobe 不可安全跳
  const r = applyLearnedSkips(moves, ['reprobe']);
  const rep = r.plan.find((p) => p.strategy === 'reprobe');
  assert.strictEqual(rep.safeToSkip, false, 'c2 无活替身 → 不可跳');
  assert.strictEqual(rep.mustTryDespiteDead, true);
});

test('死 move covers 多冲突且每个都有活替身 → safeToSkip', () => {
  const moves = [
    mv('reprobe', 'a', ['c1', 'c2'], 0),
    mv('reconcile', 'b', ['c1'], 1),
    mv('trust-pessimistic', 'd', ['c2'], 2),
  ];
  const r = applyLearnedSkips(moves, ['reprobe']);
  const rep = r.plan.find((p) => p.strategy === 'reprobe');
  assert.strictEqual(rep.safeToSkip, true, 'c1、c2 各有活替身 → 可跳');
});

// ── 无 covers 信息 → 保守不可跳 ────────────────────────────────────────────────

test('死 move 无 covers 信息 → 保守 mustTry(不可跳)', () => {
  const moves = [{ strategy: 'reprobe', action: 'a', order: 0 }]; // 无 covers
  const r = applyLearnedSkips(moves, ['reprobe']);
  assert.strictEqual(r.plan[0].safeToSkip, false);
  assert.strictEqual(r.plan[0].mustTryDespiteDead, true);
});

// ── 聚合字段 ─────────────────────────────────────────────────────────────────

test('appliedSkips 只含实际命中的死策略；liveCount 正确', () => {
  const moves = [mv('reprobe', 'a', ['c1'], 0), mv('reconcile', 'b', ['c1'], 1)];
  const r = applyLearnedSkips(moves, ['reprobe', 'never-used-strategy']);
  assert.deepStrictEqual(r.appliedSkips, ['reprobe'], '未命中的死策略不进 appliedSkips');
  assert.strictEqual(r.liveCount, 1, 'reconcile 是唯一活 move');
});

test('_hasLiveAlternative 直接契约', () => {
  const dead = mv('reprobe', 'a', ['c1'], 0);
  const live = mv('reconcile', 'b', ['c1'], 1);
  assert.strictEqual(A._hasLiveAlternative(dead, [dead, live], new Set(['reprobe'])), true);
  assert.strictEqual(A._hasLiveAlternative(dead, [dead], new Set(['reprobe'])), false);
});

test('_NEVER_SKIP 含 escalate', () => {
  assert.ok(A._NEVER_SKIP.has('escalate'));
});
