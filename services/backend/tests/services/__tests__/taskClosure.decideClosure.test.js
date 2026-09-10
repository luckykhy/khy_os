'use strict';
/**
 * taskClosure.decideClosure.test.js �?单一权威收尾仲裁器（纯叶子）契约测试�? *
 * 覆盖三态仲裁与预算语义（接线点 toolUseLoopCore「任务收尾仲裁门」依赖这些行为）�? *  - close:终态交�?+ 无未完成步骤 + 无虚假验证声�? *  - redrive(not-concluded):回复无终态信号且预算未耗尽
 *  - redrive(steps-incomplete):声称完成但计划步骤未完成
 *  - redrive(verification-missing):声称验证通过却无真实验证命令记录
 *  - close_partial:预算耗尽后诚实降级，绝不无限续跑
 *  - resolveMaxRedrives:env 解析�?clamp
 */
const closure = require('../taskClosure');
// 注意：不要在「干净收尾」的回复里写「测试通过/已验证」类声称——那会触发证据门
// （声称验证却无真实验证命�?�?redrive），证据门有自己的专项测试�?const DONE_REPLY = '任务已完成：config.json 已按需求写入�?;

describe('Task Closure decide Closure', () => {
  test('decideClosure: 终态交�?+ 无未完成步骤 �?close', () => {
      const v = closure.decideClosure({
        reply: DONE_REPLY,
        planSteps: [{ label: '写配�?, status: 'completed' }],
        toolCallLog: [],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('close');
      expect(v.reason).toBe('concluded');
  });

  test('decideClosure: 无终态信�?�?redrive(not-concluded)，带再驱动文�?, () => {
      const v = closure.decideClosure({
        reply: '让我看看这个文件的情况�?,
        planSteps: [],
        toolCallLog: [],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('not-concluded');
      expect(v.message).toContain('终态交�?);
  });

  test('decideClosure: 声称完成但计划步骤未完成 �?redrive(steps-incomplete)', () => {
      const v = closure.decideClosure({
        reply: DONE_REPLY,
        planSteps: [
          { label: '写配�?, status: 'completed' },
          { label: '跑测�?, status: 'pending' },
        ],
        toolCallLog: [],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('steps-incomplete');
      expect(v.message).toContain('跑测�?);
  });

  test('decideClosure: 真实验证命令已运�?�?验证声称成立 �?close', () => {
      const v = closure.decideClosure({
        reply: '已完成，测试都通过了�?,
        planSteps: [{ label: '写配�?, status: 'completed' }],
        toolCallLog: [{ tool: 'bash', success: true, params: { command: 'npm test' } }],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('close');
      expect(v.reason).toBe('concluded');
  });

  test('decideClosure: 声称验证通过但未真实运行验证命令 �?redrive(verification-missing)', () => {
      const v = closure.decideClosure({
        reply: '已完成，已验证通过�?,
        planSteps: [],
        toolCallLog: [{ tool: 'bash', success: true, params: { command: 'ls -la' } }],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('redrive');
      expect(v.reason).toBe('verification-missing');
  });

  test('decideClosure: 预算耗尽 �?close_partial 诚实降级（不无限续跑�?, () => {
      const v = closure.decideClosure({
        reply: '让我看看这个文件的情况�?,
        planSteps: [{ label: '写配�?, status: 'pending' }],
        toolCallLog: [],
        redriveCount: 1,
        maxRedrives: 1,
        env: {},
      });
      expect(v.action).toBe('close_partial');
      expect(v.note).toContain('未能完整闭环');
      expect(v.note).toContain('写配�?);
  });

  test('decideClosure: 跳过的步骤（skipped/n-a）不算未完成', () => {
      const v = closure.decideClosure({
        reply: DONE_REPLY,
        planSteps: [{ label: '可选步�?, status: 'skipped' }],
        toolCallLog: [],
        redriveCount: 0,
        env: {},
      });
      expect(v.action).toBe('close');
  });

  test('resolveMaxRedrives: 缺省 1；env 数字生效�?clamp [0,6]；非法回默认', () => {
      expect(closure.resolveMaxRedrives(undefined, {})).toBe(1);
      expect(closure.resolveMaxRedrives(undefined, { KHY_TASK_CLOSURE_REDRIVE_MAX: '3' })).toBe(3);
      expect(closure.resolveMaxRedrives(undefined, { KHY_TASK_CLOSURE_REDRIVE_MAX: '99' })).toBe(6);
      expect(closure.resolveMaxRedrives(undefined, { KHY_TASK_CLOSURE_REDRIVE_MAX: 'abc' })).toBe(1);
      expect(closure.resolveMaxRedrives(0, {})).toBe(0);
  });

});

