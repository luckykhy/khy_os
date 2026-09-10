'use strict';
/**
 * goalCore.bounded.test.js �?纯叶子「有界终止态」契�?node:test)�? *
 * 覆盖:门控 isBounded、预算解�?resolveMaxTurns、记录字段、纯推进 advanceGoalTurn/
 * remainingTurns(不改入参)、有界指�?buildBoundedDirective(未耗尽 vs 一次性终�?�? * �?IO、确定性——不触磁盘、不依赖 env(每个断言显式�?env)�? */
const core = require('../goalCore');

describe('Goal Core bounded', () => {
  test('isBounded 默认 true;仅显�?falsy 关闭', () => {
      expect(core.isBounded({})).toBe(true);
      expect(core.isBounded({ KHY_GOAL_BOUNDED: '1' })).toBe(true);
      expect(core.isBounded({ KHY_GOAL_BOUNDED: 'true' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(core.isBounded({ KHY_GOAL_BOUNDED: v })).toBe(false);
      }
  });

  test('resolveMaxTurns:默认 25、env 覆盖、非法回退、clamp 上限', () => {
      expect(core.resolveMaxTurns({})).toBe(core.GOAL_DEFAULT_MAX_TURNS);
      expect(core.GOAL_DEFAULT_MAX_TURNS).toBe(25);
      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '5' })).toBe(5);
      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: ' 8 ' })).toBe(8);
      // 非法/0/�?�?记录 fallback,再默�?      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '0' }, 7)).toBe(7);
      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: 'abc' }, 'nope')).toBe(25);
      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '-3' })).toBe(25);
      // clamp 上限 1000
      expect(core.resolveMaxTurns({ KHY_GOAL_MAX_TURNS: '999999' })).toBe(1000);
      // fallback 参数(记录自带 maxTurns)
      expect(core.resolveMaxTurns({}, 12)).toBe(12);
      expect(core.resolveMaxTurns({}, 99999)).toBe(1000);
  });

  test('GOAL_TERMINAL_STATUSES 冻结且含 done/exhausted/abandoned', () => {
      assert.deepEqual([...core.GOAL_TERMINAL_STATUSES].sort(), ['abandoned', 'done', 'exhausted']);
      expect(Object.isFrozen(core.GOAL_TERMINAL_STATUSES).toBeTruthy());
  });

  test('buildGoalRecord �?turnsSpent=0 / terminalStatus=null / maxTurns', () => {
      const r = core.buildGoalRecord({ text: '把发布做�?, cwd: '/tmp/proj', maxTurns: 9 });
      expect(r.ok).toBe(true);
      expect(r.goal.turnsSpent).toBe(0);
      expect(r.goal.terminalStatus).toBe(null);
      expect(r.goal.maxTurns).toBe(9);
      expect(r.goal.active).toBe(true);
      // �?maxTurns �?默认
      const d = core.buildGoalRecord({ text: 'x', cwd: '/tmp/p' });
      expect(d.goal.maxTurns).toBe(25);
      // 空文�?�?失败
      expect(core.buildGoalRecord({ text: '   ' }).ok).toBe(false);
  });

  test('advanceGoalTurn:递增、耗尽标志、纯函数不改入参', () => {
      const goal = { text: 'g', maxTurns: 3, turnsSpent: 0 };
      const t1 = core.advanceGoalTurn(goal, {});
      assert.deepEqual(t1, { spent: 1, cap: 3, remaining: 2, justExhausted: false });
      // 入参未被修改
      expect(goal.turnsSpent).toBe(0);
    
      const t3 = core.advanceGoalTurn({ text: 'g', maxTurns: 3, turnsSpent: 2 }, {});
      expect(t3.spent).toBe(3);
      expect(t3.remaining).toBe(0);
      expect(t3.justExhausted).toBe(true);
    
      // 已超也标记耗尽,remaining 夹到 0
      const over = core.advanceGoalTurn({ text: 'g', maxTurns: 3, turnsSpent: 9 }, {});
      expect(over.justExhausted).toBe(true);
      expect(over.remaining).toBe(0);
    
      // env 覆盖优先于记�?maxTurns
      const envCap = core.advanceGoalTurn(
        { text: 'g', maxTurns: 3, turnsSpent: 4 },
        { KHY_GOAL_MAX_TURNS: '10' }
      );
      expect(envCap.cap).toBe(10);
      expect(envCap.justExhausted).toBe(false);
  });

  test('remainingTurns:旧记�?�?turnsSpent)�?0 起算,不抛', () => {
      expect(core.remainingTurns({ text: 'g', maxTurns: 5 }, {})).toBe(5);
      expect(core.remainingTurns({ text: 'g', maxTurns: 5, turnsSpent: 2 }, {})).toBe(3);
      expect(core.remainingTurns(null, {})).toBe(25);
  });

  test('buildBoundedDirective:未耗尽含剩余轮�?收敛语义', () => {
      const d = core.buildBoundedDirective(
        { text: '修所�?Bug' },
        { cap: 25, remaining: 12, justExhausted: false }
      );
      expect(d).toContain('还剩 12 �?);
      expect(d).toContain('�?25 �?);
      expect(d).toContain('有界任务');
      expect(d).toContain('不要无限循环');
      expect(d).toContain('修所�?Bug');
      expect(!d.includes('终止�?exhausted).toBeTruthy()'));
  });

  test('buildBoundedDirective:耗尽=一次性终止指�?, () => {
      const d = core.buildBoundedDirective(
        { text: '修所�?Bug' },
        { cap: 25, remaining: 0, justExhausted: true }
      );
      expect(d.includes('终止�?exhausted).toBeTruthy()'));
      expect(d).toContain('立即停止');
      expect(d).toContain('完成/现状报告');
      expect(d).toContain('�?25 �?);
  });

  test('buildBoundedDirective:无目�?�?空串', () => {
      expect(core.buildBoundedDirective(null, { justExhausted: false })).toBe('');
      expect(core.buildBoundedDirective({ text: '' }, { justExhausted: true })).toBe('');
  });

});

