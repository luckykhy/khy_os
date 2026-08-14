'use strict';

/**
 * proactiveTogglePlan.test.js — 纯叶子 /proactive 逻辑单一真源测试(零 IO·确定性·绝不抛)。
 * 覆盖:parseProactiveArgs 全语法 + 空参=toggle + 未知;resolveToggle 期望态推导 + no-op;
 * build* 渲染器(注入快照·缺面诚实留白·绝不抛);isEnabled 门控梯。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/assistant/proactiveTogglePlan');

test('parseProactiveArgs: 空参 → toggle', () => {
  const p = leaf.parseProactiveArgs([]);
  assert.strictEqual(p.action, 'toggle');
  assert.strictEqual(p.valid, true);
  assert.strictEqual(p.parseError, null);
});

test('parseProactiveArgs: undefined/非数组不抛 → toggle', () => {
  assert.strictEqual(leaf.parseProactiveArgs(undefined).action, 'toggle');
  assert.strictEqual(leaf.parseProactiveArgs(null).action, 'toggle');
  assert.strictEqual(leaf.parseProactiveArgs('nope').action, 'toggle');
});

test('parseProactiveArgs: on/enable/start/开 → on', () => {
  for (const w of ['on', 'enable', 'start', 'activate', '开', '开启']) {
    assert.strictEqual(leaf.parseProactiveArgs([w]).action, 'on', `word=${w}`);
  }
});

test('parseProactiveArgs: off/disable/stop/关 → off', () => {
  for (const w of ['off', 'disable', 'stop', 'deactivate', '关', '关闭']) {
    assert.strictEqual(leaf.parseProactiveArgs([w]).action, 'off', `word=${w}`);
  }
});

test('parseProactiveArgs: toggle/切换 → toggle', () => {
  assert.strictEqual(leaf.parseProactiveArgs(['toggle']).action, 'toggle');
  assert.strictEqual(leaf.parseProactiveArgs(['切换']).action, 'toggle');
});

test('parseProactiveArgs: status/状态 → status', () => {
  assert.strictEqual(leaf.parseProactiveArgs(['status']).action, 'status');
  assert.strictEqual(leaf.parseProactiveArgs(['状态']).action, 'status');
});

test('parseProactiveArgs: help/-h/--help → help', () => {
  assert.strictEqual(leaf.parseProactiveArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseProactiveArgs(['-h']).action, 'help');
  assert.strictEqual(leaf.parseProactiveArgs(['--help']).action, 'help');
});

test('parseProactiveArgs: 未知 → valid:false unknown_action(兜底 status)', () => {
  const p = leaf.parseProactiveArgs(['frobnicate']);
  assert.strictEqual(p.valid, false);
  assert.strictEqual(p.parseError, 'unknown_action');
  assert.strictEqual(p.action, 'status');
});

test('resolveToggle: on/off/toggle 期望态推导', () => {
  // 当前关
  assert.deepStrictEqual(leaf.resolveToggle(false, 'on'), { desired: true, changes: true });
  assert.deepStrictEqual(leaf.resolveToggle(false, 'off'), { desired: false, changes: false });
  assert.deepStrictEqual(leaf.resolveToggle(false, 'toggle'), { desired: true, changes: true });
  // 当前开
  assert.deepStrictEqual(leaf.resolveToggle(true, 'on'), { desired: true, changes: false });
  assert.deepStrictEqual(leaf.resolveToggle(true, 'off'), { desired: false, changes: true });
  assert.deepStrictEqual(leaf.resolveToggle(true, 'toggle'), { desired: false, changes: true });
});

test('resolveToggle: status/help → 不改状态(desired=null)', () => {
  assert.deepStrictEqual(leaf.resolveToggle(true, 'status'), { desired: null, changes: false });
  assert.deepStrictEqual(leaf.resolveToggle(false, 'help'), { desired: null, changes: false });
});

test('buildStatusText: 缺面诚实留白,绝不抛', () => {
  const txt = leaf.buildStatusText({});
  assert.match(txt, /Proactive idle-tick 模式/);
  assert.match(txt, /当前: 已关闭/);
  assert.match(txt, /机制:/);
  // 防呆:null/非对象不抛
  assert.doesNotThrow(() => leaf.buildStatusText(null));
  assert.doesNotThrow(() => leaf.buildStatusText('x'));
});

test('buildStatusText: 有面渲染计数 + dream + assistantMode', () => {
  const txt = leaf.buildStatusText({
    proactive: true, assistantMode: true, dreamNeeded: true, dreamReason: 'aged', lastDream: '2026-06-01T00:00:00Z',
  });
  assert.match(txt, /当前: 已开启 ✓/);
  assert.match(txt, /助手模式: 激活/);
  assert.match(txt, /记忆整理\(dream\): 待触发\(aged\)/);
  assert.match(txt, /上次整理: 2026-06-01/);
});

test('buildToggleResult: 开/关 × 变化/no-op 四象限', () => {
  assert.match(leaf.buildToggleResult(true, true), /已开启/);
  assert.match(leaf.buildToggleResult(true, false), /本就已开启/);
  assert.match(leaf.buildToggleResult(false, true), /已关闭/);
  assert.match(leaf.buildToggleResult(false, false), /本就已关闭/);
});

test('buildHelpText: 含用法各行', () => {
  const txt = leaf.buildHelpText();
  assert.match(txt, /\/proactive on/);
  assert.match(txt, /\/proactive off/);
  assert.match(txt, /\/proactive status/);
});

test('isEnabled: 默认开;0/false/off/no/空 → 关', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({ KHY_PROACTIVE_COMMAND: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_PROACTIVE_COMMAND: v }), false, `v=${v}`);
  }
});
