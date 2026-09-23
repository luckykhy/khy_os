'use strict';

/**
 * terminalSetupPlan.test.js — 纯叶子终端 Shift+Enter 配置方案器契约(node:test,零 IO)。
 *
 * 锁定:native(Ghostty/Kitty/iTerm2/WezTerm/Warp)→终端有能力但 khy 未申请协议(文案须点名
 * Ctrl + J);Windows Terminal→settings.json sendInput;VSCode 家族→keybindings.json
 * 路径按平台推导 + 片段;Apple Terminal→偏好设置步骤(无 configPath/snippet);Alacritty→
 * XDG/.config 路径 + toml 片段;Zed→keymap.json 路径;unknown→通用引导;Remote SSH 判定;
 * 门控 isEnabled;防呆(空名/空 homedir)。叶子绝不读 process.env(env 注入)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { planTerminalSetup, isVSCodeRemoteSSH, isEnabled, NATIVE_CSIU_TERMINALS } =
  require('../../../src/services/domain/desktop/terminal/terminalSetupPlan.js');

const HOME = '/home/u';

describe('native CSI u 终端 → 终端有能力,但 khy 未申请协议', () => {
  for (const name of Object.keys(NATIVE_CSIU_TERMINALS)) {
    test(`${name} → category=native, needsSetup=false`, () => {
      const r = planTerminalSetup({ name, platform: 'linux', homedir: HOME, env: {} });
      assert.equal(r.category, 'native');
      assert.equal(r.needsSetup, false);
      assert.equal(r.displayName, NATIVE_CSIU_TERMINALS[name]);
      assert.equal(r.configPath, null);
    });
  }
  test('大小写不敏感(iTerm.app → iterm.app)', () => {
    const r = planTerminalSetup({ name: 'iTerm.app', platform: 'darwin', homedir: HOME });
    assert.equal(r.category, 'native');
    assert.equal(r.displayName, 'iTerm2');
  });
});

describe('VSCode 家族 → keybindings.json', () => {
  test('vscode linux 路径 = ~/.config/Code/User/keybindings.json + 片段', () => {
    const r = planTerminalSetup({ name: 'vscode', platform: 'linux', homedir: HOME, env: {} });
    assert.equal(r.category, 'needs-setup');
    assert.equal(r.needsSetup, true);
    assert.equal(r.method, 'vscode-keybindings');
    assert.equal(r.configPath, path.join(HOME, '.config', 'Code', 'User', 'keybindings.json'));
    assert.match(r.snippet, /workbench\.action\.terminal\.sendSequence/);
    assert.match(r.snippet, /shift\+enter/);
  });
  test('darwin 路径 = ~/Library/Application Support/Code/User', () => {
    const r = planTerminalSetup({ name: 'vscode', platform: 'darwin', homedir: HOME });
    assert.equal(r.configPath, path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json'));
  });
  test('win32 路径 = AppData/Roaming/Code/User', () => {
    const r = planTerminalSetup({ name: 'vscode', platform: 'win32', homedir: HOME });
    assert.equal(r.configPath, path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'keybindings.json'));
  });
  test('cursor/windsurf 用各自目录名', () => {
    const c = planTerminalSetup({ name: 'cursor', platform: 'linux', homedir: HOME });
    assert.equal(c.displayName, 'Cursor');
    assert.equal(c.configPath, path.join(HOME, '.config', 'Cursor', 'User', 'keybindings.json'));
    const w = planTerminalSetup({ name: 'windsurf', platform: 'linux', homedir: HOME });
    assert.equal(w.displayName, 'Windsurf');
    assert.equal(w.configPath, path.join(HOME, '.config', 'Windsurf', 'User', 'keybindings.json'));
  });
  test('Remote SSH → 步骤切换为「装本地机器」', () => {
    const r = planTerminalSetup({ name: 'vscode', platform: 'linux', homedir: HOME, env: { PATH: '/x/.vscode-server/bin' } });
    assert.equal(r.remoteSSH, true);
    assert.ok(r.steps.some((s) => /本地/.test(s)));
  });
});

describe('Apple Terminal → 偏好设置', () => {
  test('needs-setup 但无 configPath/snippet,步骤含 Option as Meta', () => {
    const r = planTerminalSetup({ name: 'apple_terminal', platform: 'darwin', homedir: HOME });
    assert.equal(r.category, 'needs-setup');
    assert.equal(r.method, 'apple-terminal');
    assert.equal(r.configPath, null);
    assert.equal(r.snippet, null);
    assert.ok(r.steps.some((s) => /Option as Meta/.test(s)));
  });
});

describe('Alacritty → toml', () => {
  test('XDG_CONFIG_HOME 优先', () => {
    const r = planTerminalSetup({ name: 'alacritty', platform: 'linux', homedir: HOME, env: { XDG_CONFIG_HOME: '/xdg' } });
    assert.equal(r.configPath, path.join('/xdg', 'alacritty', 'alacritty.toml'));
    assert.match(r.snippet, /keyboard\.bindings/);
    assert.match(r.snippet, /mods = "Shift"/);
  });
  test('无 XDG → ~/.config/alacritty/alacritty.toml', () => {
    const r = planTerminalSetup({ name: 'alacritty', platform: 'linux', homedir: HOME, env: {} });
    assert.equal(r.configPath, path.join(HOME, '.config', 'alacritty', 'alacritty.toml'));
  });
  test('win32 用 APPDATA', () => {
    const r = planTerminalSetup({ name: 'alacritty', platform: 'win32', homedir: HOME, env: { APPDATA: 'C:\\App' } });
    assert.equal(r.configPath, path.join('C:\\App', 'alacritty', 'alacritty.toml'));
  });
});

describe('Zed → keymap.json', () => {
  test('~/.config/zed/keymap.json + Terminal 上下文片段', () => {
    const r = planTerminalSetup({ name: 'zed', platform: 'linux', homedir: HOME });
    assert.equal(r.method, 'zed-keymap');
    assert.equal(r.configPath, path.join(HOME, '.config', 'zed', 'keymap.json'));
    assert.match(r.snippet, /"context": "Terminal"/);
    assert.match(r.snippet, /shift-enter/);
  });
});

describe('Windows Terminal → settings.json sendInput(BUG-35 新增分支)', () => {
  const envWith = (localAppData) => ({ LOCALAPPDATA: localAppData });
  test('WT_SESSION 检出的名字走 needs-setup,不再谎称原生可用', () => {
    const r = planTerminalSetup({
      name: 'windows-terminal', platform: 'win32', homedir: 'C:/Users/u',
      env: envWith('C:/Users/u/AppData/Local'),
    });
    assert.equal(r.category, 'needs-setup');
    assert.equal(r.needsSetup, true);
    assert.equal(r.method, 'windows-terminal-keybindings');
    assert.match(r.snippet, /"action": "sendInput"/);
    assert.match(r.snippet, /shift\+enter/);
    assert.match(r.configPath, /Microsoft\.WindowsTerminal_[^/\\]+[/\\]LocalState[/\\]settings\.json$/);
  });
  test('带空格别名 "windows terminal" 同样命中', () => {
    const r = planTerminalSetup({ name: 'windows terminal', platform: 'win32', homedir: 'H', env: {} });
    assert.equal(r.method, 'windows-terminal-keybindings');
    // 无 LOCALAPPDATA → 路径不可知,但方案仍在(configPath 允许 null)
    assert.equal(r.configPath, null);
  });
  test('缺 LOCALAPPDATA 不抛', () => {
    assert.doesNotThrow(() => planTerminalSetup({ name: 'windows-terminal', platform: 'win32', homedir: 'H' }));
  });
  test('reason 不得宣称 Alt+Enter 可用(实测 WT 自用为全屏)', () => {
    const r = planTerminalSetup({ name: 'windows-terminal', platform: 'win32', homedir: 'H', env: {} });
    assert.match(r.reason, /Ctrl \+ J/);
    assert.match(r.reason, /Alt \+ Enter.*不可|不能当换行键/s);
  });
});

describe('文案真源:不得宣传终端送不出的键(BUG-35)', () => {
  test('native reason 承认 khy 未申请键盘协议,并点名 Ctrl + J', () => {
    const r = planTerminalSetup({ name: 'ghostty', platform: 'linux', homedir: HOME, env: {} });
    assert.equal(r.category, 'native');
    assert.match(r.reason, /Ctrl \+ J/);
    assert.doesNotMatch(r.reason, /Alt \+ Enter/);
    assert.match(r.reason, /未申请|opt-in/);
  });
  test('unknown reason 不再说「多数现代终端原生支持」', () => {
    const r = planTerminalSetup({ name: 'weird-term', platform: 'linux', homedir: HOME, env: {} });
    assert.doesNotMatch(r.reason, /原生支持/);
    assert.match(r.reason, /Ctrl \+ J/);
  });
});

describe('unknown 终端 → 通用引导', () => {
  test('未知名 → category=unknown, needsSetup=false', () => {
    const r = planTerminalSetup({ name: 'some-random-term', platform: 'linux', homedir: HOME });
    assert.equal(r.category, 'unknown');
    assert.equal(r.needsSetup, false);
    assert.match(r.reason, /未识别/);
  });
  test('空名 → unknown 不抛', () => {
    assert.doesNotThrow(() => planTerminalSetup({}));
    const r = planTerminalSetup({});
    assert.equal(r.category, 'unknown');
  });
});

describe('isVSCodeRemoteSSH', () => {
  test('VSCODE_GIT_ASKPASS_MAIN 含 .vscode-server → true', () => {
    assert.equal(isVSCodeRemoteSSH({ VSCODE_GIT_ASKPASS_MAIN: '/x/.vscode-server/y' }), true);
  });
  test('cursor-server / windsurf-server 亦命中', () => {
    assert.equal(isVSCodeRemoteSSH({ PATH: '/a/.cursor-server/b' }), true);
    assert.equal(isVSCodeRemoteSSH({ PATH: '/a/.windsurf-server/b' }), true);
  });
  test('普通本地环境 → false', () => {
    assert.equal(isVSCodeRemoteSSH({ PATH: '/usr/bin' }), false);
    assert.equal(isVSCodeRemoteSSH({}), false);
  });
});

describe('门控 isEnabled', () => {
  test('默认(未设)→ 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_TERMINAL_SETUP: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_TERMINAL_SETUP: v }), false);
    }
  });
});
