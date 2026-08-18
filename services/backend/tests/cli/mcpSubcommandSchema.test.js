'use strict';

/**
 * mcp 子命令注册测试 — 保证 `khy mcp <子命令>` 的路由可达。
 *
 * 背景(刀:presets 曾漏注册):router.parseInput 只在 `ROUTER_SUB_COMMANDS[command]` 命中 args[0] 时才
 * 把 token 升成 subCommand。`mcp presets/preset/show/test/enable/disable` 若不在 schema 里,
 * 会以 position args 形态落进 routerDispatchSlash 的只读状态视图,永远到不了 handlers/mcp 的
 * 增删查改逻辑(presets 因此静默失效)。本测试把「mcp 全家桶子命令」钉死,防止回归。
 */

const test = require('node:test');
const assert = require('node:assert');

const schema = require('../../src/constants/commandSchema');
const { parseInput } = require('../../src/cli/router');

test('ROUTER_SUB_COMMANDS.mcp 注册了全部管理子命令', () => {
  const subs = schema.getRouterSubCommands().mcp || [];
  for (const expected of ['governance', 'gov', 'add', 'remove', 'rm',
    'presets', 'preset', 'serve', 'list', 'show', 'test', 'enable', 'disable', 'eco', 'ecosystem', '生态']) {
    assert.ok(subs.includes(expected), `mcp 子命令应包含 ${expected}`);
  }
});

test('khy mcp presets / show / test / enable / disable / eco 解析出 subCommand', () => {
  const cases = [
    ['mcp presets', 'presets', []],
    ['mcp preset', 'preset', []],
    ['mcp show github', 'show', ['github']],
    ['mcp test filesystem', 'test', ['filesystem']],
    ['mcp enable github', 'enable', ['github']],
    ['mcp disable github', 'disable', ['github']],
    ['mcp eco', 'eco', []],
    ['mcp ecosystem', 'ecosystem', []],
    ['mcp 生态', '生态', []],
    ['mcp list', 'list', []],
  ];
  for (const [line, sub, args] of cases) {
    const p = parseInput(line);
    assert.strictEqual(p.command, 'mcp', `${line}: command`);
    assert.strictEqual(p.subCommand, sub, `${line}: 子命令必须是 ${sub}`);
    assert.deepStrictEqual(p.args, args, `${line}: 位置参数`);
  }
});

test('routerDispatchSlash 的 mcp case 把新子命令路由给 handlers/mcp', async () => {
  const { dispatchSlashCommand, setRouterDispatchSlashDeps, ROUTER_NOT_HANDLED } =
    require('../../src/cli/routerDispatchSlash');
  setRouterDispatchSlashDeps({ route: () => true });
  // `list` 落在只读状态视图之外不走 handler?不——`list` 由 mcp case 下方只读视图消费,仍不算
  // ROUTER_NOT_HANDLED(命令本身被 mcp case 拦截)。这里断言:新子命令都能被 mcp case 拦截
  // (返回非哨兵),不泄漏到主 switch。真实 handler 的 IO 副作用由 handlers/mcp 的叶子测试覆盖。
  for (const sub of ['presets', 'preset', 'show', 'test', 'enable', 'disable', 'eco', 'ecosystem', '生态']) {
    const r = await dispatchSlashCommand('mcp', {
      subCommand: sub, args: [], options: {}, rawCommandToken: '', parsed: {}, context: {},
      printError() {}, printHelp() {}, printInfo() {}, printTable() {}, printSuccess() {},
      printWarn() {}, withSpinner() {}, chalk: {},
    });
    assert.notStrictEqual(r, ROUTER_NOT_HANDLED, `${sub} 必须被 mcp case 消费`);
  }
});
