'use strict';

// themePanelLines 叶子契约测试(node:test)。
// 覆盖:门控开关、buildThemePanelLines 排版(当前主题 + 可用清单 + 切换用法)、
// active 标记、缺 label 退回 name、门控关 / 空 / 非法输入 → []、绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  themePanelEnabled,
  buildThemePanelLines,
} = require('../../src/cli/themePanelLines');

const SAMPLE = [
  { name: 'default', label: 'Claude Dark', description: 'd', active: true },
  { name: 'dracula', label: 'Dracula', description: 'd', active: false },
  { name: 'nord', label: 'Nord', description: 'd', active: false },
];

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(themePanelEnabled({}), true);
  assert.strictEqual(themePanelEnabled({ KHY_THEME_PANEL: '' }), true);
  assert.strictEqual(themePanelEnabled({ KHY_THEME_PANEL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(themePanelEnabled({ KHY_THEME_PANEL: off }), false, off);
  }
});

test('buildThemePanelLines:当前主题 + 可用清单 + 切换用法', () => {
  const lines = buildThemePanelLines(SAMPLE, {});
  assert.deepStrictEqual(lines, [
    '    当前: Claude Dark（default）',
    '    可用主题:',
    '      default · Claude Dark  [当前]',
    '      dracula · Dracula',
    '      nord · Nord',
    '    切换: /theme <名称>',
  ]);
});

test('无 active 主题 → 当前: 未知', () => {
  const lines = buildThemePanelLines([{ name: 'a', label: 'A' }], {});
  assert.strictEqual(lines[0], '    当前: 未知');
});

test('缺 label → 退回 name', () => {
  const lines = buildThemePanelLines([{ name: 'x', active: true }], {});
  assert.strictEqual(lines[0], '    当前: x（x）');
  assert.strictEqual(lines[2], '      x · x  [当前]');
});

test('跳过缺 name 的条目', () => {
  const lines = buildThemePanelLines([{ label: 'nope' }, { name: 'ok', label: 'OK', active: true }], {});
  // 只有 ok 进入清单(缺 name 者跳过)。
  assert.ok(lines.some((l) => l.includes('ok · OK')));
  assert.ok(!lines.some((l) => l.includes('nope')));
});

test('门控关 → []', () => {
  assert.deepStrictEqual(buildThemePanelLines(SAMPLE, { KHY_THEME_PANEL: '0' }), []);
});

test('空 / 非数组 / 非法输入 → []、绝不抛', () => {
  for (const bad of [null, undefined, [], {}, 42, 'x']) {
    assert.deepStrictEqual(buildThemePanelLines(bad, {}), []);
  }
});
