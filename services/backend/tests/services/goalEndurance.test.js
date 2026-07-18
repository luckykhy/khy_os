'use strict';

// goalEndurance.test.js — 纯叶子「连续多日运行底气自检」测试(node:test)。
const { test } = require('node:test');
const assert = require('node:assert');

const end = require('../../src/services/goalEndurance');

test('默认配置(空 env):12h 闲置退役 < 72h 目标 → 阻断项 idle-timeout,判定不 enduring', () => {
  const a = end.assessGoalEndurance({ env: {} });
  assert.equal(a.enduring, false);
  const idle = a.blockers.find((b) => b.key === 'idle-timeout');
  assert.ok(idle, '应有 idle-timeout 阻断项');
  assert.equal(idle.fix, 'KHY_GOAL_IDLE_MS=0');
  // 确定性中断视界 = 12 小时
  assert.equal(a.horizonHours, 12);
});

test('KHY_GOAL_IDLE_MS=0:关闭闲置退役 → 无 idle 阻断,视界 ∞,enduring', () => {
  const a = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0' } });
  assert.equal(a.enduring, true);
  assert.equal(a.horizonHours, Infinity);
  assert.ok(!a.blockers.find((b) => b.key === 'idle-timeout'));
  assert.ok(a.notes.find((n) => n.key === 'idle-timeout'));
});

test('KHY_GOAL_RECONCILE=off:也视作不会闲置退役 → enduring', () => {
  const a = end.assessGoalEndurance({ env: { KHY_GOAL_RECONCILE: 'off' } });
  assert.equal(a.enduring, true);
  assert.equal(a.horizonHours, Infinity);
});

test('targetHours 小于闲置窗口(6h < 12h):idle 变 note 而非阻断 → enduring', () => {
  const a = end.assessGoalEndurance({ env: {}, targetHours: 6 });
  assert.equal(a.enduring, true);
  assert.ok(!a.blockers.find((b) => b.key === 'idle-timeout'));
  assert.ok(a.notes.find((n) => n.key === 'idle-timeout'));
});

test('KHY_TOKEN_BUDGET 设正值 → token-budget warning;未设 → robust note', () => {
  const warn = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0', KHY_TOKEN_BUDGET: '200000' } });
  assert.ok(warn.warnings.find((w) => w.key === 'token-budget'));
  const ok = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0' } });
  assert.ok(ok.notes.find((n) => n.key === 'token-budget'));
  // k/m 后缀也识别为硬上限
  const k = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0', KHY_TOKEN_BUDGET: '500k' } });
  assert.ok(k.warnings.find((w) => w.key === 'token-budget'));
});

test('stop-gate 默认 1 → warning;调到 10 → 无 warning', () => {
  const def = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0' } });
  assert.ok(def.warnings.find((w) => w.key === 'stop-gate'));
  const high = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0', KHY_GOAL_STOP_GATE_MAX: '10' } });
  assert.ok(!high.warnings.find((w) => w.key === 'stop-gate'));
});

test('轮次预算:低余额(接近 cap)→ turn-budget warning', () => {
  const a = end.assessGoalEndurance({
    env: { KHY_GOAL_IDLE_MS: '0' },
    goal: { text: 'g', maxTurns: 25, turnsSpent: 20 },
  });
  assert.ok(a.warnings.find((w) => w.key === 'turn-budget'));
  assert.equal(a.turns.remaining, 5);
});

test('KHY_GOAL_BOUNDED=off:轮次预算关闭 → turn-budget 变 note', () => {
  const a = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0', KHY_GOAL_BOUNDED: 'off' } });
  assert.ok(a.notes.find((n) => n.key === 'turn-budget'));
  assert.ok(!a.warnings.find((w) => w.key === 'turn-budget'));
});

test('buildEnduranceEnv:冻结,含四把关键开关', () => {
  const e = end.buildEnduranceEnv();
  assert.ok(Object.isFrozen(e));
  assert.equal(e.KHY_GOAL_IDLE_MS, '0');
  assert.equal(e.KHY_GOAL_MAX_TURNS, '1000');
  assert.equal(e.KHY_GOAL_STOP_GATE_MAX, '10');
  assert.equal(e.KHY_TOKEN_BUDGET, '0');
});

test('buildEnduranceReport:非空字符串数组;有目标含目标文本;含一键配置', () => {
  const a = end.assessGoalEndurance({ env: {}, goal: { text: '连续修 Bug 三天' } });
  const lines = end.buildEnduranceReport(a);
  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(lines.every((l) => typeof l === 'string'));
  assert.ok(lines.some((l) => l.includes('连续修 Bug 三天')));
  assert.ok(lines.some((l) => l.includes('export KHY_GOAL_IDLE_MS=0')));
  assert.ok(lines.some((l) => l.includes('自检')));
});

test('buildEnduranceReport:无目标也能渲染(通用配置评估)', () => {
  const a = end.assessGoalEndurance({ env: { KHY_GOAL_IDLE_MS: '0' } });
  const lines = end.buildEnduranceReport(a);
  assert.ok(lines.some((l) => l.includes('当前没有活动的持久目标')));
});

test('绝不抛:无参 / 垃圾输入 / null goal 均返回结构化结果', () => {
  assert.doesNotThrow(() => end.assessGoalEndurance());
  assert.doesNotThrow(() => end.assessGoalEndurance({ goal: 12345, env: null, targetHours: 'abc' }));
  const a = end.assessGoalEndurance({ goal: null });
  assert.equal(a.hasGoal, false);
  assert.ok(Array.isArray(a.blockers));
  assert.doesNotThrow(() => end.buildEnduranceReport(null));
  assert.doesNotThrow(() => end.buildEnduranceReport({}));
});

// ── 底气落盘(buildEndurancePersistPlan / buildEndurancePersistReport)──────────
test('buildEndurancePersistPlan(scope=goal):空 env → 四个目标 endurance 键全进 patch', () => {
  const plan = end.buildEndurancePersistPlan({ env: {}, scope: 'goal' });
  const keys = Object.keys(plan.patch).sort();
  assert.deepEqual(keys, ['KHY_GOAL_IDLE_MS', 'KHY_GOAL_MAX_TURNS', 'KHY_GOAL_STOP_GATE_MAX', 'KHY_TOKEN_BUDGET']);
  assert.equal(plan.patch.KHY_GOAL_IDLE_MS, '0');
  assert.equal(plan.changes.length, 4);
  assert.equal(plan.unchanged.length, 0);
});

test('buildEndurancePersistPlan(scope=goal):已是 endurance env → patch 为空,四键 unchanged(幂等)', () => {
  const plan = end.buildEndurancePersistPlan({ env: end.buildEnduranceEnv(), scope: 'goal' });
  assert.deepEqual(plan.patch, {});
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.unchanged.length, 4);
});

test('buildEndurancePersistPlan:部分已设 → 仅缺口进 patch,已设键 unchanged', () => {
  const plan = end.buildEndurancePersistPlan({ env: { KHY_GOAL_IDLE_MS: '0' } });
  assert.ok(!('KHY_GOAL_IDLE_MS' in plan.patch), 'IDLE_MS 已是 0 不应进 patch');
  assert.ok('KHY_TOKEN_BUDGET' in plan.patch);
  assert.ok(plan.unchanged.some((u) => u.key === 'KHY_GOAL_IDLE_MS'));
  assert.ok(plan.changes.some((c) => c.key === 'KHY_TOKEN_BUDGET' && c.from === ''));
});

test('buildEndurancePersistPlan:带空白的现值按 trim 对账', () => {
  const plan = end.buildEndurancePersistPlan({ env: { KHY_GOAL_IDLE_MS: '  0  ' } });
  assert.ok(!('KHY_GOAL_IDLE_MS' in plan.patch), 'trim 后等于目标值不应进 patch');
});

test('buildEndurancePersistPlan:绝不抛(无参 / null env / 垃圾)', () => {
  assert.doesNotThrow(() => end.buildEndurancePersistPlan());
  assert.doesNotThrow(() => end.buildEndurancePersistPlan({ env: null }));
  assert.doesNotThrow(() => end.buildEndurancePersistPlan({ env: 12345 }));
});

test('buildEndurancePersistReport:有变更 → 列出写入键 + envPath + 落盘后判定', () => {
  const before = end.assessGoalEndurance({ env: {} });
  const merged = Object.assign({}, {}, end.buildEnduranceEnv());
  const after = end.assessGoalEndurance({ env: merged });
  const plan = end.buildEndurancePersistPlan({ env: {} });
  const lines = end.buildEndurancePersistReport({ before, after, plan, envPath: '/home/u/.khy/.env' });
  const joined = lines.join('\n');
  assert.ok(joined.includes('落盘'));
  assert.ok(joined.includes('/home/u/.khy/.env'));
  assert.ok(joined.includes('KHY_GOAL_IDLE_MS=0'));
  assert.ok(joined.includes('落盘后 · 目标判定:✅'), '空→endurance 后应可连续运行');
  assert.ok(joined.includes('撤销'));
});

test('buildEndurancePersistReport:无变更 → 提示已落盘', () => {
  // scope 默认 'all' → 需目标 + 会话两组键都已是目标值才算无变更。
  const env = { ...end.buildEnduranceEnv(), ...end.buildSessionEnduranceEnv() };
  const after = end.assessGoalEndurance({ env });
  const plan = end.buildEndurancePersistPlan({ env });
  const lines = end.buildEndurancePersistReport({ after, plan, envPath: '/x/.env' });
  assert.ok(lines.join('\n').includes('无需变更'));
});

test('buildEndurancePersistReport:绝不抛(无参 / 空 plan)', () => {
  assert.doesNotThrow(() => end.buildEndurancePersistReport());
  assert.doesNotThrow(() => end.buildEndurancePersistReport({ plan: { changes: [], unchanged: [] } }));
});

// ── 交互式会话(无需目标)底气维度 ───────────────────────────────────────────

test('buildSessionEnduranceEnv:冻结且键正确(token off + 两回复边界拉满)', () => {
  const senv = end.buildSessionEnduranceEnv();
  assert.ok(Object.isFrozen(senv));
  assert.equal(senv.KHY_TOKEN_BUDGET, '0');
  assert.equal(senv.KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS, '86400000');
  assert.equal(senv.KHY_TOOL_LOOP_MAX_MS, '1800000');
});

test('assessSessionEndurance:默认空 env → enduring 且视界 ∞(会话无闲置退出/无累计轮数上限)', () => {
  const a = end.assessSessionEndurance({});
  assert.equal(a.enduring, true);
  assert.equal(a.horizonHours, Infinity);
  assert.ok(a.blockers.length === 0);
  // 默认单轮边界低于 endurance → reply-bounds 提示项(但不构成 blocker)
  assert.ok(a.warnings.find((w) => w.key === 'reply-bounds'));
  assert.ok(a.notes.find((n) => n.key === 'session-lifetime'));
});

test('assessSessionEndurance:应用 sessionEnv 后 → reply-bounds 转 note,无该 warning', () => {
  const a = end.assessSessionEndurance({ env: end.buildSessionEnduranceEnv() });
  assert.ok(!a.warnings.find((w) => w.key === 'reply-bounds'));
  assert.ok(a.notes.find((n) => n.key === 'reply-bounds'));
  assert.ok(a.notes.find((n) => n.key === 'token-budget'));
  assert.equal(a.replyBounds.absAtEndurance, true);
  assert.equal(a.replyBounds.idleAtEndurance, true);
});

test('assessSessionEndurance:硬 token 上限 → token-budget warning(仍 enduring)', () => {
  const a = end.assessSessionEndurance({ env: { KHY_TOKEN_BUDGET: '5000' } });
  assert.equal(a.enduring, true); // 会话不退出,仅当轮可能截断
  assert.ok(a.warnings.find((w) => w.key === 'token-budget' && w.fix === 'KHY_TOKEN_BUDGET=0'));
});

test('assessSessionEndurance:绝不抛(无参 / null / 垃圾)', () => {
  assert.doesNotThrow(() => end.assessSessionEndurance());
  assert.doesNotThrow(() => end.assessSessionEndurance({ env: null }));
  assert.doesNotThrow(() => end.assessSessionEndurance({ env: 123, targetHours: 'x' }));
});

test('buildSessionEnduranceReport:enduring → ✅ 判定行 + 会话终身 note', () => {
  const a = end.assessSessionEndurance({ env: end.buildSessionEnduranceEnv() });
  const joined = end.buildSessionEnduranceReport(a).join('\n');
  assert.ok(joined.includes('交互式会话'));
  assert.ok(joined.includes('✅'));
  assert.ok(joined.includes('无闲置退出'));
});

test('buildEndurancePersistPlan:scope=session → 仅会话四键进 patch(空 env)', () => {
  const plan = end.buildEndurancePersistPlan({ env: {}, scope: 'session' });
  assert.equal(plan.scope, 'session');
  const keys = Object.keys(plan.patch).sort();
  assert.deepEqual(keys, ['KHY_TOKEN_BUDGET', 'KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS', 'KHY_TOOL_LOOP_MAX_MS', 'KHY_UNATTENDED_AUTOANSWER'].sort());
});

test('buildEndurancePersistPlan:scope=goal → 仅目标四键进 patch(空 env)', () => {
  const plan = end.buildEndurancePersistPlan({ env: {}, scope: 'goal' });
  assert.equal(plan.scope, 'goal');
  const keys = Object.keys(plan.patch).sort();
  assert.deepEqual(keys, ['KHY_GOAL_IDLE_MS', 'KHY_GOAL_MAX_TURNS', 'KHY_GOAL_STOP_GATE_MAX', 'KHY_TOKEN_BUDGET'].sort());
});

test('buildEndurancePersistPlan:scope=all(默认)→ 并集六键(共有 TOKEN_BUDGET 无冲突)', () => {
  const plan = end.buildEndurancePersistPlan({ env: {} });
  assert.equal(plan.scope, 'all');
  const keys = Object.keys(plan.patch);
  assert.ok(keys.includes('KHY_GOAL_IDLE_MS'));
  assert.ok(keys.includes('KHY_TOOL_LOOP_ABSOLUTE_TIMEOUT_MS'));
  assert.equal(keys.filter((k) => k === 'KHY_TOKEN_BUDGET').length, 1);
});

test('buildEndurancePersistPlan:未知 scope 退回 all', () => {
  const plan = end.buildEndurancePersistPlan({ env: {}, scope: 'bogus' });
  assert.equal(plan.scope, 'all');
});

test('buildEnduranceHeadline:两维度 after 都 enduring → 两行 ✅;scope 过滤', () => {
  const sessionAfter = end.assessSessionEndurance({ env: end.buildSessionEnduranceEnv() });
  const goalAfter = end.assessGoalEndurance({ env: end.buildEnduranceEnv() });
  const all = end.buildEnduranceHeadline({ sessionAfter, goalAfter, scope: 'all' });
  assert.equal(all.length, 2);
  assert.ok(all[0].includes('交互式会话') && all[0].includes('✅'));
  assert.ok(all[1].includes('目标') && all[1].includes('✅'));
  const sessOnly = end.buildEnduranceHeadline({ sessionAfter, goalAfter, scope: 'session' });
  assert.equal(sessOnly.length, 1);
  assert.ok(sessOnly[0].includes('交互式会话'));
});

test('buildEndurancePersistReport:scope=session 标题 + headline 透传', () => {
  const plan = end.buildEndurancePersistPlan({ env: {}, scope: 'session' });
  const headline = ['落盘后 · 交互式会话:✅ 默认可连续跑几天不中断。'];
  const joined = end.buildEndurancePersistReport({ plan, headline, envPath: '/x/.env' }).join('\n');
  assert.ok(joined.includes('交互会话'), '标题应含 scope 标签');
  assert.ok(joined.includes('落盘后 · 交互式会话:✅'));
});

// ── 无人值守自动作答 + 模型无感续接维度(goal 2026-07-11)──────────────────
test('buildSessionEnduranceEnv:含 KHY_UNATTENDED_AUTOANSWER=1', () => {
  const senv = end.buildSessionEnduranceEnv();
  assert.equal(senv.KHY_UNATTENDED_AUTOANSWER, '1');
});

test('assessSessionEndurance:自动作答默认关 → warning + autoAnswer=false', () => {
  const a = end.assessSessionEndurance({ env: {} });
  assert.equal(a.autoAnswer, false);
  assert.ok(a.warnings.some((w) => w.key === 'auto-answer'), '应有 auto-answer warning');
  const w = a.warnings.find((w) => w.key === 'auto-answer');
  assert.equal(w.fix, 'KHY_UNATTENDED_AUTOANSWER=1');
});

test('assessSessionEndurance:自动作答开 → note + autoAnswer=true(无 warning)', () => {
  const a = end.assessSessionEndurance({ env: { KHY_UNATTENDED_AUTOANSWER: '1' } });
  assert.equal(a.autoAnswer, true);
  assert.ok(a.notes.some((n) => n.key === 'auto-answer'), '应有 auto-answer note');
  assert.ok(!a.warnings.some((w) => w.key === 'auto-answer'), '开启后不应再 warning');
});

test('assessSessionEndurance:恒亮出 model-failover note(无感续接底气)', () => {
  const a = end.assessSessionEndurance({ env: {} });
  assert.ok(a.notes.some((n) => n.key === 'model-failover'));
});

test('assessSessionEndurance:恒亮出 error-handling note(错误处理底气)', () => {
  const a = end.assessSessionEndurance({ env: {} });
  const note = a.notes.find((n) => n.key === 'error-handling');
  assert.ok(note, '应有 error-handling note');
  assert.match(note.title, /错误处理/);
  assert.match(note.title, /意外异常|防御纵深|不掉线/);
});

test('assessSessionEndurance:自动作答开 → 附带 intent-fidelity note(不偏离本意)', () => {
  const a = end.assessSessionEndurance({ env: { KHY_UNATTENDED_AUTOANSWER: '1' } });
  const note = a.notes.find((n) => n.key === 'intent-fidelity');
  assert.ok(note, '自动作答开时应有 intent-fidelity note');
  assert.match(note.title, /不偏离本意|校准/);
});

test('assessSessionEndurance:自动作答关 → 无 intent-fidelity note(auto-answer 未开)', () => {
  const a = end.assessSessionEndurance({ env: {} });
  assert.equal(a.notes.some((n) => n.key === 'intent-fidelity'), false);
});

test('assessSessionEndurance:自动作答开/关都不影响 enduring(默认成立)', () => {
  assert.equal(end.assessSessionEndurance({ env: {} }).enduring, true);
  assert.equal(end.assessSessionEndurance({ env: { KHY_UNATTENDED_AUTOANSWER: '1' } }).enduring, true);
});

test('buildEndurancePersistPlan:session/all 落盘含 autoanswer,goal 不含', () => {
  assert.equal(end.buildEndurancePersistPlan({ env: {}, scope: 'session' }).patch.KHY_UNATTENDED_AUTOANSWER, '1');
  assert.equal(end.buildEndurancePersistPlan({ env: {}, scope: 'all' }).patch.KHY_UNATTENDED_AUTOANSWER, '1');
  assert.ok(!('KHY_UNATTENDED_AUTOANSWER' in end.buildEndurancePersistPlan({ env: {}, scope: 'goal' }).patch));
});
