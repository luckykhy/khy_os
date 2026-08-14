'use strict';

/**
 * referenceDisambiguation.test.js — 「会话内代词/身份指代消歧」纯叶子单测(node:test)。
 *
 * 覆盖:门控(默认开·options/env 关)、让位规则(CLEAR_MODES 活跃 / 具体指令 / 文本过长 →
 * 不介入)、代词分支(唯一候选→展开·0 或 ≥2 候选→歧义让用户选·resolveFollowUp 命中→展开)、
 * 身份分支(信息充足→作答·不足→追问)、连续澄清上限→降级推断、关闭时零注入(directive:null)、
 * 绝不抛。纯叶子:确定性、无 I/O,昂贵数据由入参注入。
 */

const test = require('node:test');
const assert = require('node:assert');

const rd = require('../../src/services/referenceDisambiguation');

test('导出契约:routeReferenceDisambiguation + 判据常量', () => {
  assert.strictEqual(typeof rd.routeReferenceDisambiguation, 'function');
  assert.ok(Array.isArray(rd.CLEAR_MODES));
  assert.strictEqual(typeof rd.MAX_REFERENCE_LEN, 'number');
  assert.ok(rd.PRONOUN_RE instanceof RegExp);
  assert.ok(rd.IDENTITY_RE instanceof RegExp);
});

test('门控:默认开;options.referenceDisambiguation=off → enabled=false·directive=null', () => {
  const on = rd.routeReferenceDisambiguation({ text: '它是什么' });
  assert.strictEqual(on.enabled, true);
  for (const off of ['0', 'false', 'off', 'no']) {
    const r = rd.routeReferenceDisambiguation({ text: '它是什么', options: { referenceDisambiguation: off } });
    assert.strictEqual(r.enabled, false, off);
    assert.strictEqual(r.directive, null, off);
    assert.strictEqual(r.reason, 'disabled', off);
  }
});

test('代词·唯一候选 → need=false·resolved 命中·给展开指令', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '它是什么',
    contextSummary: { entities: [{ type: 'crypto', value: '比特币' }] },
  });
  assert.strictEqual(r.type, 'pronoun');
  assert.strictEqual(r.need, false);
  assert.strictEqual(r.resolved, '比特币');
  assert.match(r.directive, /指代已可确定/);
  assert.match(r.directive, /比特币/);
});

test('代词·≥2 候选(歧义) → need=true·提示 AskUserQuestion 列候选', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '它是什么',
    contextSummary: { entities: [{ value: '比特币' }, { value: '以太坊' }] },
  });
  assert.strictEqual(r.type, 'pronoun');
  assert.strictEqual(r.need, true);
  assert.strictEqual(r.resolved, null);
  assert.match(r.directive, /AskUserQuestion/);
  assert.match(r.directive, /比特币|以太坊/);
});

test('代词·0 候选 → need=true·无可锁定对象', () => {
  const r = rd.routeReferenceDisambiguation({ text: '它是什么', contextSummary: { entities: [] } });
  assert.strictEqual(r.need, true);
  assert.strictEqual(r.reason, 'no-candidate');
  assert.match(r.directive, /AskUserQuestion/);
});

test('代词·resolveFollowUp 已展开(resolved 注入) → need=false·直接推进', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '它呢',
    contextSummary: { entities: [{ value: '比特币' }, { value: '以太坊' }], resolved: '比特币价格' },
  });
  assert.strictEqual(r.need, false);
  assert.strictEqual(r.resolved, '比特币价格');
  assert.strictEqual(r.reason, 'resolved-followup');
});

test('身份·信息充足 → need=false·据已知作答', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '我是谁',
    identitySummary: { hasIdentity: true, osUser: 'alice', skillLevel: 'advanced' },
  });
  assert.strictEqual(r.type, 'identity');
  assert.strictEqual(r.need, false);
  assert.match(r.directive, /身份询问/);
  assert.match(r.directive, /alice/);
});

test('身份·信息不足 → need=true·先问清哪个方面', () => {
  const r = rd.routeReferenceDisambiguation({ text: '我是谁', identitySummary: null });
  assert.strictEqual(r.type, 'identity');
  assert.strictEqual(r.need, true);
  assert.match(r.directive, /AskUserQuestion/);
  assert.strictEqual(r.reason, 'identity-insufficient');
});

test('让位·CLEAR_MODES 活跃 → 不介入·directive=null', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '它是什么',
    modes: ['goal'],
    contextSummary: { entities: [{ value: '比特币' }] },
  });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'mode-active');
});

test('让位·具体指令(复用 assessPromptClarity) → 不介入·directive=null', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '翻译它',
    contextSummary: { entities: [{ value: '比特币' }] },
  });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'concrete-instruction');
});

test('让位·文本过长(>MAX_REFERENCE_LEN) → 不介入·directive=null', () => {
  const longText = '它' + '好'.repeat(45);
  const r = rd.routeReferenceDisambiguation({
    text: longText,
    contextSummary: { entities: [{ value: '比特币' }] },
  });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'too-long');
});

test('连续澄清上限(≥2) → need=false·降级为「最可能推断+说明假设」', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '它是什么',
    contextSummary: { entities: [{ value: '比特币' }, { value: '以太坊' }] },
    consecutiveClarifyCount: 2,
  });
  assert.strictEqual(r.need, false);
  assert.strictEqual(r.reason, 'clarify-cap');
  assert.match(r.directive, /假设/);
});

test('无指代/无身份询问 → directive=null·reason=no-reference', () => {
  const r = rd.routeReferenceDisambiguation({ text: '今天天气' });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'no-reference');
});

test('绝不抛:畸形输入 fail-soft', () => {
  assert.doesNotThrow(() => rd.routeReferenceDisambiguation());
  assert.doesNotThrow(() => rd.routeReferenceDisambiguation({}));
  assert.doesNotThrow(() => rd.routeReferenceDisambiguation({ text: null, contextSummary: null, identitySummary: null }));
  const empty = rd.routeReferenceDisambiguation({ text: '   ' });
  assert.strictEqual(empty.reason, 'empty');
  assert.strictEqual(empty.directive, null);
});

// ── device 分支(Phase 2:「卡顿是电脑还是项目」) ──────────────────────────

test('导出契约:device 判据常量 + mightBeDeviceQuery', () => {
  assert.ok(rd.DEVICE_RE instanceof RegExp);
  assert.ok(rd.DEVICE_EXPLICIT_SUBJECT_RE instanceof RegExp);
  assert.strictEqual(typeof rd.mightBeDeviceQuery, 'function');
});

test('device·命中卡顿·无项目上下文 → need=true·让用户选 A/B/C', () => {
  const r = rd.routeReferenceDisambiguation({ text: '怎么这么卡' });
  assert.strictEqual(r.type, 'device');
  assert.strictEqual(r.need, true);
  assert.strictEqual(r.reason, 'device-ambiguous');
  assert.match(r.directive, /AskUserQuestion/);
  assert.match(r.directive, /电脑\/硬件/);
  assert.match(r.directive, /当前项目/);
  assert.match(r.directive, /网络/);
});

test('device·有项目/代码上下文 → reason 标记两难·文案提及项目', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '好卡啊',
    contextSummary: { entities: [{ type: 'word', value: 'react' }], lastCategory: '', lastTopic: 'react 构建' },
  });
  assert.strictEqual(r.type, 'device');
  assert.strictEqual(r.need, true);
  assert.strictEqual(r.reason, 'device-with-project-context');
  assert.match(r.directive, /项目/);
});

test('device·注入 systemLoad 快照 → 写入 directive 作佐证', () => {
  const r = rd.routeReferenceDisambiguation({
    text: '电脑好卡',
    systemLoad: { cpuPercent: 88, memPercent: 91, freeMemMB: 512 },
  });
  assert.strictEqual(r.type, 'device');
  assert.match(r.directive, /CPU/);
  assert.match(r.directive, /88%/);
  assert.match(r.directive, /91%/);
});

test('device·已有明确对象(「这段代码有点慢」)→ 让位·不注入', () => {
  const r = rd.routeReferenceDisambiguation({ text: '这段代码有点慢' });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'device-explicit-subject');
});

test('device·flag 关闭 → enabled=false·零注入', () => {
  const r = rd.routeReferenceDisambiguation({ text: '怎么这么卡', options: { referenceDisambiguation: 'off' } });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'disabled');
});

test('device·连续澄清上限(≥2) → need=false·降级推断', () => {
  const r = rd.routeReferenceDisambiguation({ text: '怎么这么卡', consecutiveClarifyCount: 2 });
  assert.strictEqual(r.type, 'device');
  assert.strictEqual(r.need, false);
  assert.strictEqual(r.reason, 'clarify-cap');
  assert.match(r.directive, /假设/);
});

test('device·CLEAR_MODES 活跃 → 让位不介入', () => {
  const r = rd.routeReferenceDisambiguation({ text: '怎么这么卡', modes: ['coding'] });
  assert.strictEqual(r.directive, null);
  assert.strictEqual(r.reason, 'mode-active');
});

test('mightBeDeviceQuery:命中性能词且无明确主体 → true;否则 false', () => {
  assert.strictEqual(rd.mightBeDeviceQuery('怎么这么卡'), true);
  assert.strictEqual(rd.mightBeDeviceQuery('电脑好卡啊'), true);
  assert.strictEqual(rd.mightBeDeviceQuery('这段代码有点慢'), false);
  assert.strictEqual(rd.mightBeDeviceQuery('今天天气'), false);
  assert.strictEqual(rd.mightBeDeviceQuery(''), false);
});
