'use strict';
/**
 * terminalLaunchCommand.test.js �?「在新终端窗口里启动交互�?agent」的每平�?argv
 * 构造纯叶子契约(node:test)�? *
 * 覆盖:门控 isEnabled(默认开 / 显式 falsy 含大小写空白 / 注册表委�?�? * _basenameNoExt(去引�?去扩�?小写 / 坏输入返 '')、isInteractiveTerminalApp
 * (白名单命�?/ 带路径与扩展命中 / 门关�?false / 未知目标 false / 坏输�?false)�? * buildTerminalLaunchArgv(win/darwin/linux argv 形状 + 参数透传 + COMSPEC 覆盖 +
 * �?target �?null + 坏输入不抛返 null)、INTERACTIVE_TERMINAL_APPS 冻结�? * �?IO、确定性——每断言显式�?env/platform,不依赖进程环境�? */
const tlc = require('../terminalLaunchCommand');
test('buildTerminalLaunchArgv:win32 �?cmd /c start "" cmd /k <target> <args>', () => {
  const built = tlc.buildTerminalLaunchArgv({
    target: 'opencode',
    args: ['--flag', 'x'],
    platform: 'win32',
    env: {},
  });
  expect(built && built.command).toBeTruthy();
  expect(built.command).toBe('cmd.exe');
  assert.deepEqual(built.args, [
    '/d',
    '/s',
    '/c',
    'start',
    '',
    'cmd',
    '/k',
    'opencode',
    '--flag',
    'x',
  ]);
  expect(built.windowsHide).toBe(true);
});

describe('Terminal Launch Command', () => {
  test('isEnabled:默认开;显式 falsy(含大小写/空白)�?, () => {
      expect(tlc.isEnabled({})).toBe(true);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: '1' })).toBe(true);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'on' })).toBe(true);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: '0' })).toBe(false);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'false' })).toBe(false);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: ' OFF ' })).toBe(false);
      expect(tlc.isEnabled({ KHY_TERMINAL_LAUNCH: 'No' })).toBe(false);
  });

  test('_basenameNoExt:去引号、去扩展、小�?坏输入返�?, () => {
      expect(tlc._basenameNoExt('opencode')).toBe('opencode');
      expect(tlc._basenameNoExt('OpenCode.CMD')).toBe('opencode');
      expect(tlc._basenameNoExt('"C:\\tools\\claude.exe"')).toBe('claude');
      expect(tlc._basenameNoExt('/usr/local/bin/codex')).toBe('codex');
      expect(tlc._basenameNoExt('opencode.ps1')).toBe('opencode');
      expect(tlc._basenameNoExt('')).toBe('');
      expect(tlc._basenameNoExt(null)).toBe('');
      expect(tlc._basenameNoExt(undefined)).toBe('');
  });

  test('isInteractiveTerminalApp:白名单命�?含路�?扩展);门关/未知/坏输�?false', () => {
      expect(tlc.isInteractiveTerminalApp('opencode', {})).toBe(true);
      expect(tlc.isInteractiveTerminalApp('/usr/local/bin/opencode', {})).toBe(true);
      expect(tlc.isInteractiveTerminalApp('opencode.cmd', {})).toBe(true);
      expect(tlc.isInteractiveTerminalApp('claude', {})).toBe(true);
      expect(tlc.isInteractiveTerminalApp('codex', {})).toBe(true);
      // 门关 �?�?false(调用方逐字节回退历史启动)
      expect(tlc.isInteractiveTerminalApp('opencode', { KHY_TERMINAL_LAUNCH: '0' })).toBe(false);
      // 未知目标(GUI 应用�? �?false,零假阳�?      expect(tlc.isInteractiveTerminalApp('code', {})).toBe(false);
      expect(tlc.isInteractiveTerminalApp('explorer.exe', {})).toBe(false);
      expect(tlc.isInteractiveTerminalApp('notepad', {})).toBe(false);
      // 坏输入不�?      expect(tlc.isInteractiveTerminalApp('', {})).toBe(false);
      expect(tlc.isInteractiveTerminalApp(null, {})).toBe(false);
  });

  test('buildTerminalLaunchArgv:win32 尊重 COMSPEC 覆盖', () => {
      const built = tlc.buildTerminalLaunchArgv({
        target: 'opencode',
        platform: 'win32',
        env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      });
      expect(built.command).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  test('buildTerminalLaunchArgv:darwin �?osascript Terminal do script + activate', () => {
      const built = tlc.buildTerminalLaunchArgv({
        target: 'opencode',
        args: ['--flag'],
        platform: 'darwin',
        env: {},
      });
      expect(built.command).toBe('osascript');
      expect(built.args[0]).toBe('-e');
      expect(built.args[1]).toMatch(/tell application "Terminal" to do script/);
      expect(built.args[1]).toMatch(/opencode/);
      expect(built.args[2]).toBe('-e');
      expect(built.args[3]).toMatch(/activate/);
  });

  test('buildTerminalLaunchArgv:linux �?x-terminal-emulator -e <target> <args>', () => {
      const built = tlc.buildTerminalLaunchArgv({
        target: 'opencode',
        args: ['--flag', 'y'],
        platform: 'linux',
        env: {},
      });
      expect(built.command).toBe('x-terminal-emulator');
      assert.deepEqual(built.args, ['-e', 'opencode', '--flag', 'y']);
  });

  test('buildTerminalLaunchArgv:�?�?target �?null;绝不�?, () => {
      expect(tlc.buildTerminalLaunchArgv({ target: '', platform: 'linux' })).toBe(null);
      expect(tlc.buildTerminalLaunchArgv({ target: '   ', platform: 'linux' })).toBe(null);
      expect(tlc.buildTerminalLaunchArgv({ platform: 'linux' })).toBe(null);
      expect(tlc.buildTerminalLaunchArgv(null)).toBe(null);
      expect(tlc.buildTerminalLaunchArgv(undefined)).toBe(null);
  });

  test('INTERACTIVE_TERMINAL_APPS 冻结(纯叶子不可变)', () => {
      expect(Object.isFrozen(tlc.INTERACTIVE_TERMINAL_APPS).toBeTruthy());
      expect(tlc.INTERACTIVE_TERMINAL_APPS).toContain('opencode');
      assert.throws(() => {
        tlc.INTERACTIVE_TERMINAL_APPS.push('evil');
      });
  });

});

