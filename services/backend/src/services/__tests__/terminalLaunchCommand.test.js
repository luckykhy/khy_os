'use strict';

/**
 * terminalLaunchCommand.test.js — 「在新终端窗口里启动交互式 agent」的每平台 argv
 * 构造纯叶子契约(node:test)。
 *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 含大小写空白 / 注册表委托)、
 * _basenameNoExt(去引号/去扩展/小写 / 坏输入返 '')、isInteractiveTerminalApp
 * (白名单命中 / 带路径与扩展命中 / 门关恒 false / 未知目标 false / 坏输入 false)、
 * buildTerminalLaunchArgv(win/darwin/linux argv 形状 + 参数透传 + COMSPEC 覆盖 +
 * 空 target 返 null + 坏输入不抛返 null)、INTERACTIVE_TERMINAL_APPS 冻结。
 * 零 IO、确定性——每断言显式传 env/platform,不依赖进程环境。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const tlc = require('../terminalLaunchCommand');

test('isEnabled:默认开;显式 falsy(含大小写/空白)关', () => {
  assert.equal(tlc.isEnabled({}), true);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: '1' }), true);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'on' }), true);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: '0' }), false);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'false' }), false);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: ' OFF ' }), false);
  assert.equal(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'No' }), false);
});

test('_basenameNoExt:去引号、去扩展、小写;坏输入返空', () => {
  assert.equal(tlc._basenameNoExt('opencode'), 'opencode');
  assert.equal(tlc._basenameNoExt('OpenCode.CMD'), 'opencode');
  assert.equal(tlc._basenameNoExt('"C:\\tools\\claude.exe"'), 'claude');
  assert.equal(tlc._basenameNoExt('/usr/local/bin/codex'), 'codex');
  assert.equal(tlc._basenameNoExt('opencode.ps1'), 'opencode');
  assert.equal(tlc._basenameNoExt(''), '');
  assert.equal(tlc._basenameNoExt(null), '');
  assert.equal(tlc._basenameNoExt(undefined), '');
});

test('isInteractiveTerminalApp:白名单命中(含路径/扩展);门关/未知/坏输入 false', () => {
  assert.equal(tlc.isInteractiveTerminalApp('opencode', {}), true);
  assert.equal(tlc.isInteractiveTerminalApp('/usr/local/bin/opencode', {}), true);
  assert.equal(tlc.isInteractiveTerminalApp('opencode.cmd', {}), true);
  assert.equal(tlc.isInteractiveTerminalApp('claude', {}), true);
  assert.equal(tlc.isInteractiveTerminalApp('codex', {}), true);
  // 门关 → 恒 false(调用方逐字节回退历史启动)
  assert.equal(tlc.isInteractiveTerminalApp('opencode', { KHY_TERMINAL_LAUNCH: '0' }), false);
  // 未知目标(GUI 应用等) → false,零假阳性
  assert.equal(tlc.isInteractiveTerminalApp('code', {}), false);
  assert.equal(tlc.isInteractiveTerminalApp('explorer.exe', {}), false);
  assert.equal(tlc.isInteractiveTerminalApp('notepad', {}), false);
  // 坏输入不抛
  assert.equal(tlc.isInteractiveTerminalApp('', {}), false);
  assert.equal(tlc.isInteractiveTerminalApp(null, {}), false);
});

test('buildTerminalLaunchArgv:win32 → cmd /c start "" cmd /k <target> <args>', () => {
  const built = tlc.buildTerminalLaunchArgv({
    target: 'opencode', args: ['--flag', 'x'], platform: 'win32', env: {},
  });
  assert.ok(built && built.command);
  assert.equal(built.command, 'cmd.exe');
  assert.deepEqual(built.args, ['/d', '/s', '/c', 'start', '', 'cmd', '/k', 'opencode', '--flag', 'x']);
  assert.equal(built.windowsHide, true);
});

test('buildTerminalLaunchArgv:win32 尊重 COMSPEC 覆盖', () => {
  const built = tlc.buildTerminalLaunchArgv({
    target: 'opencode', platform: 'win32', env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
  });
  assert.equal(built.command, 'C:\\Windows\\System32\\cmd.exe');
});

test('buildTerminalLaunchArgv:darwin → osascript Terminal do script + activate', () => {
  const built = tlc.buildTerminalLaunchArgv({
    target: 'opencode', args: ['--flag'], platform: 'darwin', env: {},
  });
  assert.equal(built.command, 'osascript');
  assert.equal(built.args[0], '-e');
  assert.match(built.args[1], /tell application "Terminal" to do script/);
  assert.match(built.args[1], /opencode/);
  assert.equal(built.args[2], '-e');
  assert.match(built.args[3], /activate/);
});

test('buildTerminalLaunchArgv:linux → x-terminal-emulator -e <target> <args>', () => {
  const built = tlc.buildTerminalLaunchArgv({
    target: 'opencode', args: ['--flag', 'y'], platform: 'linux', env: {},
  });
  assert.equal(built.command, 'x-terminal-emulator');
  assert.deepEqual(built.args, ['-e', 'opencode', '--flag', 'y']);
});

test('buildTerminalLaunchArgv:空/坏 target 返 null;绝不抛', () => {
  assert.equal(tlc.buildTerminalLaunchArgv({ target: '', platform: 'linux' }), null);
  assert.equal(tlc.buildTerminalLaunchArgv({ target: '   ', platform: 'linux' }), null);
  assert.equal(tlc.buildTerminalLaunchArgv({ platform: 'linux' }), null);
  assert.equal(tlc.buildTerminalLaunchArgv(null), null);
  assert.equal(tlc.buildTerminalLaunchArgv(undefined), null);
});

test('INTERACTIVE_TERMINAL_APPS 冻结(纯叶子不可变)', () => {
  assert.ok(Object.isFrozen(tlc.INTERACTIVE_TERMINAL_APPS));
  assert.ok(tlc.INTERACTIVE_TERMINAL_APPS.includes('opencode'));
  assert.throws(() => { tlc.INTERACTIVE_TERMINAL_APPS.push('evil'); });
});
