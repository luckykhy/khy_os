'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/autofixPr/autofixPrPlan');

// ── 语法解析 ──────────────────────────────────────────────────────────────
test('parseAutofixArgs: 空参 = run, target null', () => {
  assert.deepStrictEqual(leaf.parseAutofixArgs([]), { action: 'run', target: null, valid: true, parseError: null });
});
test('parseAutofixArgs: status/stop/help 动作词', () => {
  assert.strictEqual(leaf.parseAutofixArgs(['status']).action, 'status');
  assert.strictEqual(leaf.parseAutofixArgs(['stop']).action, 'stop');
  assert.strictEqual(leaf.parseAutofixArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseAutofixArgs(['修复']).action, 'run');
});
test('parseAutofixArgs: 第一个非动作 token = target,动作默认 run', () => {
  const r = leaf.parseAutofixArgs(['123']);
  assert.strictEqual(r.action, 'run');
  assert.strictEqual(r.target, '123');
});
test('parseAutofixArgs: 动作词后跟 target', () => {
  const r = leaf.parseAutofixArgs(['status', 'feature/x']);
  assert.strictEqual(r.action, 'status');
  assert.strictEqual(r.target, 'feature/x');
});
test('parseAutofixArgs: # 前缀剥离', () => {
  assert.strictEqual(leaf.parseAutofixArgs(['#42']).target, '42');
});
test('parseAutofixArgs: 非数组防呆', () => {
  assert.strictEqual(leaf.parseAutofixArgs(null).action, 'run');
});

// ── decideFixPlan ─────────────────────────────────────────────────────────
test('decideFixPlan: CI fail + 模型可用 → proceed=true kind=fix', () => {
  const d = leaf.decideFixPlan({ ciResult: { classification: 'fail' }, modelAvailable: true });
  assert.strictEqual(d.proceed, true);
  assert.strictEqual(d.kind, 'fix');
});
test('decideFixPlan: CI fail + 无模型 → proceed=false kind=no_model(诚实降级)', () => {
  const d = leaf.decideFixPlan({ ciResult: { classification: 'fail' }, modelAvailable: false });
  assert.strictEqual(d.proceed, false);
  assert.strictEqual(d.kind, 'no_model');
  assert.match(d.reason, /无可用模型|Tier A/);
});
test('decideFixPlan: CI pass → 不修', () => {
  const d = leaf.decideFixPlan({ ciResult: { classification: 'pass' }, modelAvailable: true });
  assert.strictEqual(d.proceed, false);
  assert.strictEqual(d.kind, 'already_pass');
});
test('decideFixPlan: CI pending → 不修', () => {
  const d = leaf.decideFixPlan({ ciResult: { classification: 'pending' }, modelAvailable: true });
  assert.strictEqual(d.kind, 'pending');
  assert.strictEqual(d.proceed, false);
});
test('decideFixPlan: CI error/无平台 → kind=no_ci', () => {
  const d = leaf.decideFixPlan({ ciResult: { error: 'no gh' }, modelAvailable: true });
  assert.strictEqual(d.kind, 'no_ci');
  assert.strictEqual(d.proceed, false);
});
test('decideFixPlan: 未知分类 → kind=unknown 保守不修', () => {
  const d = leaf.decideFixPlan({ ciResult: { classification: 'weird' }, modelAvailable: true });
  assert.strictEqual(d.kind, 'unknown');
  assert.strictEqual(d.proceed, false);
});
test('decideFixPlan: 防呆 —— 非对象不抛', () => {
  assert.doesNotThrow(() => leaf.decideFixPlan(null));
  assert.strictEqual(leaf.decideFixPlan(null).kind, 'no_ci');
});

// ── 文本渲染 ──────────────────────────────────────────────────────────────
test('buildCiStatusText: 含平台/结论;error 诚实留白', () => {
  const ok = leaf.buildCiStatusText({ platform: 'github', classification: 'fail', conclusion: 'failure', url: 'http://x' });
  assert.match(ok, /github/);
  assert.match(ok, /失败/);
  const bad = leaf.buildCiStatusText({ error: 'no gh' });
  assert.match(bad, /不可用/);
});
test('buildPlanText: proceed 与否措辞不同', () => {
  assert.match(leaf.buildPlanText({ proceed: true, reason: 'r' }), /开始本地审计修复/);
  assert.match(leaf.buildPlanText({ proceed: false, reason: 'r' }), /不执行修复/);
});
test('buildOutcomeText: clean/fixed/exhausted/error 四态', () => {
  assert.match(leaf.buildOutcomeText({ outcome: 'clean' }), /未发现需修复/);
  assert.match(leaf.buildOutcomeText({ outcome: 'fixed', rounds: [{ fixed: true, fixReport: { fixed: 3 } }] }), /已自动修复/);
  assert.match(leaf.buildOutcomeText({ outcome: 'exhausted', totalActionableRemaining: 2 }), /仍有 2 个/);
  assert.match(leaf.buildOutcomeText({ outcome: 'error', error: 'boom' }), /出错/);
});
test('buildOutcomeText: 列出改动文件', () => {
  const t = leaf.buildOutcomeText({ outcome: 'fixed', rounds: [], filesFixed: ['a.js', 'b.js'] });
  assert.match(t, /a\.js/);
});
test('buildStopText: 诚实说明无后台会话', () => {
  assert.match(leaf.buildStopText(), /没有后台云会话|同步前台/);
});
test('buildHelpText/buildUnknownText 含 /autofix-pr', () => {
  assert.match(leaf.buildHelpText(), /\/autofix-pr/);
  assert.match(leaf.buildUnknownText(), /未知子命令/);
});

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
});
test('isEnabled: 关值', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_AUTOFIX_PR: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值开', () => {
  assert.strictEqual(leaf.isEnabled({ KHY_AUTOFIX_PR: 'on' }), true);
});
