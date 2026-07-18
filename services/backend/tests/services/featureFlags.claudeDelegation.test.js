'use strict';

/**
 * featureFlags — claudeDelegation 开关特征化测试（node:test）。
 *
 * 守护：claudeDelegation 默认 off（实验性、opt-in，避免无谓 spawn 重进程），
 * 且 env 覆盖优先级最高（KHY_FEATURE_CLAUDEDELEGATION=1 可临时打开）。
 */

const test = require('node:test');
const assert = require('node:assert');

const featureFlags = require('../../src/services/featureFlags');

test('claudeDelegation 默认 false（实验性 opt-in）', () => {
  assert.strictEqual(featureFlags.DEFAULTS.claudeDelegation, false);
});

test('env KHY_FEATURE_CLAUDEDELEGATION=1 覆盖为 true', () => {
  const prev = process.env.KHY_FEATURE_CLAUDEDELEGATION;
  process.env.KHY_FEATURE_CLAUDEDELEGATION = '1';
  try {
    assert.strictEqual(featureFlags.isEnabled('claudeDelegation'), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_FEATURE_CLAUDEDELEGATION;
    else process.env.KHY_FEATURE_CLAUDEDELEGATION = prev;
  }
});

test('env KHY_FEATURE_CLAUDEDELEGATION=false 覆盖为 false', () => {
  const prev = process.env.KHY_FEATURE_CLAUDEDELEGATION;
  process.env.KHY_FEATURE_CLAUDEDELEGATION = 'false';
  try {
    assert.strictEqual(featureFlags.isEnabled('claudeDelegation'), false);
  } finally {
    if (prev === undefined) delete process.env.KHY_FEATURE_CLAUDEDELEGATION;
    else process.env.KHY_FEATURE_CLAUDEDELEGATION = prev;
  }
});

test('listFeatures 含 claudeDelegation 项', () => {
  const names = featureFlags.listFeatures().map(f => f.name);
  assert.ok(names.includes('claudeDelegation'), `listFeatures 应含 claudeDelegation: ${names.join(',')}`);
});
