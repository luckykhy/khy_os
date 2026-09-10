'use strict';
/**
 * roundAdvanceAssessor.test.js �?每轮任务推进判决纯叶子契�?node:test)�? *
 * 覆盖:门控(默认开 / 显式 falsy �?/ 注册表委�?、VERDICTS 冻结�? * assessRoundAdvance(全去重→停滞 / 全失败→空转 / 状态变更→推进 high / 新信息→推进 medium /
 * 混合去重+新成功→推进 / 无工具轮 null / 门关 null / 坏输入不�?。零 IO、确定性——显式传 env�? */
const ra = require('../roundAdvanceAssessor');
const ON = {}; // 默认开

describe('Round Advance Assessor', () => {
  test('isRoundAdvanceEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(ra.isRoundAdvanceEnabled({})).toBe(true);
      expect(ra.isRoundAdvanceEnabled({ KHY_ROUND_ADVANCE_ASSESS: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
        expect(ra.isRoundAdvanceEnabled({ KHY_ROUND_ADVANCE_ASSESS: v })).toBe(false);
      }
  });

  test('isRoundAdvanceEnabled:注册表关时回退私有判定(逐字节等�?', () => {
      expect(ra.isRoundAdvanceEnabled({ KHY_FLAG_REGISTRY: '0' })).toBe(true);
      assert.equal(
        ra.isRoundAdvanceEnabled({ KHY_FLAG_REGISTRY: '0', KHY_ROUND_ADVANCE_ASSESS: 'off' }),
        false
      );
  });

  test('VERDICTS:冻结(纯叶子不可变)且含三类判决', () => {
      expect(Object.isFrozen(ra.VERDICTS).toBeTruthy());
      for (const k of ['advanced', 'stalled', 'unproductive']) {
        expect(ra.VERDICTS[k] && Object.isFrozen(ra.VERDICTS[k])).toBeTruthy();
        expect(typeof ra.VERDICTS[k].label === 'string').toBeTruthy();
      }
      expect(ra.VERDICTS.advanced.necessary).toBe(true);
      expect(ra.VERDICTS.stalled.necessary).toBe(false);
  });

  test('assessRoundAdvance:状态变�?写文�?�?推进 · 价�?high · 必要', () => {
      const v = ra.assessRoundAdvance(
        {
          total: 2,
          succeeded: 2,
          failed: 0,
          deduped: 0,
          breakdown: { reads: 0, searches: 0, writes: 2, commands: 0, agents: 0 },
          modifiedFiles: ['a.js', 'b.js'],
        },
        ON
      );
      expect(v.verdict).toBe('advanced');
      expect(v.advanced).toBe(true);
      expect(v.value).toBe('high');
      expect(v.necessary).toBe(true);
      expect(v.label).toBe('推进');
      expect(v.reason).toMatch(/推进/);
  });

  test('assessRoundAdvance:执行命令 / 委派子任�?也算状态变�?�?推进 high', () => {
      const cmd = ra.assessRoundAdvance(
        {
          total: 1,
          succeeded: 1,
          failed: 0,
          deduped: 0,
          breakdown: { commands: 1 },
          modifiedFiles: [],
        },
        ON
      );
      expect(cmd.value).toBe('high');
      const agent = ra.assessRoundAdvance(
        {
          total: 1,
          succeeded: 1,
          failed: 0,
          deduped: 0,
          breakdown: { agents: 1 },
          modifiedFiles: [],
        },
        ON
      );
      expect(agent.value).toBe('high');
  });

  test('assessRoundAdvance:仅读�?搜索(新信�?�?推进 · 价�?medium', () => {
      const v = ra.assessRoundAdvance(
        {
          total: 3,
          succeeded: 3,
          failed: 0,
          deduped: 0,
          breakdown: { reads: 2, searches: 1 },
          modifiedFiles: [],
        },
        ON
      );
      expect(v.verdict).toBe('advanced');
      expect(v.value).toBe('medium');
      expect(v.necessary).toBe(true);
  });

  test('assessRoundAdvance:全部命中去重 �?停滞 · 价�?low · 不必�?, () => {
      const v = ra.assessRoundAdvance(
        {
          total: 3,
          succeeded: 3,
          failed: 0,
          deduped: 3,
          breakdown: { reads: 3 },
          modifiedFiles: [],
        },
        ON
      );
      expect(v.verdict).toBe('stalled');
      expect(v.advanced).toBe(false);
      expect(v.value).toBe('low');
      expect(v.necessary).toBe(false);
      expect(v.label).toBe('停滞');
  });

  test('assessRoundAdvance:无新成功且有失败 �?空转 · 价�?low', () => {
      const v = ra.assessRoundAdvance(
        {
          total: 2,
          succeeded: 0,
          failed: 2,
          deduped: 0,
          breakdown: { commands: 2 },
          modifiedFiles: [],
        },
        ON
      );
      expect(v.verdict).toBe('unproductive');
      expect(v.advanced).toBe(false);
      expect(v.value).toBe('low');
      expect(v.label).toBe('空转');
  });

  test('assessRoundAdvance:去重+新成功混�?�?只按新成功判为推�?, () => {
      // 3 次调�?2 去重(重放)+ 1 新写入成�?�?newSuccess=1 �?推进 high
      const v = ra.assessRoundAdvance(
        {
          total: 3,
          succeeded: 3,
          failed: 0,
          deduped: 2,
          breakdown: { reads: 2, writes: 1 },
          modifiedFiles: ['x.js'],
        },
        ON
      );
      expect(v.verdict).toBe('advanced');
      expect(v.value).toBe('high');
  });

  test('assessRoundAdvance:全去重优先于新成功判�?deduped===total 即停�?', () => {
      const v = ra.assessRoundAdvance(
        {
          total: 2,
          succeeded: 2,
          failed: 0,
          deduped: 2,
          breakdown: { writes: 2 },
          modifiedFiles: ['x.js'],
        },
        ON
      );
      expect(v.verdict).toBe('stalled');
  });

  test('assessRoundAdvance:门关 �?�?null(接线处逐字节回退,不附 advance 字段)', () => {
      assert.equal(
        ra.assessRoundAdvance(
          { total: 1, succeeded: 1, breakdown: { writes: 1 } },
          { KHY_ROUND_ADVANCE_ASSESS: 'off' }
        ),
        null
      );
      assert.equal(
        ra.assessRoundAdvance(
          { total: 1, succeeded: 1 },
          { KHY_FLAG_REGISTRY: '0', KHY_ROUND_ADVANCE_ASSESS: '0' }
        ),
        null
      );
  });

  test('assessRoundAdvance:无工具执行的轮次(total<=0)�?�?null(不在本叶子评估范�?', () => {
      expect(ra.assessRoundAdvance({ total: 0 }, ON)).toBe(null);
      expect(ra.assessRoundAdvance({}, ON)).toBe(null);
  });

  test('assessRoundAdvance:坏输�?�?�?null 不抛', () => {
      expect(() => ra.assessRoundAdvance(undefined, ON).not.toThrow());
      expect(() => ra.assessRoundAdvance(null, ON).not.toThrow());
      expect(() => ra.assessRoundAdvance(42, ON).not.toThrow());
      expect(ra.assessRoundAdvance(undefined, ON)).toBe(null);
      // breakdown 缺失 / 非对象也不抛
      assert.doesNotThrow(() =>
        ra.assessRoundAdvance({ total: 1, succeeded: 1, breakdown: 'nope' }, ON)
      );
  });

});

