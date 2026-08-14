'use strict';

/**
 * ariaSnapshot.test.js — 纯叶子:Playwright agent-first 范式的确定性逻辑(零 IO,确定性)。
 *
 * 重点验收:
 *  - serializeAriaTree 把节点排成 Playwright 风格 `- role "name" [props] [ref=eN]`,缩进按 depth。
 *  - refSelector 注入红线:只接受 e<数字>,任意字符串一律 null(绝不拼进属性选择器)。
 *  - buildLocatorSpec 把 by → 原生 getBy* 方法 + 参数(locator-first 单一真源)。
 *  - decideActionable 三态(not-attached/not-visible/disabled/ok)。
 *  - 门控 isEnabled 默认开,0/false/off/no 关。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const aria = require('../../../src/services/browser/ariaSnapshot');

// ── 门控 ────────────────────────────────────────────────────────────
test('isEnabled: 默认开;0/false/off/no 关', () => {
  assert.equal(aria.isEnabled({}), true);
  assert.equal(aria.isEnabled({ KHY_BROWSER_ARIA: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(aria.isEnabled({ KHY_BROWSER_ARIA: v }), false, `KHY_BROWSER_ARIA=${v} 应关`);
  }
});

// ── 序列化 ──────────────────────────────────────────────────────────
test('serializeAriaTree: Playwright 风格行 + 缩进 + ref 放最后', () => {
  const text = aria.serializeAriaTree([
    { depth: 0, role: 'heading', name: 'Todos', level: 1, ref: 'e1' },
    { depth: 1, role: 'textbox', name: 'What needs to be done?', ref: 'e2' },
    { depth: 1, role: 'button', name: 'Submit', ref: 'e3' },
  ]);
  assert.equal(text,
    '- heading "Todos" [level=1] [ref=e1]\n'
    + '  - textbox "What needs to be done?" [ref=e2]\n'
    + '  - button "Submit" [ref=e3]');
});

test('serializeAriaTree: 属性后缀 checked/selected/expanded/disabled/mixed', () => {
  assert.equal(aria.formatNode({ depth: 0, role: 'checkbox', name: 'A', checked: true, ref: 'e1' }),
    '- checkbox "A" [checked] [ref=e1]');
  assert.equal(aria.formatNode({ depth: 0, role: 'checkbox', name: 'B', checked: 'mixed', ref: 'e2' }),
    '- checkbox "B" [checked=mixed] [ref=e2]');
  assert.equal(aria.formatNode({ depth: 0, role: 'option', name: 'C', selected: true, ref: 'e3' }),
    '- option "C" [selected] [ref=e3]');
  assert.equal(aria.formatNode({ depth: 0, role: 'button', name: 'D', expanded: true, disabled: true, ref: 'e4' }),
    '- button "D" [expanded] [disabled] [ref=e4]');
});

test('serializeAriaTree: 名字折叠空白/转义引号/截断;空名不带引号', () => {
  assert.equal(aria.formatNode({ depth: 0, role: 'button', name: '  hello   world  ', ref: 'e1' }),
    '- button "hello world" [ref=e1]');
  assert.equal(aria.formatNode({ depth: 0, role: 'link', name: 'say "hi"', ref: 'e2' }),
    '- link "say \\"hi\\"" [ref=e2]');
  assert.equal(aria.formatNode({ depth: 0, role: 'generic', name: '', ref: 'e3' }),
    '- generic [ref=e3]');
});

test('serializeAriaTree: 空/非数组 → 空串,绝不抛', () => {
  assert.equal(aria.serializeAriaTree([]), '');
  assert.equal(aria.serializeAriaTree(null), '');
  assert.equal(aria.serializeAriaTree(undefined), '');
  // 含脏元素也不崩,跳过非对象
  assert.equal(aria.serializeAriaTree([null, 'x', { depth: 0, role: 'button', name: 'ok' }]),
    '- button "ok"');
});

// ── ref → 选择器(注入红线)─────────────────────────────────────────
test('refSelector: 只接受 e<数字>,其余一律 null(注入防护)', () => {
  assert.equal(aria.refSelector('e5'), '[data-khy-ref="e5"]');
  assert.equal(aria.refSelector(' e42 '), '[data-khy-ref="e42"]');
  assert.equal(aria.refSelector('e5"] , [onclick'), null);   // 属性选择器注入
  assert.equal(aria.refSelector('a/b'), null);
  assert.equal(aria.refSelector('e'), null);
  assert.equal(aria.refSelector(''), null);
  assert.equal(aria.refSelector(null), null);
  assert.equal(aria.refSelector('5'), null);
});

// ── 可操作裁决(自动等待真源)─────────────────────────────────────
test('decideActionable: not-attached/not-visible/disabled/ok', () => {
  assert.deepEqual(aria.decideActionable({ attached: false }), { actionable: false, reason: 'not-attached' });
  assert.deepEqual(aria.decideActionable({ visible: false }), { actionable: false, reason: 'not-visible' });
  assert.deepEqual(aria.decideActionable({ enabled: false }), { actionable: false, reason: 'disabled' });
  assert.deepEqual(aria.decideActionable({ visible: true, enabled: true }), { actionable: true, reason: 'ok' });
  assert.deepEqual(aria.decideActionable({}), { actionable: true, reason: 'ok' });
});

// ── locator-first 映射(单一真源)──────────────────────────────────
test('buildLocatorSpec: by=role → getByRole(role,{name,exact})', () => {
  assert.deepEqual(aria.buildLocatorSpec({ by: 'role', role: 'Button', name: 'Submit' }),
    { method: 'getByRole', primary: 'button', options: { name: 'Submit' } });
  assert.deepEqual(aria.buildLocatorSpec({ by: 'role', role: 'textbox', name: 'Q', exact: true }),
    { method: 'getByRole', primary: 'textbox', options: { name: 'Q', exact: true } });
  // 只有角色没名字 → 无 options
  assert.deepEqual(aria.buildLocatorSpec({ by: 'role', role: 'link' }),
    { method: 'getByRole', primary: 'link', options: undefined });
  // 缺角色 → null
  assert.equal(aria.buildLocatorSpec({ by: 'role' }), null);
});

test('buildLocatorSpec: text/label/placeholder/testid 映射', () => {
  assert.deepEqual(aria.buildLocatorSpec({ by: 'text', name: 'Hello' }),
    { method: 'getByText', primary: 'Hello', options: undefined });
  assert.deepEqual(aria.buildLocatorSpec({ by: 'label', name: 'Email', exact: true }),
    { method: 'getByLabel', primary: 'Email', options: { exact: true } });
  assert.deepEqual(aria.buildLocatorSpec({ by: 'placeholder', name: 'Search…' }),
    { method: 'getByPlaceholder', primary: 'Search…', options: undefined });
  // testid 无 options
  assert.deepEqual(aria.buildLocatorSpec({ by: 'testid', name: 'submit-btn', exact: true }),
    { method: 'getByTestId', primary: 'submit-btn', options: undefined });
});

test('buildLocatorSpec: 未知 by / 空值 → null(绝不抛)', () => {
  assert.equal(aria.buildLocatorSpec({ by: 'xpath', name: '//a' }), null);
  assert.equal(aria.buildLocatorSpec({ by: 'text', name: '' }), null);
  assert.equal(aria.buildLocatorSpec({}), null);
  assert.equal(aria.buildLocatorSpec(null), null);
});

test('clampMax: 默认 2000,夹到 [1,5000]', () => {
  assert.equal(aria.clampMax(undefined), 2000);
  assert.equal(aria.clampMax(0), 2000);
  assert.equal(aria.clampMax(-5), 2000);
  assert.equal(aria.clampMax(100), 100);
  assert.equal(aria.clampMax(99999), 5000);
  assert.equal(aria.clampMax('abc'), 2000);
});

test('确定性:同输入多次调用结果一致', () => {
  const a = aria.buildLocatorSpec({ by: 'role', role: 'button', name: 'X' });
  const b = aria.buildLocatorSpec({ by: 'role', role: 'button', name: 'X' });
  assert.deepEqual(a, b);
  const t1 = aria.serializeAriaTree([{ depth: 0, role: 'button', name: 'X', ref: 'e1' }]);
  const t2 = aria.serializeAriaTree([{ depth: 0, role: 'button', name: 'X', ref: 'e1' }]);
  assert.equal(t1, t2);
});
