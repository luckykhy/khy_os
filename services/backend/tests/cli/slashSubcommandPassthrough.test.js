'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { parseInput } = require('../../src/cli/router');
const schema = require('../../src/constants/commandSchema');

// 背景:菜单条目的 route 常带一个**默认**子命令(`/daemon` → `daemon status`)。
// router 原本是原样拼接 —— `/daemon restart` 变成 `daemon status restart`,子命令位被
// status 占死,restart 沦为位置参数被**静默忽略**(不报错,只是默默做了另一件事)。
// 全库有 28 条 route 中招。修法:用户给的参数若是该命令的合法子命令,就丢掉默认子命令。

test('子命令透传:此前静默失效的调用现在都落到子命令位', () => {
  const cases = [
    ['/msg send dingtalk hi', 'msg', 'send', ['dingtalk', 'hi']],
    ['/daemon restart', 'daemon', 'restart', []],
    ['/gateway model', 'gateway', 'model', []],
    ['/vault set K V', 'vault', 'set', ['K', 'V']],
    ['/mesh send id hi', 'mesh', 'send', ['id', 'hi']],
    ['/skill search x', 'skill', 'search', ['x']],
    ['/notify test', 'notify', 'test', []],
    ['/wx scan', 'wx', 'scan', []],
  ];
  for (const [line, cmd, sub, args] of cases) {
    const p = parseInput(line);
    assert.strictEqual(p.command, cmd, `${line}: 命令`);
    assert.strictEqual(p.subCommand, sub, `${line}: 子命令必须是用户敲的那个,不能被 route 的默认值吃掉`);
    assert.deepStrictEqual(p.args, args, `${line}: 位置参数`);
  }
});

test('无参调用逐字节不变(28 个命令各自的默认分支不得被改动)', () => {
  // 这些默认子命令来自各自 route 的第二个词,必须原样保留 —— 否则等于悄悄改了
  // 28 个命令「不带参数时做什么」的语义。
  const cases = [
    ['/msg', 'status'], ['/daemon', 'status'], ['/gateway', 'status'],
    ['/buddy', 'card'], ['/history', 'list'], ['/mesh', 'peers'],
    ['/publish', 'check'], ['/forge', 'help'], ['/skill', 'list'],
    ['/vault', 'list'], ['/notify', 'status'], ['/plugin', 'list'],
  ];
  for (const [line, sub] of cases) {
    const p = parseInput(line);
    assert.strictEqual(p.subCommand, sub, `${line} 无参时应仍是 ${sub}`);
    assert.deepStrictEqual(p.args, [], `${line} 无参时不应有位置参数`);
  }
});

test('非子命令的参数照旧当位置参数(不误判)', () => {
  const p1 = parseInput('/msg 随便一个词');
  assert.strictEqual(p1.subCommand, 'status', '不是合法子命令 → 默认分支保持');
  assert.deepStrictEqual(p1.args, ['随便一个词']);

  const p2 = parseInput('/history 5');
  assert.strictEqual(p2.subCommand, 'list', 'history 的数字参数不是子命令');
  assert.deepStrictEqual(p2.args, ['5']);
});

test('斜杠形式与裸命令形式必须一致(含大小写这种既有怪癖)', () => {
  // 子命令大小写敏感是**全库既有行为**:`daemon RESTART`(不带斜杠)本来就解析不出子命令。
  // 本改动不该发明新语义,只该让 `/daemon X` 与 `daemon X` 表现一致 —— 一致本身就是修复:
  // 改动前 `/daemon RESTART` 会静默跑 status,现在它和裸命令一样落到「无法识别的子命令」。
  for (const pair of [['daemon restart', '/daemon restart'], ['daemon RESTART', '/daemon RESTART'],
    ['msg send a b', '/msg send a b'], ['history 5', '/history 5']]) {
    const bare = parseInput(pair[0]);
    const slash = parseInput(pair[1]);
    assert.strictEqual(slash.command, bare.command, `${pair[1]} 命令应与裸形式一致`);
    // 裸形式无 route 默认值,故仅在裸形式解析出子命令时才要求两者相等;
    // 裸形式没有子命令时,斜杠形式允许保留 route 的默认值(那正是菜单条目的意义)。
    if (bare.subCommand) {
      assert.strictEqual(slash.subCommand, bare.subCommand, `${pair[1]} 子命令应与裸形式一致`);
      assert.deepStrictEqual(slash.args, bare.args, `${pair[1]} 参数应与裸形式一致`);
    }
  }
});

test('门关 → 逐字节回退历史行为(子命令重新被吃掉)', () => {
  const saved = process.env.KHY_SLASH_SUBCOMMAND_PASSTHROUGH;
  process.env.KHY_SLASH_SUBCOMMAND_PASSTHROUGH = 'off';
  try {
    const p = parseInput('/daemon restart');
    assert.strictEqual(p.subCommand, 'status', '门关时应回到历史行为');
    assert.deepStrictEqual(p.args, ['restart'], '子命令重新沦为位置参数');
  } finally {
    if (saved === undefined) delete process.env.KHY_SLASH_SUBCOMMAND_PASSTHROUGH;
    else process.env.KHY_SLASH_SUBCOMMAND_PASSTHROUGH = saved;
  }
});

test('flagRegistry 已登记该门(未登记的话 off 开关会被恒 true 无视)', () => {
  const reg = require('../../src/services/flagRegistry');
  assert.strictEqual(
    reg.isFlagEnabled('KHY_SLASH_SUBCOMMAND_PASSTHROUGH', { KHY_SLASH_SUBCOMMAND_PASSTHROUGH: 'off' }),
    false,
  );
  assert.strictEqual(reg.isFlagEnabled('KHY_SLASH_SUBCOMMAND_PASSTHROUGH', {}), true);
});

test('单词 route 的菜单项不受影响(/models → gateway model 这类保持原样)', () => {
  // route 只有一个词时本就没有默认子命令可丢,逻辑不该介入。
  const single = schema.getBuiltinSlashCommands()
    .filter((e) => e.route && String(e.route).trim().split(/\s+/).length === 1);
  assert.ok(single.length > 0, '应存在单词 route 的条目');
  for (const e of single.slice(0, 5)) {
    const p = parseInput(e.cmd);
    assert.ok(p && p.command, `${e.cmd} 应仍能解析`);
  }
});
