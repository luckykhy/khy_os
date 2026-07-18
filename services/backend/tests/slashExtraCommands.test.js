'use strict';

/**
 * slashExtraCommands 纯叶子单测(node:test)。
 *   node --test services/backend/tests/slashExtraCommands.test.js
 *
 * 证:13 条 extras 内容/顺序锁定、mergeExtraCommands 幂等去重(既有优先)、不 mutate 入参、
 * 冻结不可变。这是经典 REPL 与 TUI 菜单的共同真源,任何漂移都在此显形。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SLASH_EXTRA_COMMANDS, mergeExtraCommands } = require('../src/cli/slashExtraCommands');

test('SLASH_EXTRA_COMMANDS: 锁定 13 条,cmd 顺序与历史一致', () => {
  const cmds = SLASH_EXTRA_COMMANDS.map((e) => e.cmd);
  assert.deepEqual(cmds, [
    '/study', '/role', '/hud', '/mind', '/intent', '/new', '/reset',
    '/folded', '/think', '/trace', '/pool', '/push', '/optimize',
  ]);
});

test('SLASH_EXTRA_COMMANDS: 每条有 cmd/label/desc,/mind 带 flag', () => {
  for (const e of SLASH_EXTRA_COMMANDS) {
    assert.ok(e.cmd && e.cmd.startsWith('/'), `${e.cmd} 应以 / 开头`);
    assert.equal(typeof e.label, 'string');
    assert.equal(typeof e.desc, 'string');
    assert.ok(e.label.length > 0 && e.desc.length > 0);
  }
  const mind = SLASH_EXTRA_COMMANDS.find((e) => e.cmd === '/mind');
  assert.equal(mind.flag, 'mind');
});

test('mergeExtraCommands: 空 base → 全 13 条按序追加', () => {
  const merged = mergeExtraCommands([]);
  assert.equal(merged.length, 13);
  assert.equal(merged[0].cmd, '/study');
  assert.equal(merged[12].cmd, '/optimize');
});

test('mergeExtraCommands: 既有优先,同名 cmd 不重复(用 base 的对象)', () => {
  const base = [{ cmd: '/pool', label: 'BASE-POOL', desc: 'base wins' }];
  const merged = mergeExtraCommands(base);
  const pools = merged.filter((c) => c.cmd === '/pool');
  assert.equal(pools.length, 1);
  assert.equal(pools[0].label, 'BASE-POOL'); // base 优先,extras 的 /pool 被跳过
  assert.equal(merged.length, 1 + 12);       // 13 extras 里 /pool 被跳过 → +12
});

test('mergeExtraCommands: 不 mutate 入参', () => {
  const base = [{ cmd: '/x' }];
  const snapshot = base.slice();
  const merged = mergeExtraCommands(base);
  assert.deepEqual(base, snapshot);   // 入参未变
  assert.notEqual(merged, base);      // 返回新数组
  assert.equal(base.length, 1);
});

test('mergeExtraCommands: 幂等——对已含 extras 的列表再合并不增不减', () => {
  const once = mergeExtraCommands([]);
  const twice = mergeExtraCommands(once);
  assert.deepEqual(twice.map((c) => c.cmd), once.map((c) => c.cmd));
});

test('mergeExtraCommands: 非数组入参按空处理(绝不抛)', () => {
  assert.equal(mergeExtraCommands(null).length, 13);
  assert.equal(mergeExtraCommands(undefined).length, 13);
  assert.equal(mergeExtraCommands('nope').length, 13);
});

test('SLASH_EXTRA_COMMANDS: 冻结不可变', () => {
  assert.ok(Object.isFrozen(SLASH_EXTRA_COMMANDS));
  assert.ok(Object.isFrozen(SLASH_EXTRA_COMMANDS[0]));
});
