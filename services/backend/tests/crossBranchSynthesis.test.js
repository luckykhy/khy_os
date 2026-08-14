'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cbs = require('../src/cli/crossBranchSynthesis');

// ── 门控梯 ───────────────────────────────────────────────────────────────
test('synthesisEnabled: 默认开', () => {
  assert.equal(cbs.synthesisEnabled(undefined), true);
  assert.equal(cbs.synthesisEnabled({}), true);
});

test('synthesisEnabled: falsy 集大小写+trim → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(cbs.synthesisEnabled({ KHY_CROSS_BRANCH_SYNTHESIS: v }), false);
  }
});

test('synthesisEnabled: 真值 → 开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'x']) {
    assert.equal(cbs.synthesisEnabled({ KHY_CROSS_BRANCH_SYNTHESIS: v }), true);
  }
});

// ── planSynthesis ───────────────────────────────────────────────────────
const DIGESTS = [
  { id: 'a', label: '分支A', status: 'active', memory: 'A 在调试并发', insight: '' },
  { id: 'b', label: '分支B', status: 'idle', memory: 'B 在写文档', insight: 'B 待读' },
];

test('planSynthesis: targetIds 含全部合法节点,prompt 含各分支 memory 与格式标记', () => {
  const { prompt, targetIds } = cbs.planSynthesis(DIGESTS);
  assert.deepEqual(targetIds, ['a', 'b']);
  assert.ok(prompt.includes('A 在调试并发'));
  assert.ok(prompt.includes('B 在写文档'));
  assert.ok(prompt.includes(cbs.SYNTH_MARKER));
  assert.ok(prompt.includes('[[NODE'));
  assert.ok(prompt.includes('[[NODE a]]'));
});

test('planSynthesis: 跳过空 id / 非对象,空列表 → 空 targetIds + 提示有占位', () => {
  const { prompt, targetIds } = cbs.planSynthesis([{ id: '' }, null, 42, { id: 'c', label: 'C' }]);
  assert.deepEqual(targetIds, ['c']);
  const empty = cbs.planSynthesis([]);
  assert.deepEqual(empty.targetIds, []);
  assert.ok(empty.prompt.includes('暂无分支'));
});

test('planSynthesis: 防呆非数组 → 空', () => {
  assert.deepEqual(cbs.planSynthesis(undefined).targetIds, []);
  assert.deepEqual(cbs.planSynthesis(null).targetIds, []);
});

// ── applySynthesis 正常解析 ─────────────────────────────────────────────
test('applySynthesis: 正常分节 → rootSynthesis + 每节点 insight', () => {
  const raw = [
    '[[SYNTHESIS]]',
    '两支互补:A 的竞态修复可供 B 文档引用。',
    '[[NODE a]]',
    'B 已写好文档,完成后同步术语。',
    '[[NODE b]]',
    'A 定位到竞态,记得在文档补并发注意事项。',
  ].join('\n');
  const r = cbs.applySynthesis(raw, DIGESTS);
  assert.ok(r.rootSynthesis.includes('两支互补'));
  assert.equal(r.perNodeInsight.a, 'B 已写好文档,完成后同步术语。');
  assert.equal(r.perNodeInsight.b, 'A 定位到竞态,记得在文档补并发注意事项。');
});

test('applySynthesis: 未知节点 id 段丢弃(绝不臆造节点)', () => {
  const raw = [
    '[[SYNTHESIS]]', '根综合',
    '[[NODE a]]', 'for a',
    '[[NODE zzz]]', 'for unknown',
  ].join('\n');
  const r = cbs.applySynthesis(raw, DIGESTS);
  assert.equal(r.perNodeInsight.a, 'for a');
  assert.equal(r.perNodeInsight.zzz, undefined);
  assert.equal('zzz' in r.perNodeInsight, false);
});

test('applySynthesis: 同 id 多段 → 后段覆盖', () => {
  const raw = ['[[NODE a]]', 'first', '[[NODE a]]', 'second'].join('\n');
  const r = cbs.applySynthesis(raw, DIGESTS);
  assert.equal(r.perNodeInsight.a, 'second');
});

test('applySynthesis: 仅 SYNTHESIS 段 → 只有根综合', () => {
  const r = cbs.applySynthesis('[[SYNTHESIS]]\n只有根综合', DIGESTS);
  assert.equal(r.rootSynthesis, '只有根综合');
  assert.deepEqual(Object.keys(r.perNodeInsight), []);
});

// ── applySynthesis fail-soft ─────────────────────────────────────────────
test('applySynthesis: 无任何标记 → 整段进根综合(fail-soft 不抛)', () => {
  const r = cbs.applySynthesis('模型没按格式,只回了一段自由文本。', DIGESTS);
  assert.equal(r.rootSynthesis, '模型没按格式,只回了一段自由文本。');
  assert.deepEqual(Object.keys(r.perNodeInsight), []);
});

test('applySynthesis: 空/非串入参 → 空结果不抛', () => {
  for (const v of ['', undefined, null, 42]) {
    const r = cbs.applySynthesis(v, DIGESTS);
    assert.equal(r.rootSynthesis, '');
    assert.deepEqual(Object.keys(r.perNodeInsight), []);
  }
});

test('applySynthesis: digests 为空 → 所有 NODE 段都未知被丢,但根综合保留', () => {
  const raw = ['[[SYNTHESIS]]', '根', '[[NODE a]]', 'x'].join('\n');
  const r = cbs.applySynthesis(raw, []);
  assert.equal(r.rootSynthesis, '根');
  assert.deepEqual(Object.keys(r.perNodeInsight), []);
});
