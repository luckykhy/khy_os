'use strict';

/**
 * config.test.js — DESIGN-ARCH-049 G1 (trajectoryGuide config knobs).
 *
 * Every capability defaults OFF and every knob resolves its named default with no
 * env set; overrides parse as documented. This guards the 零回归 invariant: with
 * no KHY_TRAJ_* set, nothing in the AI dimension activates.
 */

const test = require('node:test');
const assert = require('node:assert');

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

test('defaults: every capability is off and knobs resolve named defaults', () => {
  clearEnv();
  assert.strictEqual(config.isAiReplayEnabled(), false);
  assert.strictEqual(config.isGuideInjectEnabled(), false);
  assert.strictEqual(config.repairMax(), 1);
  assert.strictEqual(config.repairTimeoutMs(), 120000);
  assert.strictEqual(config.repairModel(), null);
  assert.strictEqual(config.mapAuthorMinStrength(), 'strong');
  assert.strictEqual(config.guideChars(), 1200);
});

test('flags accept on/1/true/yes case-insensitively, reject others', () => {
  clearEnv();
  for (const v of ['on', '1', 'true', 'YES', 'On']) {
    process.env.KHY_TRAJ_AI_REPLAY = v;
    assert.strictEqual(config.isAiReplayEnabled(), true, `expected ${v} truthy`);
  }
  for (const v of ['off', '0', 'false', 'no', '']) {
    process.env.KHY_TRAJ_AI_REPLAY = v;
    assert.strictEqual(config.isAiReplayEnabled(), false, `expected ${v} falsy`);
  }
  clearEnv();
});

test('positive-int knobs parse overrides and ignore invalid values', () => {
  clearEnv();
  process.env.KHY_TRAJ_REPAIR_MAX = '3';
  process.env.KHY_TRAJ_REPAIR_TIMEOUT_MS = '5000';
  process.env.KHY_TRAJ_GUIDE_CHARS = '800';
  assert.strictEqual(config.repairMax(), 3);
  assert.strictEqual(config.repairTimeoutMs(), 5000);
  assert.strictEqual(config.guideChars(), 800);

  process.env.KHY_TRAJ_REPAIR_MAX = 'nonsense';
  process.env.KHY_TRAJ_GUIDE_CHARS = '-5';
  assert.strictEqual(config.repairMax(), 1, 'invalid → default');
  assert.strictEqual(config.guideChars(), 1200, 'negative → default');
  clearEnv();
});

test('repairModel trims and nullifies blanks; mapAuthorMinStrength is constrained', () => {
  clearEnv();
  process.env.KHY_TRAJ_REPAIR_MODEL = '  claude-haiku-4-5  ';
  assert.strictEqual(config.repairModel(), 'claude-haiku-4-5');
  process.env.KHY_TRAJ_REPAIR_MODEL = '   ';
  assert.strictEqual(config.repairModel(), null);

  process.env.KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH = 'weak';
  assert.strictEqual(config.mapAuthorMinStrength(), 'weak');
  process.env.KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH = 'bogus';
  assert.strictEqual(config.mapAuthorMinStrength(), 'strong', 'invalid → default strong');
  clearEnv();
});

test('barrel re-exports config', () => {
  const barrel = require('../../../src/services/trajectoryGuide');
  assert.strictEqual(typeof barrel.config.isAiReplayEnabled, 'function');
});
