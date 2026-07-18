'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../src/services/ide/idePlan');

// ── 语法解析 ──────────────────────────────────────────────────────────────
test('parseIdeArgs: 空参 = status', () => {
  assert.deepStrictEqual(leaf.parseIdeArgs([]), { action: 'status', valid: true, parseError: null });
});
test('parseIdeArgs: status/list/help 动作词', () => {
  assert.strictEqual(leaf.parseIdeArgs(['status']).action, 'status');
  assert.strictEqual(leaf.parseIdeArgs(['list']).action, 'list');
  assert.strictEqual(leaf.parseIdeArgs(['help']).action, 'help');
  assert.strictEqual(leaf.parseIdeArgs(['列出']).action, 'list');
  assert.strictEqual(leaf.parseIdeArgs(['状态']).action, 'status');
});
test('parseIdeArgs: 未知动作 → valid=false 默认 status', () => {
  const r = leaf.parseIdeArgs(['wat']);
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.parseError, 'unknown_action');
  assert.strictEqual(r.action, 'status');
});
test('parseIdeArgs: 非数组防呆', () => {
  assert.strictEqual(leaf.parseIdeArgs(null).action, 'status');
});

// ── summarizeDetections ───────────────────────────────────────────────────
test('summarizeDetections: 过滤可用项', () => {
  const s = leaf.summarizeDetections([
    { name: 'vscode', available: true },
    { name: 'idea', available: false },
    null,
  ]);
  assert.strictEqual(s.all.length, 2);
  assert.strictEqual(s.availableCount, 1);
  assert.strictEqual(s.available[0].name, 'vscode');
});
test('summarizeDetections: 非数组防呆', () => {
  const s = leaf.summarizeDetections(null);
  assert.strictEqual(s.all.length, 0);
  assert.strictEqual(s.availableCount, 0);
});

// ── buildListText ─────────────────────────────────────────────────────────
test('buildListText: 空 → 提示无 IDE', () => {
  assert.match(leaf.buildListText([]), /未探测到任何已知 IDE/);
});
test('buildListText: 列出可用与未安装', () => {
  const t = leaf.buildListText([
    { name: 'vscode', available: true, installPath: '/usr/bin/code' },
    { name: 'idea', available: false },
  ]);
  assert.match(t, /vscode/);
  assert.match(t, /\/usr\/bin\/code/);
  assert.match(t, /idea\(未安装\)/);
  assert.match(t, /共 2 项,其中 1 项可用/);
});

// ── buildStatusText ───────────────────────────────────────────────────────
test('buildStatusText: 无 IDE + bridge 未跑', () => {
  const t = leaf.buildStatusText({ detections: [], bridge: { running: false } });
  assert.match(t, /未探测到可用 IDE/);
  assert.match(t, /bridge 未运行/);
  assert.match(t, /不伪造 IDE 扩展握手/);
});
test('buildStatusText: 有 IDE + bridge 运行(含客户端数)', () => {
  const t = leaf.buildStatusText({
    detections: [{ name: 'vscode', available: true }],
    bridge: { running: true, url: 'http://192.168.1.2:8080', clientCount: 2 },
  });
  assert.match(t, /探测到 1 个可用 — vscode/);
  assert.match(t, /bridge 运行中/);
  assert.match(t, /192\.168\.1\.2:8080/);
  assert.match(t, /已连客户端 2 个/);
});
test('buildStatusText: 防呆 —— 非对象不抛', () => {
  assert.doesNotThrow(() => leaf.buildStatusText(null));
  assert.match(leaf.buildStatusText(null), /bridge 未运行/);
});

// ── help/unknown ──────────────────────────────────────────────────────────
test('buildHelpText/buildUnknownText 含 /ide', () => {
  assert.match(leaf.buildHelpText(), /\/ide/);
  assert.match(leaf.buildUnknownText(), /未知子命令/);
});

// ── 门控梯 ────────────────────────────────────────────────────────────────
test('isEnabled: 默认开', () => {
  assert.strictEqual(leaf.isEnabled(undefined), true);
  assert.strictEqual(leaf.isEnabled({}), true);
});
test('isEnabled: 关值', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(leaf.isEnabled({ KHY_IDE_COMMAND: v }), false, JSON.stringify(v));
  }
});
test('isEnabled: 其它值开', () => {
  assert.strictEqual(leaf.isEnabled({ KHY_IDE_COMMAND: 'on' }), true);
});
