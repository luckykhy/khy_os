'use strict';

// Unit tests for the seamless-resume default-budget pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const sr = require('../../../src/services/query/seamlessResume');

const ON = {}; // 默认开
const OFF = { KHY_SEAMLESS_RESUME: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.equal(sr.isEnabled(ON), true);
  assert.equal(sr.isEnabled(undefined), true);
});

test('isEnabled: 0/false/off/no → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(sr.isEnabled({ KHY_SEAMLESS_RESUME: v }), false, `value ${v}`);
  }
});

// ── defaultTransientBudget ─────────────────────────────────────────────────
test('defaultTransientBudget: 门控开 → 均衡地板 {small:1, normal:2, large:3}', () => {
  assert.equal(sr.defaultTransientBudget('small', ON), 1);
  assert.equal(sr.defaultTransientBudget('normal', ON), 2);
  assert.equal(sr.defaultTransientBudget('large', ON), 3);
});

test('defaultTransientBudget: 门控关 → 逐字节回退现状 {small:0, normal:1, large:3}', () => {
  assert.equal(sr.defaultTransientBudget('small', OFF), 0);
  assert.equal(sr.defaultTransientBudget('normal', OFF), 1);
  assert.equal(sr.defaultTransientBudget('large', OFF), 3);
});

test('defaultTransientBudget: 未知/缺省 scale → 归 normal', () => {
  assert.equal(sr.defaultTransientBudget('medium', ON), 2);
  assert.equal(sr.defaultTransientBudget('', ON), 2);
  assert.equal(sr.defaultTransientBudget(undefined, ON), 2);
  assert.equal(sr.defaultTransientBudget(null, OFF), 1);
});

test('defaultTransientBudget: scale 大小写/空白不敏感', () => {
  assert.equal(sr.defaultTransientBudget('SMALL', ON), 1);
  assert.equal(sr.defaultTransientBudget(' Large ', ON), 3);
});

// ── 常量自证(防回归)────────────────────────────────────────────────────────
test('ON_DEFAULTS 比 LEGACY_DEFAULTS 对 small/normal 抬升、large 持平', () => {
  assert.ok(sr.ON_DEFAULTS.small > sr.LEGACY_DEFAULTS.small);
  assert.ok(sr.ON_DEFAULTS.normal > sr.LEGACY_DEFAULTS.normal);
  assert.equal(sr.ON_DEFAULTS.large, sr.LEGACY_DEFAULTS.large);
});
