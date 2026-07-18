'use strict';

const test = require('node:test');
const assert = require('node:assert');

const slots = require('../src/cli/sessionSlots');

// ── 门控梯 ───────────────────────────────────────────────────────────────
test('slotsEnabled: 默认开(undefined/null/空 env)', () => {
  assert.equal(slots.slotsEnabled(undefined), true);
  assert.equal(slots.slotsEnabled({}), true);
  assert.equal(slots.slotsEnabled({ KHY_SESSION_SLOTS: undefined }), true);
});

test('slotsEnabled: falsy 集大小写+trim → 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'NO']) {
    assert.equal(slots.slotsEnabled({ KHY_SESSION_SLOTS: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
});

test('slotsEnabled: 其它真值 → 开', () => {
  for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
    assert.equal(slots.slotsEnabled({ KHY_SESSION_SLOTS: v }), true, `expected on for ${JSON.stringify(v)}`);
  }
});

// ── applyInsightOnce 一次性语义 ──────────────────────────────────────────
test('applyInsightOnce: 非空 insight → 返回文本并在 nextMetadata 清空(一次性)', () => {
  const meta = { insight: '记得检查并发安全', memory: '外向摘要', other: 1 };
  const r = slots.applyInsightOnce(meta);
  assert.equal(r.insightText, '记得检查并发安全');
  assert.equal(r.changed, true);
  assert.equal(r.nextMetadata.insight, '');
  // 其它字段保留
  assert.equal(r.nextMetadata.memory, '外向摘要');
  assert.equal(r.nextMetadata.other, 1);
  // 绝不就地改入参
  assert.equal(meta.insight, '记得检查并发安全');
});

test('applyInsightOnce: 再次消费已清空的 metadata → 无注入、无变更', () => {
  const meta = { insight: 'once', memory: 'm' };
  const first = slots.applyInsightOnce(meta);
  const second = slots.applyInsightOnce(first.nextMetadata);
  assert.equal(second.insightText, '');
  assert.equal(second.changed, false);
  assert.equal(second.nextMetadata.insight, '');
});

test('applyInsightOnce: 空/空白 insight → no-op', () => {
  for (const v of [undefined, null, '', '   ', '\n\t']) {
    const r = slots.applyInsightOnce({ insight: v });
    assert.equal(r.insightText, '');
    assert.equal(r.changed, false);
  }
});

test('applyInsightOnce: 防呆非对象入参不抛', () => {
  for (const v of [undefined, null, 42, 'x', []]) {
    const r = slots.applyInsightOnce(v);
    assert.equal(r.insightText, '');
    assert.equal(r.changed, false);
    assert.deepEqual(r.nextMetadata, {});
  }
});

// ── mergeSystemPrompt 4 层 ──────────────────────────────────────────────
test('mergeSystemPrompt: 对象 4 层按 defaults→parent→profile→fork 顺序拼接', () => {
  const out = slots.mergeSystemPrompt({
    defaults: 'D', parent: 'P', profile: 'F', fork: 'K',
  });
  assert.equal(out, 'D\n\nP\n\nF\n\nK');
});

test('mergeSystemPrompt: 数组形式同序拼接', () => {
  assert.equal(slots.mergeSystemPrompt(['a', 'b', 'c']), 'a\n\nb\n\nc');
});

test('mergeSystemPrompt: 空层/空白层剔除', () => {
  assert.equal(slots.mergeSystemPrompt(['a', '', '  ', null, undefined, 'b']), 'a\n\nb');
  assert.equal(slots.mergeSystemPrompt({ defaults: '', parent: 'P', profile: '   ', fork: 'K' }), 'P\n\nK');
});

test('mergeSystemPrompt: 防呆非法入参 → 空串', () => {
  assert.equal(slots.mergeSystemPrompt(undefined), '');
  assert.equal(slots.mergeSystemPrompt(null), '');
  assert.equal(slots.mergeSystemPrompt(42), '');
});

test('mergeSystemPrompt: 超长截断到上限', () => {
  const big = 'x'.repeat(20000);
  const out = slots.mergeSystemPrompt([big]);
  assert.ok(out.length <= slots.SLOT_MAX.systemPrompt);
  assert.ok(out.endsWith('…'));
});

// ── readSlots ───────────────────────────────────────────────────────────
test('readSlots: 规整读三槽,缺失/非串 → 空串', () => {
  assert.deepEqual(slots.readSlots({ systemPrompt: 'S', insight: 'I', memory: 'M' }), {
    systemPrompt: 'S', insight: 'I', memory: 'M',
  });
  assert.deepEqual(slots.readSlots({ systemPrompt: 123, insight: null }), {
    systemPrompt: '', insight: '', memory: '',
  });
  assert.deepEqual(slots.readSlots(undefined), { systemPrompt: '', insight: '', memory: '' });
});

// ── writeSlot 校验 + memory 不进注入集 ───────────────────────────────────
test('writeSlot: 合法 slot → 返回新 metadata(绝不就地改入参)', () => {
  const meta = { systemPrompt: 'old', keep: 1 };
  const next = slots.writeSlot(meta, 'systemPrompt', 'new');
  assert.equal(next.systemPrompt, 'new');
  assert.equal(next.keep, 1);
  assert.equal(meta.systemPrompt, 'old'); // 入参不变
});

test('writeSlot: 非法 slot → null', () => {
  assert.equal(slots.writeSlot({}, 'history', 'x'), null);
  assert.equal(slots.writeSlot({}, '', 'x'), null);
  assert.equal(slots.writeSlot({}, 'foo', 'x'), null);
});

test('writeSlot: 各槽截断到上限', () => {
  const next = slots.writeSlot({}, 'memory', 'y'.repeat(10000));
  assert.ok(next.memory.length <= slots.SLOT_MAX.memory);
  assert.ok(next.memory.endsWith('…'));
});

test('memory 刻意不在注入集;systemPrompt/insight 在', () => {
  assert.equal(slots.isInjectableSlot('memory'), false);
  assert.equal(slots.isInjectableSlot('systemPrompt'), true);
  assert.equal(slots.isInjectableSlot('insight'), true);
  assert.equal(slots.isInjectableSlot('nope'), false);
  assert.deepEqual(slots.INJECTABLE_SLOTS, ['systemPrompt', 'insight']);
  assert.ok(slots.INJECTABLE_SLOTS.indexOf('memory') === -1);
});
