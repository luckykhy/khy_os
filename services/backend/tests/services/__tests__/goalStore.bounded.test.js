'use strict';
/**
 * goalStore.bounded.test.js �?�?IO 层「有界终止态」端到端(node:test)�? *
 * 隔离:进程启动前把 KHYOS_HOME 指向临时目录(goalStore �?getBaseDataDir('goals')
 * �?getBaseHome() 落盘,�?KHYOS_HOME 覆盖且模块级缓存 �?必须在首�?require 前设�?�? *
 * 覆盖:
 *  - advanceActiveGoalDirective 连续调用 �?turnsSpent 逐次 +1;�?cap 次返回终止指令并落盘
 *    active=false/terminalStatus='exhausted';�?cap+1 次返�?''(已退�?�? *  - KHY_GOAL_BOUNDED=off �?不计数、返回旧无界指令(字节回退)�? *  - clearGoal �?terminalStatus(done / abandoned)�? */
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-goal-bounded-'));
const _savedKhyosHome = process.env.KHYOS_HOME;
const _savedBounded = process.env.KHY_GOAL_BOUNDED;
const _savedMax = process.env.KHY_GOAL_MAX_TURNS;
const _savedEnable = process.env.KHY_GOAL;
before(() => {
  process.env.KHYOS_HOME = TMP; // 必须早于首次 require(goalStore)
  delete process.env.KHY_GOAL_BOUNDED;
  delete process.env.KHY_GOAL_MAX_TURNS;
  delete process.env.KHY_GOAL;
});
after(() => {
  if (_savedKhyosHome === undefined) {
    delete process.env.KHYOS_HOME;
  } else {
    process.env.KHYOS_HOME = _savedKhyosHome;
  }
  if (_savedBounded === undefined) {
    delete process.env.KHY_GOAL_BOUNDED;
  } else {
    process.env.KHY_GOAL_BOUNDED = _savedBounded;
  }
  if (_savedMax === undefined) {
    delete process.env.KHY_GOAL_MAX_TURNS;
  } else {
    process.env.KHY_GOAL_MAX_TURNS = _savedMax;
  }
  if (_savedEnable === undefined) {
    delete process.env.KHY_GOAL;
  } else {
    process.env.KHY_GOAL = _savedEnable;
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
// require 必须�?before 之后�?—�?node:test �?before 先于 test 执行,而顶�?require
// 只在模块加载(before 之前)。goalStore �?getBaseHome 是惰性的(_dir() 内调),故只�?// �?*首次 setGoal/advance 调用**�?KHYOS_HOME 已设定即�?�?顶层 require 安全�?const store = require('../goalStore');
const CWD = '/tmp/khy-bounded-project';

describe('Goal Store bounded', () => {
  test('有界推进:递减注入 �?耗尽终止 �?之后停注', () => {
      process.env.KHY_GOAL_MAX_TURNS = '3';
      const set = store.setGoal('找所�?Bug 并全部修�?, { cwd: CWD });
      expect(set.ok).toBe(true);
      expect(set.goal.turnsSpent).toBe(0);
      expect(set.goal.maxTurns).toBe(3);
    
      // �?1:�?2
      const d1 = store.advanceActiveGoalDirective({ cwd: CWD });
      expect(d1.includes('还剩 2 �?)).toBeTruthy();
      expect(store.getActiveGoal(CWD).turnsSpent).toBe(1);
    
      // �?2:�?1
      const d2 = store.advanceActiveGoalDirective({ cwd: CWD });
      expect(d2.includes('还剩 1 �?)).toBeTruthy();
      expect(store.getActiveGoal(CWD).turnsSpent).toBe(2);
    
      // �?3(cap):一次性终止指�?+ 退�?      const d3 = store.advanceActiveGoalDirective({ cwd: CWD });
      expect(d3.includes('终止�?exhausted)')).toBeTruthy();
      expect(d3).toContain('立即停止');
      // 已退�?pickActiveGoal 无命�?      expect(store.getActiveGoal(CWD)).toBe(null);
    
      // �?4:已退�?�?无注�?结构上不可能无限�?
      const d4 = store.advanceActiveGoalDirective({ cwd: CWD });
      expect(d4).toBe('');
    
      // 落盘 terminalStatus=exhausted
      const rec = store.listGoals().find((g) => g.scope === require('../goalCore').scopeKeyFor(CWD));
      expect(rec.active).toBe(false);
      expect(rec.terminalStatus).toBe('exhausted');
      expect(rec.turnsSpent).toBe(3);
      delete process.env.KHY_GOAL_MAX_TURNS;
  });

  test('KHY_GOAL_BOUNDED=off:不计�?+ 旧无界文�?字节回退)', () => {
      const CWD2 = '/tmp/khy-unbounded-project';
      store.setGoal('消除所有矛�?, { cwd: CWD2 });
      process.env.KHY_GOAL_BOUNDED = 'off';
      try {
        const d1 = store.advanceActiveGoalDirective({ cwd: CWD2 });
        // 旧无界文�?�?GoalTool(action=clear),不含「还�?N 轮�?        expect(d1.includes('GoalTool(action=clear)')).toBeTruthy();
        expect(!d1.includes('还剩')).toBeTruthy();
        // 不计�?turnsSpent 仍为 0,目标仍活�?        expect(store.getActiveGoal(CWD2).turnsSpent).toBe(0);
        // 再调仍不退�?        store.advanceActiveGoalDirective({ cwd: CWD2 });
        expect(store.getActiveGoal(CWD2).toBeTruthy());
      } finally {
        delete process.env.KHY_GOAL_BOUNDED;
      }
  });

  test('KHY_GOAL=off:无注�?与今天一�?', () => {
      const CWD3 = '/tmp/khy-disabled-project';
      store.setGoal('随便什�?, { cwd: CWD3 });
      process.env.KHY_GOAL = 'off';
      try {
        expect(store.advanceActiveGoalDirective({ cwd: CWD3 })).toBe('');
      } finally {
        delete process.env.KHY_GOAL;
      }
  });

  test('clearGoal �?terminalStatus:done vs abandoned', () => {
      const CWD4 = '/tmp/khy-clear-done';
      const CWD5 = '/tmp/khy-clear-abandon';
      const core = require('../goalCore');
    
      store.setGoal('done 目标', { cwd: CWD4 });
      store.clearGoal({ cwd: CWD4, reason: 'done' });
      const doneRec = store.listGoals().find((g) => g.scope === core.scopeKeyFor(CWD4));
      expect(doneRec.active).toBe(false);
      expect(doneRec.terminalStatus).toBe('done');
      expect(doneRec.terminatedAt).toBeTruthy();
    
      store.setGoal('abandon 目标', { cwd: CWD5 });
      store.clearGoal({ cwd: CWD5 }); // 默认 abandoned
      const abRec = store.listGoals().find((g) => g.scope === core.scopeKeyFor(CWD5));
      expect(abRec.terminalStatus).toBe('abandoned');
  });

  test('旧记�?�?active,�?turnsSpent)�?首次 advance 不抛、视�?1', () => {
      const core = require('../goalCore');
      // 直接写一�?旧格�?记录进盘(模拟线上历史 goals.json)
      const CWD6 = '/tmp/khy-legacy-record';
      const goalsFile = path.join(TMP, 'goals', 'goals.json');
      const legacy = {
        version: core.STORE_VERSION,
        goals: [
          { id: 'legacy1', text: '旧目�?, scope: core.scopeKeyFor(CWD6), cwd: CWD6, active: true },
        ],
      };
      fs.mkdirSync(path.dirname(goalsFile), { recursive: true });
      fs.writeFileSync(goalsFile, JSON.stringify(legacy), 'utf-8');
    
      process.env.KHY_GOAL_MAX_TURNS = '5';
      const d = store.advanceActiveGoalDirective({ cwd: CWD6 });
      expect(d.includes('还剩 4 �?)).toBeTruthy(); // spent=1 �?remaining=cap-1=4
      expect(store.getActiveGoal(CWD6).turnsSpent).toBe(1);
      delete process.env.KHY_GOAL_MAX_TURNS;
  });

});

