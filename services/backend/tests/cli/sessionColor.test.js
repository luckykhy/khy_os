'use strict';

// /color 契约测试:纯叶子(调色板/reset/accent 优先级/措辞)+ 进程级活动色 holder。
// 对齐 CC /color 背后逻辑:per-session 显示色 → TUI 输入框 accent。零网络。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../src/cli/sessionColor');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_SESSION_COLOR: off }), false, `应关: ${off}`);
  }
});

test('调色板与 reset 别名识别', () => {
  for (const c of ['blue', 'green', 'orange', 'purple', 'red', 'cyan', 'yellow', 'magenta']) {
    assert.ok(leaf.isValidColor(c), `${c} 有效`);
    assert.ok(leaf.isValidColor(c.toUpperCase()), '大小写无关');
  }
  assert.ok(!leaf.isValidColor('teal'), '调色板外无效');
  for (const r of ['default', 'reset', 'none', 'gray', 'grey']) {
    assert.ok(leaf.isReset(r), `${r} 是 reset 别名`);
  }
  assert.ok(!leaf.isReset('blue'), 'blue 不是 reset');
});

test('parseColorArgs:取第一个非空 token', () => {
  assert.strictEqual(leaf.parseColorArgs([undefined, '', 'Blue', 'red']), 'blue');
  assert.strictEqual(leaf.parseColorArgs([]), '');
  assert.strictEqual(leaf.parseColorArgs('Green'), 'green');
});

test('resolveAccent:优先级 bash>memory>会话色>null', () => {
  // mode 颜色永远优先(即便有会话色)
  assert.strictEqual(leaf.resolveAccent({ bashMode: true, sessionColor: 'red', env: {} }), 'magenta');
  assert.strictEqual(leaf.resolveAccent({ memoryMode: true, sessionColor: 'red', env: {} }), 'green');
  // 普通态 → 会话色生效
  assert.strictEqual(leaf.resolveAccent({ sessionColor: 'purple', env: {} }), 'purple');
  // 无会话色 → null(PromptFrame 默认 cyan)
  assert.strictEqual(leaf.resolveAccent({ env: {} }), null);
  // 'default' 哨兵 / 调色板外 → null
  assert.strictEqual(leaf.resolveAccent({ sessionColor: 'default', env: {} }), null);
  assert.strictEqual(leaf.resolveAccent({ sessionColor: 'teal', env: {} }), null);
});

test('resolveAccent:门控关 → 忽略会话色(字节回退,与历史 null 一致)', () => {
  // 历史:accent = bash?magenta : memory?green : null
  assert.strictEqual(leaf.resolveAccent({ sessionColor: 'red', env: { KHY_SESSION_COLOR: 'off' } }), null);
  // mode 颜色不受门控影响(历史本就如此)
  assert.strictEqual(leaf.resolveAccent({ bashMode: true, env: { KHY_SESSION_COLOR: 'off' } }), 'magenta');
  assert.strictEqual(leaf.resolveAccent({ memoryMode: true, env: { KHY_SESSION_COLOR: 'off' } }), 'green');
});

test('formatters:措辞含关键信息', () => {
  assert.match(leaf.formatList(), /可用颜色/);
  assert.match(leaf.formatInvalid('teal'), /无效颜色.*teal/);
  assert.match(leaf.formatSet('blue'), /blue/);
  assert.match(leaf.formatReset(), /默认/);
});

// ── 进程级活动色 holder ──
test('sessionColorState:set/get + default 哨兵 → null', () => {
  const state = require('../../src/cli/sessionColorState');
  state._reset();
  state.setSessionColor('red');
  assert.strictEqual(state.getSessionColor(), 'red');
  state.setSessionColor('default');
  assert.strictEqual(state.getSessionColor(), null, "'default' 哨兵 → null");
  state.setSessionColor('Blue');
  assert.strictEqual(state.getSessionColor(), 'blue', '归一小写');
  state.setSessionColor(null);
  assert.strictEqual(state.getSessionColor(), null);
  state._reset();
});

test('端到端:set 后 resolveAccent 用上 holder 的会话色', () => {
  const state = require('../../src/cli/sessionColorState');
  state._reset();
  state.setSessionColor('yellow');
  const accent = leaf.resolveAccent({ bashMode: false, memoryMode: false, sessionColor: state.getSessionColor(), env: {} });
  assert.strictEqual(accent, 'yellow');
  state._reset();
});
