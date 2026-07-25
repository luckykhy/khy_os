'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/subscribePr/subscribePrPlan');

// ── 语法解析 ──────────────────────────────────────────────────────────────
test('parseSubscribeArgs: 空参 = list', () => {
  assert.deepStrictEqual(leaf.parseSubscribeArgs([]), { action: 'list', ref: null, valid: true, parseError: null });
});
test('parseSubscribeArgs: 动作词', () => {
  assert.strictEqual(leaf.parseSubscribeArgs(['list']).action, 'list');
  assert.strictEqual(leaf.parseSubscribeArgs(['check']).action, 'check');
  assert.strictEqual(leaf.parseSubscribeArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseSubscribeArgs(['列出']).action, 'list');
  assert.strictEqual(leaf.parseSubscribeArgs(['检查']).action, 'check');
});
test('parseSubscribeArgs: 首 token 非动作 → subscribe ref', () => {
  const r = leaf.parseSubscribeArgs(['owner/repo#42']);
  assert.strictEqual(r.action, 'subscribe');
  assert.strictEqual(r.ref, 'owner/repo#42');
});
test('parseSubscribeArgs: unsubscribe 需 ref', () => {
  const ok = leaf.parseSubscribeArgs(['unsubscribe', '#42']);
  assert.strictEqual(ok.action, 'unsubscribe');
  assert.strictEqual(ok.ref, '#42');
  assert.strictEqual(ok.valid, true);
  const bad = leaf.parseSubscribeArgs(['unsubscribe']);
  assert.strictEqual(bad.valid, false);
  assert.strictEqual(bad.parseError, 'missing_ref');
});
test('parseSubscribeArgs: check 可带 ref', () => {
  assert.strictEqual(leaf.parseSubscribeArgs(['check', '#1']).ref, '#1');
});
test('parseSubscribeArgs: 非数组防呆', () => {
  assert.strictEqual(leaf.parseSubscribeArgs(null).action, 'list');
});

// ── parsePrRef ────────────────────────────────────────────────────────────
test('parsePrRef: owner/repo#N', () => {
  const p = leaf.parsePrRef('octo/cat#7');
  assert.strictEqual(p.owner, 'octo');
  assert.strictEqual(p.repo, 'cat');
  assert.strictEqual(p.number, 7);
  assert.strictEqual(p.key, 'octo/cat#7');
});
test('parsePrRef: #N 与 N', () => {
  assert.strictEqual(leaf.parsePrRef('#42').number, 42);
  assert.strictEqual(leaf.parsePrRef('#42').key, '#42');
  assert.strictEqual(leaf.parsePrRef('42').number, 42);
});
test('parsePrRef: 裸分支名', () => {
  const p = leaf.parsePrRef('feature/x');
  assert.strictEqual(p.branch, 'feature/x');
  assert.strictEqual(p.number, null);
  assert.strictEqual(p.key, 'feature/x');
});
test('parsePrRef: 空防呆', () => {
  assert.strictEqual(leaf.parsePrRef('').key, '');
  assert.strictEqual(leaf.parsePrRef(null).key, '');
});

// ── buildSubscriptionDescriptor ───────────────────────────────────────────
test('buildSubscriptionDescriptor: 含 key/lastClassification=null', () => {
  const d = leaf.buildSubscriptionDescriptor({ ref: leaf.parsePrRef('octo/cat#7'), subscribedAt: 't' });
  assert.strictEqual(d.key, 'octo/cat#7');
  assert.strictEqual(d.lastClassification, null);
  assert.strictEqual(d.subscribedAt, 't');
});
test('buildSubscriptionDescriptor: 接受字符串 ref', () => {
  const d = leaf.buildSubscriptionDescriptor({ ref: '#9' });
  assert.strictEqual(d.key, '#9');
  assert.strictEqual(d.number, 9);
});

// ── decideNotify(去抖核心) ───────────────────────────────────────────────
test('decideNotify: 终态 pass 且变化 → 通知', () => {
  const d = leaf.decideNotify({ ciResult: { classification: 'pass' }, lastClassification: 'pending' });
  assert.strictEqual(d.terminal, true);
  assert.strictEqual(d.changed, true);
  assert.strictEqual(d.shouldNotify, true);
});
test('decideNotify: 终态 fail 且变化 → 通知', () => {
  const d = leaf.decideNotify({ ciResult: { classification: 'fail' }, lastClassification: null });
  assert.strictEqual(d.shouldNotify, true);
});
test('decideNotify: 终态但无变化 → 不重复通知', () => {
  const d = leaf.decideNotify({ ciResult: { classification: 'pass' }, lastClassification: 'pass' });
  assert.strictEqual(d.terminal, true);
  assert.strictEqual(d.changed, false);
  assert.strictEqual(d.shouldNotify, false);
});
test('decideNotify: 非终态(pending) → 不通知', () => {
  const d = leaf.decideNotify({ ciResult: { classification: 'pending' }, lastClassification: null });
  assert.strictEqual(d.terminal, false);
  assert.strictEqual(d.shouldNotify, false);
});
test('decideNotify: error/无分类 → unknown 不通知', () => {
  const d = leaf.decideNotify({ ciResult: { error: 'no gh' }, lastClassification: null });
  assert.strictEqual(d.classification, 'unknown');
  assert.strictEqual(d.shouldNotify, false);
});
test('decideNotify: 防呆 —— 非对象不抛', () => {
  assert.doesNotThrow(() => leaf.decideNotify(null));
  assert.strictEqual(leaf.decideNotify(null).shouldNotify, false);
});

// ── buildNotification ─────────────────────────────────────────────────────
test('buildNotification: pass/fail 措辞', () => {
  const pass = leaf.buildNotification({ key: '#7' }, { classification: 'pass' });
  assert.match(pass.title, /通过/);
  const fail = leaf.buildNotification({ key: '#7' }, { classification: 'fail' });
  assert.match(fail.title, /失败/);
});

// ── 文本渲染 ──────────────────────────────────────────────────────────────
test('buildListText: 空 / 有订阅', () => {
  assert.match(leaf.buildListText([]), /暂无订阅/);
  const t = leaf.buildListText([{ key: '#7', lastClassification: 'fail' }]);
  assert.match(t, /#7/);
  assert.match(t, /上次 CI: fail/);
});
test('buildSubscribeText: 含无后台轮询诚实说明', () => {
  assert.match(leaf.buildSubscribeText({ key: '#7' }), /无常驻后台轮询/);
});
test('buildUnsubscribeText: removed 与否', () => {
  assert.match(leaf.buildUnsubscribeText('#7', true), /已退订/);
  assert.match(leaf.buildUnsubscribeText('#7', false), /未找到订阅/);
});
test('buildCheckText: 通知/去抖/未配推送', () => {
  const t = leaf.buildCheckText([
    { key: '#1', decision: { classification: 'pass', shouldNotify: true, terminal: true, changed: true }, notified: true },
    { key: '#2', decision: { classification: 'pass', shouldNotify: false, terminal: true, changed: false }, notified: false },
  ], { pushConfigured: true });
  assert.match(t, /#1: pass → 已推送通知/);
  assert.match(t, /#2: pass → 终态但无变化/);
  const noPush = leaf.buildCheckText([{ key: '#1', decision: { classification: 'fail' } }], { pushConfigured: false });
  assert.match(noPush, /尚未配置推送/);
});
test('buildCheckText: 空订阅', () => {
  assert.match(leaf.buildCheckText([]), /暂无订阅可检查/);
});
test('buildHelpText/buildUnknownText 含 /subscribe-pr', () => {
  assert.match(leaf.buildHelpText(), /\/subscribe-pr/);
  assert.match(leaf.buildUnknownText(), /用法有误/);
});

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
});
test('isEnabled: 关值', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_SUBSCRIBE_PR: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值开', () => {
  assert.strictEqual(leaf.isEnabled({ KHY_SUBSCRIBE_PR: 'on' }), true);
});
