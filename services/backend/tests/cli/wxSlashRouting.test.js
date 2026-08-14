'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseInput } = require('../../src/cli/router');
const { resolveAlias } = require('../../src/cli/aliases');
const schema = require('../../src/constants/commandSchema');

// 背景(这条测试为什么存在):
//   router.js 对带 `route` 的斜杠命令是「展开后拼接用户参数」:
//       parts = [...routeParts, ...parts.slice(1)]
//   所以若 /wx 的 route 写成 'wx status',`/wx scan` 会变成 `wx status scan` ——
//   子命令位被 status 占死,scan 沦为位置参数被静默忽略,用户以为在扫码、实际在看状态。
//   route 必须是裸命令 'wx',让子命令原样落到子命令位。
//   (同样的坑在既有的 /msg 上也存在:`/msg send` → sub=status。此处不代其修复,只守住 wx。)

test('/wx 的 route 必须是裸命令,否则子命令会被吃掉', () => {
  const entry = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/wx');
  assert.ok(entry, '/wx 应登记在斜杠菜单里');
  assert.strictEqual(entry.route, 'wx', 'route 带子命令会让 /wx scan 静默失效');
});

test('/wx 子命令透传:scan / connect / stop / logout 都要落到子命令位', () => {
  const cases = [
    ['/wx', '', []],
    ['/wx scan', 'scan', []],
    ['/wx login', 'login', []],
    ['/wx connect', 'connect', []],
    ['/wx stop', 'stop', []],
    ['/wx status', 'status', []],
    ['/wx logout bot-1', 'logout', ['bot-1']],
  ];
  for (const [line, sub, args] of cases) {
    const p = parseInput(line);
    assert.strictEqual(p.command, 'wx', `${line}: 命令应是 wx`);
    assert.strictEqual(p.subCommand || '', sub, `${line}: 子命令应是「${sub}」`);
    assert.deepStrictEqual(p.args, args, `${line}: 位置参数`);
  }
});

test('/wx 空子命令落到 status(handler 的默认分支)', () => {
  const { handleWx } = require('../../src/cli/handlers/wx');
  // 不断言输出内容,只断言它不抛且返回退出码 —— status 分支在未绑定时返回 0。
  const rc = handleWx('', [], {});
  assert.ok(rc === 0 || typeof rc.then === 'function', '空子命令必须被当作 status 处理');
});

test('/wxscan 是 /wx scan 的可发现别名(直达二维码)', () => {
  const entry = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/wxscan');
  assert.ok(entry, '应有一条专门的扫码入口,便于在 / 菜单里找到');
  assert.strictEqual(entry.route, 'wx scan');
  const p = parseInput('/wxscan');
  assert.strictEqual(p.command, 'wx');
  assert.strictEqual(p.subCommand, 'scan', '/wxscan 必须直达扫码,而不是状态');
});

test('wx 的子命令白名单覆盖全部对外别名(否则会被当成位置参数)', () => {
  const subs = schema.getRouterSubCommands().wx || [];
  for (const k of ['status', 'scan', 'login', 'connect', 'start', 'stop', 'disconnect', 'logout', 'help']) {
    assert.ok(subs.includes(k), `子命令白名单缺 ${k} —— 缺了会被解析成位置参数并落到默认分支`);
  }
});

// ── 策略二绑定命令:路由落点 + 中文别名 ────────────────────────────

test('wx bind/unbind 在子命令白名单里(否则会被当位置参数落回 status)', () => {
  const subs = schema.getRouterSubCommands().wx || [];
  assert.ok(subs.includes('bind'), '白名单缺 bind');
  assert.ok(subs.includes('unbind'), '白名单缺 unbind');
});

test('/wx bind 透传:accountId 落位置参数,--workspace/--agent 落 options', () => {
  const p = parseInput('/wx bind bot-1 --workspace /ws/a --agent quant');
  assert.strictEqual(p.command, 'wx');
  assert.strictEqual(p.subCommand, 'bind', 'bind 必须落到子命令位');
  assert.deepStrictEqual(p.args, ['bot-1']);
  assert.strictEqual(p.options.workspace, '/ws/a');
  assert.strictEqual(p.options.agent, 'quant');
});

test('/wx unbind 透传:accountId 落位置参数', () => {
  const p = parseInput('/wx unbind #2');
  assert.strictEqual(p.command, 'wx');
  assert.strictEqual(p.subCommand, 'unbind');
  assert.deepStrictEqual(p.args, ['#2']);
});

test('中文别名 绑定/解绑 解析到 wx bind/unbind', () => {
  assert.deepStrictEqual(resolveAlias('绑定'), { command: 'wx', subCommand: 'bind' });
  assert.deepStrictEqual(resolveAlias('解绑'), { command: 'wx', subCommand: 'unbind' });
  assert.deepStrictEqual(resolveAlias('wxbind'), { command: 'wx', subCommand: 'bind' });
  assert.deepStrictEqual(resolveAlias('wxunbind'), { command: 'wx', subCommand: 'unbind' });
});

test('别名 绑定 经 parseInput 落到 wx bind 子命令位,参数透传', () => {
  const p = parseInput('绑定 #1 --workspace /ws/a');
  assert.strictEqual(p.command, 'wx');
  assert.strictEqual(p.subCommand, 'bind');
  assert.deepStrictEqual(p.args, ['#1']);
  assert.strictEqual(p.options.workspace, '/ws/a');
});
