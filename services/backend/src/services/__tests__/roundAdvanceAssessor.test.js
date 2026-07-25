'use strict';

/**
 * roundAdvanceAssessor.test.js — 每轮任务推进判决纯叶子契约(node:test)。
 *
 * 覆盖:门控(默认开 / 显式 falsy 关 / 注册表委托)、VERDICTS 冻结、
 * assessRoundAdvance(全去重→停滞 / 全失败→空转 / 状态变更→推进 high / 新信息→推进 medium /
 * 混合去重+新成功→推进 / 无工具轮 null / 门关 null / 坏输入不抛)。零 IO、确定性——显式传 env。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ra = require('../roundAdvanceAssessor');

const ON = {}; // 默认开

test('isRoundAdvanceEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(ra.isRoundAdvanceEnabled({}), true);
  assert.equal(ra.isRoundAdvanceEnabled({ KHY_ROUND_ADVANCE_ASSESS: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(ra.isRoundAdvanceEnabled({ KHY_ROUND_ADVANCE_ASSESS: v }), false, v);
  }
});

test('isRoundAdvanceEnabled:注册表关时回退私有判定(逐字节等价)', () => {
  assert.equal(ra.isRoundAdvanceEnabled({ KHY_FLAG_REGISTRY: '0' }), true);
  assert.equal(ra.isRoundAdvanceEnabled({ KHY_FLAG_REGISTRY: '0', KHY_ROUND_ADVANCE_ASSESS: 'off' }), false);
});

test('VERDICTS:冻结(纯叶子不可变)且含三类判决', () => {
  assert.ok(Object.isFrozen(ra.VERDICTS));
  for (const k of ['advanced', 'stalled', 'unproductive']) {
    assert.ok(ra.VERDICTS[k] && Object.isFrozen(ra.VERDICTS[k]), k);
    assert.ok(typeof ra.VERDICTS[k].label === 'string');
  }
  assert.equal(ra.VERDICTS.advanced.necessary, true);
  assert.equal(ra.VERDICTS.stalled.necessary, false);
});

test('assessRoundAdvance:状态变更(写文件)→ 推进 · 价值 high · 必要', () => {
  const v = ra.assessRoundAdvance({
    total: 2, succeeded: 2, failed: 0, deduped: 0,
    breakdown: { reads: 0, searches: 0, writes: 2, commands: 0, agents: 0 },
    modifiedFiles: ['a.js', 'b.js'],
  }, ON);
  assert.equal(v.verdict, 'advanced');
  assert.equal(v.advanced, true);
  assert.equal(v.value, 'high');
  assert.equal(v.necessary, true);
  assert.equal(v.label, '推进');
  assert.match(v.reason, /推进/);
});

test('assessRoundAdvance:执行命令 / 委派子任务 也算状态变更 → 推进 high', () => {
  const cmd = ra.assessRoundAdvance({
    total: 1, succeeded: 1, failed: 0, deduped: 0,
    breakdown: { commands: 1 }, modifiedFiles: [],
  }, ON);
  assert.equal(cmd.value, 'high');
  const agent = ra.assessRoundAdvance({
    total: 1, succeeded: 1, failed: 0, deduped: 0,
    breakdown: { agents: 1 }, modifiedFiles: [],
  }, ON);
  assert.equal(agent.value, 'high');
});

test('assessRoundAdvance:仅读取/搜索(新信息)→ 推进 · 价值 medium', () => {
  const v = ra.assessRoundAdvance({
    total: 3, succeeded: 3, failed: 0, deduped: 0,
    breakdown: { reads: 2, searches: 1 }, modifiedFiles: [],
  }, ON);
  assert.equal(v.verdict, 'advanced');
  assert.equal(v.value, 'medium');
  assert.equal(v.necessary, true);
});

test('assessRoundAdvance:全部命中去重 → 停滞 · 价值 low · 不必要', () => {
  const v = ra.assessRoundAdvance({
    total: 3, succeeded: 3, failed: 0, deduped: 3,
    breakdown: { reads: 3 }, modifiedFiles: [],
  }, ON);
  assert.equal(v.verdict, 'stalled');
  assert.equal(v.advanced, false);
  assert.equal(v.value, 'low');
  assert.equal(v.necessary, false);
  assert.equal(v.label, '停滞');
});

test('assessRoundAdvance:无新成功且有失败 → 空转 · 价值 low', () => {
  const v = ra.assessRoundAdvance({
    total: 2, succeeded: 0, failed: 2, deduped: 0,
    breakdown: { commands: 2 }, modifiedFiles: [],
  }, ON);
  assert.equal(v.verdict, 'unproductive');
  assert.equal(v.advanced, false);
  assert.equal(v.value, 'low');
  assert.equal(v.label, '空转');
});

test('assessRoundAdvance:去重+新成功混合 → 只按新成功判为推进', () => {
  // 3 次调用:2 去重(重放)+ 1 新写入成功 → newSuccess=1 → 推进 high
  const v = ra.assessRoundAdvance({
    total: 3, succeeded: 3, failed: 0, deduped: 2,
    breakdown: { reads: 2, writes: 1 }, modifiedFiles: ['x.js'],
  }, ON);
  assert.equal(v.verdict, 'advanced');
  assert.equal(v.value, 'high');
});

test('assessRoundAdvance:全去重优先于新成功判定(deduped===total 即停滞)', () => {
  const v = ra.assessRoundAdvance({
    total: 2, succeeded: 2, failed: 0, deduped: 2,
    breakdown: { writes: 2 }, modifiedFiles: ['x.js'],
  }, ON);
  assert.equal(v.verdict, 'stalled');
});

test('assessRoundAdvance:门关 → 返 null(接线处逐字节回退,不附 advance 字段)', () => {
  assert.equal(ra.assessRoundAdvance({ total: 1, succeeded: 1, breakdown: { writes: 1 } }, { KHY_ROUND_ADVANCE_ASSESS: 'off' }), null);
  assert.equal(ra.assessRoundAdvance({ total: 1, succeeded: 1 }, { KHY_FLAG_REGISTRY: '0', KHY_ROUND_ADVANCE_ASSESS: '0' }), null);
});

test('assessRoundAdvance:无工具执行的轮次(total<=0)→ 返 null(不在本叶子评估范围)', () => {
  assert.equal(ra.assessRoundAdvance({ total: 0 }, ON), null);
  assert.equal(ra.assessRoundAdvance({}, ON), null);
});

test('assessRoundAdvance:坏输入 → 返 null 不抛', () => {
  assert.doesNotThrow(() => ra.assessRoundAdvance(undefined, ON));
  assert.doesNotThrow(() => ra.assessRoundAdvance(null, ON));
  assert.doesNotThrow(() => ra.assessRoundAdvance(42, ON));
  assert.equal(ra.assessRoundAdvance(undefined, ON), null);
  // breakdown 缺失 / 非对象也不抛
  assert.doesNotThrow(() => ra.assessRoundAdvance({ total: 1, succeeded: 1, breakdown: 'nope' }, ON));
});
