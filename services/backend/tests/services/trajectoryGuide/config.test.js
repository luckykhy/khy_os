'use strict';
/**
 * config.test.js â€?DESIGN-ARCH-049 G1 (trajectoryGuide config knobs).
 *
 * Every capability defaults OFF and every knob resolves its named default with no
 * env set; overrides parse as documented. This guards the é›¶å›žå½?invariant: with
 * no KHY_TRAJ_* set, nothing in the AI dimension activates.
 */
const config = require('../../../src/services/trajectoryGuide/config');
const TRAJ_ENV = [
  'KHY_TRAJ_AI_REPLAY',
  'KHY_TRAJ_GUIDE_INJECT',
  'KHY_TRAJ_REPAIR_MAX',
  'KHY_TRAJ_REPAIR_MODEL',
  'KHY_TRAJ_REPAIR_TIMEOUT_MS',
  'KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH',
  'KHY_TRAJ_GUIDE_CHARS',
];
function clearEnv() {
  for (const k of TRAJ_ENV) delete process.env[k];
}

describe('Config', () => {
  test('defaults: every capability is off and knobs resolve named defaults', () => {
      clearEnv();
      expect(config.isAiReplayEnabled()).toBe(false);
      expect(config.isGuideInjectEnabled()).toBe(false);
      expect(config.repairMax()).toBe(1);
      expect(config.repairTimeoutMs()).toBe(120000);
      expect(config.repairModel()).toBe(null);
      expect(config.mapAuthorMinStrength()).toBe('strong');
      expect(config.guideChars()).toBe(1200);
  });

  test('flags accept on/1/true/yes case-insensitively, reject others', () => {
      clearEnv();
      for (const v of ['on', '1', 'true', 'YES', 'On']) {
        process.env.KHY_TRAJ_AI_REPLAY = v;
        expect(config.isAiReplayEnabled()).toBe(true, `expected ${v} truthy`);
      }
      for (const v of ['off', '0', 'false', 'no', '']) {
        process.env.KHY_TRAJ_AI_REPLAY = v;
        expect(config.isAiReplayEnabled()).toBe(false, `expected ${v} falsy`);
      }
      clearEnv();
  });

  test('positive-int knobs parse overrides and ignore invalid values', () => {
      clearEnv();
      process.env.KHY_TRAJ_REPAIR_MAX = '3';
      process.env.KHY_TRAJ_REPAIR_TIMEOUT_MS = '5000';
      process.env.KHY_TRAJ_GUIDE_CHARS = '800';
      expect(config.repairMax()).toBe(3);
      expect(config.repairTimeoutMs()).toBe(5000);
      expect(config.guideChars()).toBe(800);
    
      process.env.KHY_TRAJ_REPAIR_MAX = 'nonsense';
      process.env.KHY_TRAJ_GUIDE_CHARS = '-5';
      expect(config.repairMax()).toBe(1, 'invalid â†?default');
      expect(config.guideChars()).toBe(1200, 'negative â†?default');
      clearEnv();
  });

  test('repairModel trims and nullifies blanks; mapAuthorMinStrength is constrained', () => {
      clearEnv();
      process.env.KHY_TRAJ_REPAIR_MODEL = '  claude-haiku-4-5  ';
      expect(config.repairModel()).toBe('claude-haiku-4-5');
      process.env.KHY_TRAJ_REPAIR_MODEL = '   ';
      expect(config.repairModel()).toBe(null);
    
      process.env.KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH = 'weak';
      expect(config.mapAuthorMinStrength()).toBe('weak');
      process.env.KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH = 'bogus';
      expect(config.mapAuthorMinStrength()).toBe('strong', 'invalid â†?default strong');
      clearEnv();
  });

  test('barrel re-exports config', () => {
      const barrel = require('../../../src/services/trajectoryGuide');
      expect(typeof barrel.config.isAiReplayEnabled).toBe('function');
  });

});

