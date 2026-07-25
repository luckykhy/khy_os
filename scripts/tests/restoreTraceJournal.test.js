'use strict';

/**
 * restoreTraceJournal.test.js — 还原「轨迹日志 / trace journal」纯叶子契约测试
 *
 * 跑法：node --test scripts/tests/restoreTraceJournal.test.js
 * （node:test，勿用 jest 前缀。）
 *
 * 核心不变量：叶子必须**跨进程重建** stallCount（这是它存在的理由），必须绝不抛、
 * 空/畸形回到干净初始态、危险 action 隐去、未知 verdict 不虚增/不假报收敛。
 */

const test = require('node:test');
const assert = require('node:assert');

const J = require('../lib/restoreTraceJournal');
const {
  buildEvent,
  deriveJournalState,
  nextStallCountFor,
  VERDICT_ADVANCED, VERDICT_CONVERGED, VERDICT_REGRESSED, VERDICT_STALLED,
  STOP_CONTINUE, STOP_CONVERGED, STOP_ESCALATE,
} = J;

// ── 事件工厂（模拟 verifyConvergence 的返回）───────────────────────────────────

function stalledVerdict() {
  return { verdict: VERDICT_STALLED, stop: STOP_CONTINUE, afterCount: 2, resolved: [], introduced: [] };
}
function stalledEscalate() {
  return { verdict: VERDICT_STALLED, stop: STOP_ESCALATE, afterCount: 2, resolved: [], introduced: [] };
}
function advancedVerdict() {
  return { verdict: VERDICT_ADVANCED, stop: STOP_CONTINUE, afterCount: 1, resolved: ['restore:x'], introduced: [] };
}
function convergedVerdict() {
  return { verdict: VERDICT_CONVERGED, stop: STOP_CONVERGED, afterCount: 0, resolved: ['restore:x'], introduced: [] };
}
function regressedVerdict() {
  return { verdict: VERDICT_REGRESSED, stop: STOP_ESCALATE, afterCount: 3, resolved: [], introduced: ['hydration:y'] };
}

/** 把一串 verdict 压成事件流（模拟一次次 record 落轨迹）。 */
function toEvents(verdicts, move) {
  return verdicts.map((v, i) => buildEvent({ verdict: v, move: move || {}, seq: i }));
}

// ── buildEvent ────────────────────────────────────────────────────────────────

test('buildEvent: 压出最小事件，字段齐全', () => {
  const e = buildEvent({ verdict: advancedVerdict(), move: { strategy: 'reprobe', action: 'khy doctor' }, seq: 3 });
  assert.strictEqual(e.seq, 3);
  assert.strictEqual(e.verdict, VERDICT_ADVANCED);
  assert.strictEqual(e.stop, STOP_CONTINUE);
  assert.strictEqual(e.strategy, 'reprobe');
  assert.strictEqual(e.action, 'khy doctor');
  assert.strictEqual(e.resolvedCount, 1);
  assert.strictEqual(e.introducedCount, 0);
});

test('buildEvent: 危险 action 隐去（红线）', () => {
  const e = buildEvent({ verdict: stalledVerdict(), move: { action: 'sudo rm -rf ~/.khy' } });
  assert.strictEqual(e.action, '[redacted: unsafe action]');
});

test('buildEvent: 畸形入参绝不抛，落安全缺省', () => {
  for (const bad of [null, undefined, 42, 'x', [], { verdict: null }]) {
    const e = buildEvent(bad);
    assert.strictEqual(typeof e, 'object');
    assert.strictEqual(e.seq, 0);
    assert.strictEqual(typeof e.verdict, 'string');
  }
});

// ── deriveJournalState：空 / 畸形 ─────────────────────────────────────────────

test('空事件流 → 干净初始态（stallCount 0，非终结）', () => {
  const s = deriveJournalState([]);
  assert.strictEqual(s.attempts, 0);
  assert.strictEqual(s.stallCount, 0);
  assert.strictEqual(s.terminal, false);
  assert.strictEqual(s.converged, false);
  assert.strictEqual(s.escalated, false);
});

test('畸形输入绝不抛，回到干净初始态', () => {
  for (const bad of [null, undefined, 42, 'x', { nope: 1 }, [null, 1, 'bad']]) {
    const s = deriveJournalState(bad);
    assert.strictEqual(typeof s, 'object');
    assert.ok(Number.isFinite(s.stallCount));
    assert.strictEqual(s.converged, false, '畸形绝不假报收敛');
  }
});

// ── 核心：跨进程 stallCount 重建（本层存在的理由）────────────────────────────────

test('核心缺陷闭合：连续两次 stalled 事件 → stallCount 累加到 2（跨进程连上）', () => {
  const events = toEvents([stalledVerdict(), stalledVerdict()]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.stallCount, 2, '两次无进展必须累加，而非各自从 0 起');
  assert.strictEqual(s.attempts, 2);
});

test('nextStallCountFor: 回放后正是喂回 converge 的数', () => {
  const events = toEvents([stalledVerdict(), stalledVerdict(), stalledVerdict()]);
  assert.strictEqual(nextStallCountFor(events), 3);
});

test('advanced 事件清零 stallCount（消解了未决项）', () => {
  const events = toEvents([stalledVerdict(), stalledVerdict(), advancedVerdict()]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.stallCount, 0, 'advanced 后 stall 归零');
});

test('stall→stall→advance→stall：只累计最后一段无进展', () => {
  const events = toEvents([stalledVerdict(), stalledVerdict(), advancedVerdict(), stalledVerdict()]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.stallCount, 1);
});

// ── 终结态判定 ────────────────────────────────────────────────────────────────

test('converged 事件 → terminal 且 converged，stallCount 归零', () => {
  const events = toEvents([stalledVerdict(), advancedVerdict(), convergedVerdict()]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.converged, true);
  assert.strictEqual(s.terminal, true);
  assert.strictEqual(s.escalated, false);
  assert.strictEqual(s.stallCount, 0);
});

test('escalate（stalled-at-limit）→ terminal 且 escalated，非 converged', () => {
  const events = toEvents([stalledVerdict(), stalledEscalate()]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.escalated, true);
  assert.strictEqual(s.converged, false);
  assert.strictEqual(s.terminal, true);
  assert.strictEqual(s.stallCount, 2);
});

test('regressed → escalated 且 stallCount 保持不变（倒退不增不减）', () => {
  const events = toEvents([stalledVerdict(), regressedVerdict()]);
  const s = deriveJournalState(events);
  // 第一步 stalled → 1；regressed 保持 → 仍 1
  assert.strictEqual(s.stallCount, 1);
  assert.strictEqual(s.escalated, true);
  assert.strictEqual(s.converged, false);
});

// ── 审计视图 ─────────────────────────────────────────────────────────────────

test('distinctStrategies 去重排序；lastAction 记录最后动作', () => {
  const events = [
    buildEvent({ verdict: stalledVerdict(), move: { strategy: 'reprobe', action: 'khy doctor' }, seq: 0 }),
    buildEvent({ verdict: stalledVerdict(), move: { strategy: 'reconcile', action: 'khy update' }, seq: 1 }),
    buildEvent({ verdict: stalledVerdict(), move: { strategy: 'reprobe', action: 'khy doctor' }, seq: 2 }),
  ];
  const s = deriveJournalState(events);
  assert.deepStrictEqual(s.distinctStrategies, ['reconcile', 'reprobe']);
  assert.strictEqual(s.lastAction, 'khy doctor');
});

test('history 每条带回放后的 stallAfter（可审计每步计数）', () => {
  const events = toEvents([stalledVerdict(), stalledVerdict(), advancedVerdict()]);
  const s = deriveJournalState(events);
  assert.deepStrictEqual(s.history.map((h) => h.stallAfter), [1, 2, 0]);
});

test('未知 verdict 保守：不虚增 stallCount、不假报收敛', () => {
  const weird = { verdict: 'mystery', stop: 'huh', afterCount: 1, resolved: [], introduced: [] };
  const events = [buildEvent({ verdict: stalledVerdict(), seq: 0 }), buildEvent({ verdict: weird, seq: 1 })];
  const s = deriveJournalState(events);
  assert.strictEqual(s.stallCount, 1, '未知 verdict 保持不变');
  assert.strictEqual(s.converged, false);
});

test('MAX_HISTORY：history 被截断但派生态（stallCount）不受截断影响', () => {
  const many = [];
  for (let i = 0; i < J.MAX_HISTORY + 50; i += 1) many.push(stalledVerdict());
  const s = deriveJournalState(toEvents(many));
  assert.ok(s.history.length <= J.MAX_HISTORY, 'history 截断');
  assert.strictEqual(s.stallCount, J.MAX_HISTORY + 50, 'stallCount 仍是全量累计');
  assert.strictEqual(s.attempts, J.MAX_HISTORY + 50);
});

// ── _STALL_RULE 与 restore-converge 对齐（漂移守卫）────────────────────────────

test('_STALL_RULE 覆盖四种 verdict 且语义正确', () => {
  assert.strictEqual(J._STALL_RULE[VERDICT_ADVANCED], 'reset');
  assert.strictEqual(J._STALL_RULE[VERDICT_CONVERGED], 'reset');
  assert.strictEqual(J._STALL_RULE[VERDICT_REGRESSED], 'keep');
  assert.strictEqual(J._STALL_RULE[VERDICT_STALLED], 'inc');
});

test('_isTerminalVerdict：converged / 任一 escalate 为终结，continue 非终结', () => {
  assert.strictEqual(J._isTerminalVerdict(VERDICT_CONVERGED, STOP_CONVERGED), true);
  assert.strictEqual(J._isTerminalVerdict(VERDICT_STALLED, STOP_ESCALATE), true);
  assert.strictEqual(J._isTerminalVerdict(VERDICT_STALLED, STOP_CONTINUE), false);
  assert.strictEqual(J._isTerminalVerdict(VERDICT_ADVANCED, STOP_CONTINUE), false);
});

test('_redact / _actionIsSafe 命中危险令牌', () => {
  assert.strictEqual(J._actionIsSafe('khy doctor'), true);
  assert.strictEqual(J._actionIsSafe('git push origin'), false);
  assert.strictEqual(J._redact('rm -rf /'), '[redacted: unsafe action]');
});

test('全流程冒烟：stall×1 → advance → stall×2 → converge 的最终态', () => {
  const events = toEvents([
    stalledVerdict(), advancedVerdict(), stalledVerdict(), stalledVerdict(), convergedVerdict(),
  ]);
  const s = deriveJournalState(events);
  assert.strictEqual(s.converged, true);
  assert.strictEqual(s.stallCount, 0);
  assert.strictEqual(s.attempts, 5);
  assert.strictEqual(s.lastVerdict, VERDICT_CONVERGED);
});
