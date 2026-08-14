'use strict';

/**
 * busyTopicShift.test.js — 「忙碌插话转向新话题」判定的单测(node:test)。
 *
 * 判定用 overlap coefficient(包含度 = |A∩B|/min(|A|,|B|))而非 Jaccard,因为插话短、
 * 运行话题长,Jaccard 的并集项会把同话题的方向修正也压到极低而无法区分。覆盖:门控开/关、
 * min-tokens 下限、空基线、包含度高(留 steer)vs 低(判新话题)、阈值/下限 env 可调、
 * 坏输入绝不抛(fail-soft false)、确定性、overlapCoefficient 本身。
 *
 * 运行:node --test services/backend/tests/cli/repl/busyTopicShift.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const busyTopicShift = require('../../../src/cli/repl/busyTopicShift');
const { isNewTopicInterjection, isEnabled, overlapCoefficient } = busyTopicShift;

const ON = {};
const OFF = { KHY_BUSY_STEER_TOPIC_GUARD: 'off' };

test('门控默认 on;显式 off/0/false/no → 关', () => {
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ KHY_BUSY_STEER_TOPIC_GUARD: 'off' }), false);
  assert.equal(isEnabled({ KHY_BUSY_STEER_TOPIC_GUARD: '0' }), false);
  assert.equal(isEnabled({ KHY_BUSY_STEER_TOPIC_GUARD: 'false' }), false);
  assert.equal(isEnabled({ KHY_BUSY_STEER_TOPIC_GUARD: 'no' }), false);
  assert.equal(isEnabled({ KHY_BUSY_STEER_TOPIC_GUARD: 'on' }), true);
});

test('overlapCoefficient:包含度 = 交集/较小集;空集 → 0', () => {
  assert.equal(overlapCoefficient(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd'])), 1); // 短集全含于长集
  assert.equal(overlapCoefficient(new Set(['a', 'x']), new Set(['a', 'b', 'c', 'd'])), 0.5); // 1/2
  assert.equal(overlapCoefficient(new Set([]), new Set(['a'])), 0);
  assert.equal(overlapCoefficient(new Set(['a']), new Set([])), 0);
});

test('低包含度(换话题)→ true;高包含度(方向修正)→ false', () => {
  // 运行话题:重构支付网关(长集)。
  const baseline = new Set(['refactor', 'payment', 'gateway', 'adapter', 'timeout', 'retry', 'pool']);
  // 插话:仍在讲同一件事——短插话内容大多落在运行话题里(高包含度 → 留 steer)。
  const sameTopic = new Set(['payment', 'gateway', 'retry']); // 3/3 落在基线 → overlap 1.0
  assert.equal(isNewTopicInterjection(sameTopic, baseline, ON), false);
  // 插话:完全无关的新话题(写周报)——几乎不落在运行话题(低包含度 → 判新话题)。
  const newTopic = new Set(['write', 'weekly', 'report', 'summary', 'draft']); // 0/5 → overlap 0
  assert.equal(isNewTopicInterjection(newTopic, baseline, ON), true);
});

test('门控关 → 恒 false(逐字节回退今日 steer,即便明显换话题)', () => {
  const baseline = new Set(['refactor', 'payment', 'gateway']);
  const newTopic = new Set(['write', 'weekly', 'report']);
  assert.equal(isNewTopicInterjection(newTopic, baseline, OFF), false);
});

test('过短插话(< MIN_TOKENS)不判 → false(保守留 steer)', () => {
  const baseline = new Set(['refactor', 'payment', 'gateway']);
  assert.equal(isNewTopicInterjection(new Set(['ok']), baseline, ON), false);
  assert.equal(isNewTopicInterjection(new Set([]), baseline, ON), false);
});

test('空基线(无运行话题)→ false(无从比较,留 steer)', () => {
  const cur = new Set(['write', 'weekly', 'report']);
  assert.equal(isNewTopicInterjection(cur, new Set([]), ON), false);
  assert.equal(isNewTopicInterjection(cur, null, ON), false);
});

test('阈值 env 可调:调高 → 更易判新话题', () => {
  // 部分包含:短集 2/4 落在基线 → overlap 0.5。
  const baseline = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
  const cur = new Set(['a', 'b', 'x', 'y']); // min size 4, inter 2 → 0.5
  assert.equal(isNewTopicInterjection(cur, baseline, ON), false); // 0.5 >= 默认 0.12 → 非新话题
  assert.equal(
    isNewTopicInterjection(cur, baseline, { KHY_BUSY_STEER_TOPIC_OVERLAP: '0.6' }),
    true // 0.5 < 0.6 → 判新话题
  );
});

test('min-tokens env 可调:调高下限 → 中等长度插话不判', () => {
  const baseline = new Set(['refactor', 'payment', 'gateway']);
  const cur = new Set(['write', 'report']); // 2 tokens, overlap 0 → 新话题
  assert.equal(isNewTopicInterjection(cur, baseline, ON), true); // 默认下限 2 → 参与判定
  assert.equal(
    isNewTopicInterjection(cur, baseline, { KHY_BUSY_STEER_TOPIC_MIN_TOKENS: '3' }),
    false // 下限 3 → 过短不判
  );
});

test('接受数组入参(非 Set)', () => {
  const baseline = ['refactor', 'payment', 'gateway'];
  const newTopic = ['write', 'weekly', 'report'];
  assert.equal(isNewTopicInterjection(newTopic, baseline, ON), true);
});

test('坏输入绝不抛 → false(fail-soft)', () => {
  assert.equal(isNewTopicInterjection(undefined, undefined, ON), false);
  assert.equal(isNewTopicInterjection(42, {}, ON), false);
  assert.equal(isNewTopicInterjection('str', 'str', ON), false);
});

test('确定性:同一入参多次结果相同', () => {
  const baseline = new Set(['refactor', 'payment', 'gateway']);
  const cur = new Set(['write', 'weekly', 'report']);
  assert.equal(isNewTopicInterjection(cur, baseline, ON), isNewTopicInterjection(cur, baseline, ON));
});
