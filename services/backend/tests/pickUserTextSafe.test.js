'use strict';

/**
 * pickUserTextSafe.test.js — 锁 utils/pickUserTextSafe 口径
 *   (收敛 cacheMetricsTruth·visionRoutingTruth 2 处 body 相同的 pickUserText)。
 *
 * 覆盖:委托主路径 + 异常兜底(直取 prompt / 倒序扫 messages / 数组 content / 空)·绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');

const pickUserText = require('../src/utils/pickUserTextSafe');

test('直取 prompt(trim)', () => {
  assert.strictEqual(pickUserText('  hello  ', {}), 'hello');
});

test('prompt 空 → 倒序扫 messages 取最后一条 user 字符串', () => {
  assert.strictEqual(
    pickUserText('', { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'last' }] }),
    'last'
  );
});

test('数组 content → 拼接 text/content 片段', () => {
  assert.strictEqual(
    pickUserText('', { messages: [{ role: 'user', content: [{ text: 'a' }, 'b', { content: 'c' }] }] }),
    'a b c'
  );
});

test('无可取文本 → 空串', () => {
  assert.strictEqual(pickUserText('', {}), '');
  assert.strictEqual(pickUserText(null, null), '');
});

test('绝不抛(畸形入参)', () => {
  assert.doesNotThrow(() => pickUserText({}, { messages: 'not-array' }));
  assert.doesNotThrow(() => pickUserText(undefined, undefined));
});

test('两消费方导出同一引用(真收敛 SSOT)', () => {
  const cm = require('../src/services/cacheMetricsTruth');
  const vr = require('../src/services/visionRoutingTruth');
  assert.strictEqual(cm.pickUserText, vr.pickUserText);
  assert.strictEqual(cm.pickUserText, pickUserText);
});
