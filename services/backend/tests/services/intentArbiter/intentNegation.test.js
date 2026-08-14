'use strict';

/**
 * intentNegation.test.js — 纯叶子「否定语境检测」契约（P0#1）。
 *
 * 验证:门控梯、前向邻接否定、后向情态否定、`不仅/不但` 让步词不误伤、
 *      `别执行A但执行B` 保留主动命令、门控关字节回退、防呆非串入参不抛。
 */

const test = require('node:test');
const assert = require('node:assert');
const neg = require('../../../src/services/intentArbiter/intentNegation');

// 与 intentLexicon 同表(测试内联,避免对词库顺序耦合)。
const LEX = {
  markers: ['不要', '别', '不用', '不必', '无需', '别再', '先别', '不想', '不需要', '没', '没有', '勿', '甭', '不'],
  modals: ['不了', '不动', '不起来', '不下去', '失败', '出错', '报错', '不成'],
};

test('isEnabled: 默认开;{0,false,off,no} 关闭', () => {
  assert.strictEqual(neg.isEnabled({}), true);
  assert.strictEqual(neg.isEnabled({ KHY_INTENT_NEGATION: '' }), true);
  assert.strictEqual(neg.isEnabled({ KHY_INTENT_NEGATION: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(neg.isEnabled({ KHY_INTENT_NEGATION: v }), false, v);
  }
});

test('前向邻接否定:`不要执行`/`别执行`/`不执行` → 动词被否定', () => {
  for (const text of ['不要执行这个', '别执行本地模式', '不执行', '先别执行', '不想执行']) {
    assert.deepStrictEqual(neg.selectNegatedVerbs(text, ['执行'], {}, LEX), ['执行'], text);
  }
});

test('后向情态否定:`执行不了`/`执行失败` 等陈述句 → 动词被否定', () => {
  for (const text of ['执行不了这个命令', '执行失败了', '运行报错', '执行不成']) {
    const verb = text.startsWith('运行') ? '运行' : '执行';
    assert.deepStrictEqual(neg.selectNegatedVerbs(text, [verb], {}, LEX), [verb], text);
  }
});

test('让步词不误伤:`不仅执行`/`不但执行`（非否定）→ 动词保持主动', () => {
  for (const text of ['不仅执行了X还做了Y', '不但执行还很快']) {
    assert.deepStrictEqual(neg.selectNegatedVerbs(text, ['执行'], {}, LEX), [], text);
  }
});

test('混合子句:`别执行A但执行B` 有非否定出现 → 动词保持主动', () => {
  assert.deepStrictEqual(neg.selectNegatedVerbs('别执行A但执行B', ['执行'], {}, LEX), []);
});

test('正常命令:`执行这个` 无否定 → 空集', () => {
  assert.deepStrictEqual(neg.selectNegatedVerbs('执行这个本地模式', ['执行'], {}, LEX), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('立刻执行本地模式', ['执行'], {}, LEX), []);
});

test('多动词:仅完全否定的动词进入结果集', () => {
  // 进入被否定,执行未出现(不在文本) → 仅 进入。
  assert.deepStrictEqual(
    neg.selectNegatedVerbs('别进入本地模式', ['进入', '执行'], {}, LEX),
    ['进入'],
  );
});

test('门控关:返回 [](字节回退,否定不剔除)', () => {
  assert.deepStrictEqual(
    neg.selectNegatedVerbs('不要执行这个', ['执行'], { KHY_INTENT_NEGATION: 'off' }, LEX),
    [],
  );
});

test('防呆:非串/空/非数组/空词表入参绝不抛', () => {
  assert.deepStrictEqual(neg.selectNegatedVerbs(null, ['执行'], {}, LEX), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('', ['执行'], {}, LEX), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('不要执行', null, {}, LEX), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('不要执行', [], {}, LEX), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('不要执行', ['执行'], {}, {}), []);
  assert.deepStrictEqual(neg.selectNegatedVerbs('不要执行', ['执行', 42, ''], {}, LEX), ['执行']);
});

test('_occurrenceNegated:前向/后向邻接判据直测', () => {
  assert.strictEqual(neg._occurrenceNegated('别执行', '执行', 1, LEX.markers, LEX.modals), true);
  assert.strictEqual(neg._occurrenceNegated('执行不了', '执行', 0, LEX.markers, LEX.modals), true);
  assert.strictEqual(neg._occurrenceNegated('执行这个', '执行', 0, LEX.markers, LEX.modals), false);
});
