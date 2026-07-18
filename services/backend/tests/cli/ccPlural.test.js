'use strict';

/**
 * ccPlural 纯叶子单测(node:test)。
 *
 * 验证 CC 源 `src/utils/stringUtils.ts::plural`(`n === 1 ? word : pluralWord`,
 * 默认 `pluralWord = word + 's'`)逐字节移植,以及 `pluralOr` 的门控梯
 * (门控开 → CC plural;门控关 → 复数形 = 各 call-site 历史硬编码形逐字节回退)。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isEnabled, plural, pluralOr } = require('../../src/cli/ccPlural');

const ON = {};
const OFF = { KHY_CC_PLURAL: 'off' };

test('isEnabled: 默认开 / 关梯', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ KHY_CC_PLURAL: '' }), true);
  assert.equal(isEnabled({ KHY_CC_PLURAL: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(isEnabled({ KHY_CC_PLURAL: off }), false, off);
  }
});

test('plural: n===1 单数,否则复数形(默认 word+s)', () => {
  assert.equal(plural(1, 'line'), 'line');
  assert.equal(plural(0, 'line'), 'lines'); // 0 ≠ 1 → 复数(0 lines)
  assert.equal(plural(2, 'line'), 'lines');
  assert.equal(plural(1, 'file'), 'file');
  assert.equal(plural(3, 'file'), 'files');
});

test('plural: 显式 pluralWord(不规则复数 match→matches)', () => {
  assert.equal(plural(1, 'match', 'matches'), 'match');
  assert.equal(plural(5, 'match', 'matches'), 'matches');
  assert.equal(plural(0, 'match', 'matches'), 'matches');
});

test('plural: CC 严格 ===1(字符串 "1" 取复数,与 CC 同不强转)', () => {
  assert.equal(plural('1', 'line'), 'lines');
});

test('pluralOr: 门控开 → CC plural(n===1 单数)', () => {
  assert.equal(pluralOr(1, 'match', 'matches', ON), 'match');
  assert.equal(pluralOr(5, 'match', 'matches', ON), 'matches');
  assert.equal(pluralOr(1, 'line', undefined, ON), 'line');
  assert.equal(pluralOr(2, 'file', undefined, ON), 'files');
});

test('pluralOr: 门控关 → 复数形(各 call-site legacy 硬编码形逐字节回退)', () => {
  assert.equal(pluralOr(1, 'match', 'matches', OFF), 'matches');
  assert.equal(pluralOr(1, 'line', undefined, OFF), 'lines');
  assert.equal(pluralOr(1, 'file', undefined, OFF), 'files');
  assert.equal(pluralOr(5, 'match', 'matches', OFF), 'matches');
});

test('pluralOr: 门控开关唯一分歧 = n===1(同 5 项两态恒复数;1 项开单数关复数)', () => {
  assert.equal(pluralOr(1, 'match', 'matches', ON), 'match');
  assert.equal(pluralOr(1, 'match', 'matches', OFF), 'matches');
  assert.equal(pluralOr(5, 'match', 'matches', ON), pluralOr(5, 'match', 'matches', OFF)); // n≠1 两态一致
});

test('pluralOr: 默认门控(无 env)= 开', () => {
  const prev = process.env.KHY_CC_PLURAL;
  delete process.env.KHY_CC_PLURAL;
  try {
    assert.equal(pluralOr(1, 'line'), 'line');
  } finally {
    if (prev == null) delete process.env.KHY_CC_PLURAL;
    else process.env.KHY_CC_PLURAL = prev;
  }
});
