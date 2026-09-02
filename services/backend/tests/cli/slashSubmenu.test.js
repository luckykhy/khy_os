'use strict';

/**
 * 斜杠菜单二级(子命令层)功能级单测(node:test)。
 *   node --test services/backend/tests/cli/slashSubmenu.test.js
 *
 * 证:① getMenuSubCommands = ROUTER_SUB_COMMANDS ∪ MENU_SUB_SUGGESTIONS(单一真源);
 *    ② TUI computeSlash 在「/cmd 」「/cmd partial」展开二级、更深参数不弹、未知命令不弹;
 *    ③ applyCompletion 对 slash-sub 填充 `/cmd sub `(可继续补参)。
 * REPL 侧二级是 replSession 闭包内逻辑(按键消费),此处以同一数据源 + TUI 路径覆盖;
 * REPL 行为由人工/真终端验收。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getMenuSubCommands,
  getRouterSubCommands,
} = require('../../src/constants/commandSchema');
const { computeSlash, applyCompletion } = require('../../src/cli/tui/hooks/useCompletions.js');

delete process.env.KHY_TUI_SLASH_SUBSTRING;

test('getMenuSubCommands: 含 router 子命令真源与 flag 参数建议,且返回克隆(不可 mutate 源)', () => {
  const subs = getMenuSubCommands();
  const router = getRouterSubCommands();
  for (const key of ['gateway', 'skill', 'session', 'prompt', 'wx']) {
    assert.ok(Array.isArray(subs[key]) && subs[key].length > 0, `${key} 应有二级子命令`);
    assert.deepEqual(subs[key], router[key], `${key} 与 ROUTER_SUB_COMMANDS 一致`);
  }
  assert.deepEqual(subs['sandbox-toggle'], ['on', 'off', 'auto', 'toggle', 'status']);
  assert.deepEqual(subs.lang, ['zh', 'en', 'auto']);
  // 克隆语义:改动返回值不影响真源
  subs.gateway.push('__pollutant__');
  assert.ok(!getMenuSubCommands().gateway.includes('__pollutant__'));
});

test('computeSlash: 「/cmd 」(尾空格)展开完整二级列表', () => {
  const res = computeSlash('/gateway ');
  assert.ok(res, '/gateway + 空格应返回二级菜单');
  assert.equal(res.kind, 'slash-sub');
  assert.equal(res.parentCmd, '/gateway');
  const values = res.items.map((i) => i.value);
  assert.ok(values.includes('status'), '应含 status 子命令');
  assert.ok(values.includes('config'), '应含 config 子命令');
});

test('computeSlash: 「/cmd partial」按前缀过滤二级', () => {
  const res = computeSlash('/gateway st');
  assert.ok(res, '/gateway st 应返回二级菜单');
  const values = res.items.map((i) => i.value);
  assert.ok(values.includes('status'), 'st 应命中 status');
  assert.ok(!values.includes('config'), 'st 不应命中 config');
});

test('computeSlash: flag 参数建议命令也展开二级(/lang /sandbox-toggle)', () => {
  const lang = computeSlash('/lang ');
  assert.ok(lang && lang.kind === 'slash-sub');
  assert.deepEqual(
    lang.items.map((i) => i.value),
    ['zh', 'en', 'auto']
  );
  const sb = computeSlash('/sandbox-toggle o');
  assert.ok(sb && sb.kind === 'slash-sub');
  assert.deepEqual(sb.items.map((i) => i.value), ['on', 'off']);
});

test('computeSlash: 无子命令的命令/两级以上参数/非斜杠 → 不弹二级', () => {
  assert.equal(computeSlash('/clear '), null, '/clear 无子命令,不弹二级');
  assert.equal(computeSlash('/gateway status x'), null, '两级以上自由键入');
  assert.equal(computeSlash('/gateway  st'), null, '两个空格(异常形态)不弹');
  assert.equal(computeSlash('/nostatprefix '), null, '未知命令不弹');
  assert.equal(computeSlash('hello '), null, '非斜杠不弹');
});

test('applyCompletion: slash-sub 填充为「/cmd sub 」且偏移落在行尾(可继续补参)', () => {
  const comp = computeSlash('/skill le');
  assert.ok(comp && comp.kind === 'slash-sub');
  const item = comp.items.find((i) => i.value === 'learn');
  assert.ok(item, 'le 应命中 learn 子命令');
  const { text, offset } = applyCompletion('/skill le', comp, item);
  assert.equal(text, '/skill learn ');
  assert.equal(offset, text.length);
});
