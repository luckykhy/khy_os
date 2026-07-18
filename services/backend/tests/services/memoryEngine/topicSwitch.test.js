'use strict';

/**
 * memoryEngine/topicSwitch — deterministic Jaccard topic-switch detector (node:test).
 * Pure leaf: no IO, tokens injected. Asserts same-set → no switch, disjoint →
 * switch, single-token suppression, empty baseline → no switch, tunable threshold.
 */
const test = require('node:test');
const assert = require('node:assert');

const ts = require('../../../src/services/memoryEngine/topicSwitch');

test('jaccard: 同集=1, 不相交=0, 双空=1', () => {
  assert.strictEqual(ts.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.strictEqual(ts.jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.strictEqual(ts.jaccard(new Set(), new Set()), 1);
  assert.strictEqual(ts.jaccard(new Set(['a', 'b']), new Set(['a'])), 0.5);
});

test('同话题(高重叠)→ 不换', () => {
  const a = new Set(['gateway', 'config', 'apikey']);
  const b = new Set(['gateway', 'config', 'apikey', 'model']);
  assert.strictEqual(ts.isTopicSwitch(a, b, {}), false);
});

test('不相交 token → 换话题', () => {
  const a = new Set(['deploy', 'kubernetes', 'pod']);
  const b = new Set(['gateway', 'config', 'apikey']);
  assert.strictEqual(ts.isTopicSwitch(a, b, {}), true);
});

test('单 token(< MIN_TOKENS)被抑制 → 不换', () => {
  assert.strictEqual(ts.isTopicSwitch(new Set(['hi']), new Set(['gateway', 'config']), {}), false);
});

test('空基线 → 不换(首 prime 由会话边界负责)', () => {
  assert.strictEqual(ts.isTopicSwitch(new Set(['a', 'b', 'c']), new Set(), {}), false);
  assert.strictEqual(ts.isTopicSwitch(new Set(['a', 'b', 'c']), null, {}), false);
});

test('阈值可调:JACCARD=0.9 使中等重叠也算换话题', () => {
  const a = new Set(['gateway', 'config', 'apikey']);
  const b = new Set(['gateway', 'config', 'apikey', 'model']); // J=0.75
  assert.strictEqual(ts.isTopicSwitch(a, b, { KHY_MEMORY_TOPIC_SWITCH_JACCARD: '0.9' }), true);
});

test('坏输入 → false(fail-soft)', () => {
  assert.strictEqual(ts.isTopicSwitch(undefined, undefined, {}), false);
  assert.strictEqual(ts.isTopicSwitch('not-a-set', 42, {}), false);
});
