'use strict';

const planModeService = require('../../src/services/planModeService');

describe('planModeService step-type taxonomy (固化/灵活/人闸门)', () => {
  describe('inferStepType', () => {
    test('destructive descriptions → human-gate', () => {
      expect(planModeService.inferStepType('删除旧的迁移文件')).toBe('human-gate');
      expect(planModeService.inferStepType('deploy to production')).toBe('human-gate');
      expect(planModeService.inferStepType('reset the database')).toBe('human-gate');
    });

    test('read-only descriptions → hardened', () => {
      expect(planModeService.inferStepType('查看现有配置')).toBe('hardened');
      expect(planModeService.inferStepType('list all users')).toBe('hardened');
      expect(planModeService.inferStepType('分析日志')).toBe('hardened');
    });

    test('generic work → flexible', () => {
      expect(planModeService.inferStepType('实现登录函数')).toBe('flexible');
      expect(planModeService.inferStepType('refactor the handler')).toBe('flexible');
    });

    test('falls back to flexible when riskGate is unavailable', () => {
      jest.resetModules();
      jest.doMock('../../src/services/riskGate', () => { throw new Error('gone'); });
      const fresh = require('../../src/services/planModeService');
      expect(fresh.inferStepType('删除一切')).toBe('flexible');
      jest.dontMock('../../src/services/riskGate');
      jest.resetModules();
    });
  });

  describe('parsePlanFromResponse', () => {
    test('every parsed step carries a valid stepType', () => {
      const text = '1. 查看现有配置\n2. 实现新函数\n3. 删除旧的迁移文件';
      const plan = planModeService.parsePlanFromResponse(text);
      const valid = new Set(['hardened', 'flexible', 'human-gate']);
      expect(plan.steps).toHaveLength(3);
      for (const step of plan.steps) {
        expect(valid.has(step.stepType)).toBe(true);
      }
      expect(plan.steps[0].stepType).toBe('hardened');
      expect(plan.steps[1].stepType).toBe('flexible');
      expect(plan.steps[2].stepType).toBe('human-gate');
    });
  });

  describe('stepTypeTag', () => {
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

    test('renders distinct tags per type', () => {
      expect(strip(planModeService.stepTypeTag('hardened'))).toBe('[固化] ');
      expect(strip(planModeService.stepTypeTag('flexible'))).toBe('[灵活] ');
      expect(strip(planModeService.stepTypeTag('human-gate'))).toContain('🔒人闸门');
    });

    test('unknown type → empty tag', () => {
      expect(planModeService.stepTypeTag('mystery')).toBe('');
    });
  });
});
