'use strict';

/**
 * goalStore.bounded.test.js — 薄 IO 层「有界终止态」端到端(node:test)。
 *
 * 隔离:进程启动前把 KHYOS_HOME 指向临时目录(goalStore 经 getBaseDataDir('goals')
 * → getBaseHome() 落盘,受 KHYOS_HOME 覆盖且模块级缓存 → 必须在首次 require 前设定)。
 *
 * 覆盖:
 *  - advanceActiveGoalDirective 连续调用 → turnsSpent 逐次 +1;第 cap 次返回终止指令并落盘
 *    active=false/terminalStatus='exhausted';第 cap+1 次返回 ''(已退役)。
 *  - KHY_GOAL_BOUNDED=off → 不计数、返回旧无界指令(字节回退)。
 *  - clearGoal 记 terminalStatus(done / abandoned)。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goal-bounded-'));
const _savedKhyosHome = process.env.KHYOS_HOME;
const _savedBounded = process.env.KHY_GOAL_BOUNDED;
const _savedMax = process.env.KHY_GOAL_MAX_TURNS;
const _savedEnable = process.env.KHY_GOAL;

before(() => {
  process.env.KHYOS_HOME = TMP;            // 必须早于首次 require(goalStore)
  delete process.env.KHY_GOAL_BOUNDED;
  delete process.env.KHY_GOAL_MAX_TURNS;
  delete process.env.KHY_GOAL;
});

after(() => {
  if (_savedKhyosHome === undefined) delete process.env.KHYOS_HOME; else process.env.KHYOS_HOME = _savedKhyosHome;
  if (_savedBounded === undefined) delete process.env.KHY_GOAL_BOUNDED; else process.env.KHY_GOAL_BOUNDED = _savedBounded;
  if (_savedMax === undefined) delete process.env.KHY_GOAL_MAX_TURNS; else process.env.KHY_GOAL_MAX_TURNS = _savedMax;
  if (_savedEnable === undefined) delete process.env.KHY_GOAL; else process.env.KHY_GOAL = _savedEnable;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// require 必须在 before 之后跑 —— node:test 里 before 先于 test 执行,而顶层 require
// 只在模块加载(before 之前)。goalStore 的 getBaseHome 是惰性的(_dir() 内调),故只要
// 在**首次 setGoal/advance 调用**前 KHYOS_HOME 已设定即可 → 顶层 require 安全。
const store = require('../goalStore');

const CWD = '/tmp/khy-bounded-project';

test('有界推进:递减注入 → 耗尽终止 → 之后停注', () => {
  process.env.KHY_GOAL_MAX_TURNS = '3';
  const set = store.setGoal('找所有 Bug 并全部修复', { cwd: CWD });
  assert.equal(set.ok, true);
  assert.equal(set.goal.turnsSpent, 0);
  assert.equal(set.goal.maxTurns, 3);

  // 轮 1:剩 2
  const d1 = store.advanceActiveGoalDirective({ cwd: CWD });
  assert.ok(d1.includes('还剩 2 轮'), d1);
  assert.equal(store.getActiveGoal(CWD).turnsSpent, 1);

  // 轮 2:剩 1
  const d2 = store.advanceActiveGoalDirective({ cwd: CWD });
  assert.ok(d2.includes('还剩 1 轮'), d2);
  assert.equal(store.getActiveGoal(CWD).turnsSpent, 2);

  // 轮 3(cap):一次性终止指令 + 退役
  const d3 = store.advanceActiveGoalDirective({ cwd: CWD });
  assert.ok(d3.includes('终止态(exhausted)'), d3);
  assert.ok(d3.includes('立即停止'));
  // 已退役:pickActiveGoal 无命中
  assert.equal(store.getActiveGoal(CWD), null);

  // 轮 4:已退役 → 无注入(结构上不可能无限跑)
  const d4 = store.advanceActiveGoalDirective({ cwd: CWD });
  assert.equal(d4, '');

  // 落盘 terminalStatus=exhausted
  const rec = store.listGoals().find((g) => g.scope === require('../goalCore').scopeKeyFor(CWD));
  assert.equal(rec.active, false);
  assert.equal(rec.terminalStatus, 'exhausted');
  assert.equal(rec.turnsSpent, 3);
  delete process.env.KHY_GOAL_MAX_TURNS;
});

test('KHY_GOAL_BOUNDED=off:不计数 + 旧无界文案(字节回退)', () => {
  const CWD2 = '/tmp/khy-unbounded-project';
  store.setGoal('消除所有矛盾', { cwd: CWD2 });
  process.env.KHY_GOAL_BOUNDED = 'off';
  try {
    const d1 = store.advanceActiveGoalDirective({ cwd: CWD2 });
    // 旧无界文案:含 GoalTool(action=clear),不含「还剩 N 轮」
    assert.ok(d1.includes('GoalTool(action=clear)'), d1);
    assert.ok(!d1.includes('还剩'), d1);
    // 不计数:turnsSpent 仍为 0,目标仍活动
    assert.equal(store.getActiveGoal(CWD2).turnsSpent, 0);
    // 再调仍不退役
    store.advanceActiveGoalDirective({ cwd: CWD2 });
    assert.ok(store.getActiveGoal(CWD2));
  } finally {
    delete process.env.KHY_GOAL_BOUNDED;
  }
});

test('KHY_GOAL=off:无注入(与今天一致)', () => {
  const CWD3 = '/tmp/khy-disabled-project';
  store.setGoal('随便什么', { cwd: CWD3 });
  process.env.KHY_GOAL = 'off';
  try {
    assert.equal(store.advanceActiveGoalDirective({ cwd: CWD3 }), '');
  } finally {
    delete process.env.KHY_GOAL;
  }
});

test('clearGoal 记 terminalStatus:done vs abandoned', () => {
  const CWD4 = '/tmp/khy-clear-done';
  const CWD5 = '/tmp/khy-clear-abandon';
  const core = require('../goalCore');

  store.setGoal('done 目标', { cwd: CWD4 });
  store.clearGoal({ cwd: CWD4, reason: 'done' });
  const doneRec = store.listGoals().find((g) => g.scope === core.scopeKeyFor(CWD4));
  assert.equal(doneRec.active, false);
  assert.equal(doneRec.terminalStatus, 'done');
  assert.ok(doneRec.terminatedAt);

  store.setGoal('abandon 目标', { cwd: CWD5 });
  store.clearGoal({ cwd: CWD5 });   // 默认 abandoned
  const abRec = store.listGoals().find((g) => g.scope === core.scopeKeyFor(CWD5));
  assert.equal(abRec.terminalStatus, 'abandoned');
});

test('旧记录(仅 active,无 turnsSpent)→ 首次 advance 不抛、视为 1', () => {
  const core = require('../goalCore');
  // 直接写一条"旧格式"记录进盘(模拟线上历史 goals.json)
  const CWD6 = '/tmp/khy-legacy-record';
  const goalsFile = path.join(TMP, 'goals', 'goals.json');
  const legacy = {
    version: core.STORE_VERSION,
    goals: [{ id: 'legacy1', text: '旧目标', scope: core.scopeKeyFor(CWD6), cwd: CWD6, active: true }],
  };
  fs.mkdirSync(path.dirname(goalsFile), { recursive: true });
  fs.writeFileSync(goalsFile, JSON.stringify(legacy), 'utf-8');

  process.env.KHY_GOAL_MAX_TURNS = '5';
  const d = store.advanceActiveGoalDirective({ cwd: CWD6 });
  assert.ok(d.includes('还剩 4 轮'), d);      // spent=1 → remaining=cap-1=4
  assert.equal(store.getActiveGoal(CWD6).turnsSpent, 1);
  delete process.env.KHY_GOAL_MAX_TURNS;
});
