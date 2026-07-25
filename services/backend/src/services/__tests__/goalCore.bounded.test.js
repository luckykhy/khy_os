'use strict';

/**
 * goalCore.bounded.test.js — 纯叶子「有界终止态」契约(node:test)。
 *
 * 覆盖:门控 isBounded、预算解析 resolveMaxTurns、记录字段、纯推进 advanceGoalTurn/
 * remainingTurns(不改入参)、有界指令 buildBoundedDirective(未耗尽 vs 一次性终止)。
 * 零 IO、确定性——不触磁盘、不依赖 env(每个断言显式传 env)。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../goalCore');

test('isBounded 默认 true;仅显式 falsy 关闭', () => {
  assert.equal(core.isBounded({}), true);
  assert.equal(core.isBounded({ KHY_GOAL_BOUNDED: '1' }), true);
  assert.equal(core.isBounded({ KHY_GOAL_BOUNDED: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(core.isBounded({ KHY_GOAL_BOUNDED: v }), false, v);
  }
});

test('resolveMaxTurns:默认 25、env 覆盖、非法回退、clamp 上限', () => {
  assert.equal(core.resolveMaxTurns({}), core.GOAL_DEFAULT_MAX_TURNS);
  assert.equal(core.GOAL_DEFAULT_MAX_TURNS, 25);
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '5' }), 5);
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: ' 8 ' }), 8);
  // 非法/0/负 → 记录 fallback,再默认
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '0' }, 7), 7);
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: 'abc' }, 'nope'), 25);
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '-3' }), 25);
  // clamp 上限 1000
  assert.equal(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '999999' }), 1000);
  // fallback 参数(记录自带 maxTurns)
  assert.equal(core.resolveMaxTurns({}, 12), 12);
  assert.equal(core.resolveMaxTurns({}, 99999), 1000);
});

test('GOAL_TERMINAL_STATUSES 冻结且含 done/exhausted/abandoned', () => {
  assert.deepEqual([...core.GOAL_TERMINAL_STATUSES].sort(), ['abandoned', 'done', 'exhausted']);
  assert.ok(Object.isFrozen(core.GOAL_TERMINAL_STATUSES));
});

test('buildGoalRecord 带 turnsSpent=0 / terminalStatus=null / maxTurns', () => {
  const r = core.buildGoalRecord({ text: '把发布做完', cwd: '/tmp/proj', maxTurns: 9 });
  assert.equal(r.ok, true);
  assert.equal(r.goal.turnsSpent, 0);
  assert.equal(r.goal.terminalStatus, null);
  assert.equal(r.goal.maxTurns, 9);
  assert.equal(r.goal.active, true);
  // 无 maxTurns → 默认
  const d = core.buildGoalRecord({ text: 'x', cwd: '/tmp/p' });
  assert.equal(d.goal.maxTurns, 25);
  // 空文本 → 失败
  assert.equal(core.buildGoalRecord({ text: '   ' }).ok, false);
});

test('advanceGoalTurn:递增、耗尽标志、纯函数不改入参', () => {
  const goal = { text: 'g', maxTurns: 3, turnsSpent: 0 };
  const t1 = core.advanceGoalTurn(goal, {});
  assert.deepEqual(t1, { spent: 1, cap: 3, remaining: 2, justExhausted: false });
  // 入参未被修改
  assert.equal(goal.turnsSpent, 0);

  const t3 = core.advanceGoalTurn({ text: 'g', maxTurns: 3, turnsSpent: 2 }, {});
  assert.equal(t3.spent, 3);
  assert.equal(t3.remaining, 0);
  assert.equal(t3.justExhausted, true);

  // 已超也标记耗尽,remaining 夹到 0
  const over = core.advanceGoalTurn({ text: 'g', maxTurns: 3, turnsSpent: 9 }, {});
  assert.equal(over.justExhausted, true);
  assert.equal(over.remaining, 0);

  // env 覆盖优先于记录 maxTurns
  const envCap = core.advanceGoalTurn({ text: 'g', maxTurns: 3, turnsSpent: 4 }, { KHY_GOAL_MAX_TURNS: '10' });
  assert.equal(envCap.cap, 10);
  assert.equal(envCap.justExhausted, false);
});

test('remainingTurns:旧记录(无 turnsSpent)按 0 起算,不抛', () => {
  assert.equal(core.remainingTurns({ text: 'g', maxTurns: 5 }, {}), 5);
  assert.equal(core.remainingTurns({ text: 'g', maxTurns: 5, turnsSpent: 2 }, {}), 3);
  assert.equal(core.remainingTurns(null, {}), 25);
});

test('buildBoundedDirective:未耗尽含剩余轮次+收敛语义', () => {
  const d = core.buildBoundedDirective({ text: '修所有 Bug' }, { cap: 25, remaining: 12, justExhausted: false });
  assert.ok(d.includes('还剩 12 轮'));
  assert.ok(d.includes('共 25 轮'));
  assert.ok(d.includes('有界任务'));
  assert.ok(d.includes('不要无限循环'));
  assert.ok(d.includes('修所有 Bug'));
  assert.ok(!d.includes('终止态(exhausted)'));
});

test('buildBoundedDirective:耗尽=一次性终止指令', () => {
  const d = core.buildBoundedDirective({ text: '修所有 Bug' }, { cap: 25, remaining: 0, justExhausted: true });
  assert.ok(d.includes('终止态(exhausted)'));
  assert.ok(d.includes('立即停止'));
  assert.ok(d.includes('完成/现状报告'));
  assert.ok(d.includes('共 25 轮'));
});

test('buildBoundedDirective:无目标 → 空串', () => {
  assert.equal(core.buildBoundedDirective(null, { justExhausted: false }), '');
  assert.equal(core.buildBoundedDirective({ text: '' }, { justExhausted: true }), '');
});
