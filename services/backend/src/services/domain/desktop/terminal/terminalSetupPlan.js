'use strict';

/**
 * terminalSetupPlan.js — 终端 Shift+Enter 配置「检测→分类→方案」的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;只读入参,绝不读 process.env、绝不触文件。
 * 仅依赖纯 `path`(leaf-contract 明示放行)做路径拼接,homedir/platform/env 全部由调用方注入。
 *
 * 背后的逻辑(对齐 Claude Code terminalSetup):khy 的 Ink TUI 已能在 Shift/Meta/Ctrl+Enter 时
 * 插入换行(useTextInput.js),但这依赖**终端本身**把 Shift+Enter 作为一个**可区分的转义序列**
 * 投递给 khy。多数终端默认不投递,需要在终端/编辑器配置里装一条「Shift+Enter → 发送 ESC+CR」的
 * 键绑定。CC 的 terminalSetup 把这件事自动化;其真正有价值的「背后逻辑」是一张分类表:
 *   ① 原生支持 CSI u / Kitty 键盘协议终端(Ghostty/Kitty/iTerm2/WezTerm/Warp)——**终端侧**能送出
 *      可区分的 Shift+Enter,但 **khy 侧尚未向终端申请该协议**(ink 的 kittyKeyboard 是 opt-in,
 *      `render()` 未传,见 BUG-35 实测),所以这一档今天同样需要 ② 的绑定才能换行;真接通协议后
 *      它们才是「零配置」;
 *   ② 已知需配置的终端(Apple Terminal / VSCode·Cursor·Windsurf / Alacritty / Zed / Windows Terminal)—— 各有其
 *      配置文件位置与要写入的绑定片段;
 *   ③ 其余未知终端 —— 给出通用引导。
 * 本叶子就是这张表 + 路径推导 + 片段生成。**khy 刻意只产出「方案」(路径 + 片段 + 步骤),由薄壳
 * 打印引导,而不静默改写用户的编辑器配置**(无 JSONC 解析器、plist 为二进制,自动改写风险高、
 * 易破坏用户主配置)—— 这是诚实边界,与 CC 自动写入的取舍不同。
 *
 * 注意:表中的终端配置文件路径(~/.config/Code/User/keybindings.json 等)是**外部编辑器的既有约定
 * 位置**(与 CC 同),属参考数据,不是 khy 自身的 host/port/path 基础设施硬编码。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。
 */

const path = require('path');

// 终端侧支持 CSI u / Kitty 键盘协议的终端。注意:协议须由**应用**申请(ink:
// `render({ kittyKeyboard })`,默认不申请),khy 当前未开启,故本档只表示「终端有能力」
// 而非「khy 已能解析」—— 见 planTerminalSetup 的 native 分支 reason 与 BUG-35。
// 键为 detectTerminal().name 归一(小写)后的取值;值为展示名。
const NATIVE_CSIU_TERMINALS = Object.freeze({
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iterm.app': 'iTerm2',
  wezterm: 'WezTerm',
  warpterminal: 'Warp',
});

// 要写入各编辑器/终端的「Shift+Enter → ESC+CR」绑定片段(参考数据,与 CC 一致)。
const _ESC_CR = '\\u001b\\r'; // 写进配置文件里的字面转义(ESC + Carriage Return)。

const _VSCODE_SNIPPET = `[
  {
    "key": "shift+enter",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "${_ESC_CR}" },
    "when": "terminalFocus"
  }
]`;

const _ALACRITTY_SNIPPET = `[[keyboard.bindings]]
key = "Return"
mods = "Shift"
chars = "${_ESC_CR}"`;

const _ZED_SNIPPET = `[
  {
    "context": "Terminal",
    "bindings": { "shift-enter": ["terminal::SendText", "${_ESC_CR}"] }
  }
]`;

// Windows Terminal(settings.json)。sendInput 自 WT 1.11 起要求 action 对象写法。
const _WINDOWS_TERMINAL_SNIPPET = `{
  "keybindings": [
    { "command": { "action": "sendInput", "input": "${_ESC_CR}" }, "keys": "shift+enter" }
  ]
}`;

// 收敛到 utils/isOffValue 单一真源(逐字节委托,调用点不变)
const _falsy = require('../../../../utils/isOffValue');

/** VSCode 家族(VSCode/Cursor/Windsurf)的 keybindings.json 路径(按平台推导)。 */
function _vscodeKeybindingsPath(homedir, platformId, editorDir) {
  let userDir;
  if (platformId === 'win32') {
    userDir = path.join(homedir, 'AppData', 'Roaming', editorDir, 'User');
  } else if (platformId === 'darwin') {
    userDir = path.join(homedir, 'Library', 'Application Support', editorDir, 'User');
  } else {
    userDir = path.join(homedir, '.config', editorDir, 'User');
  }
  return path.join(userDir, 'keybindings.json');
}

/** Alacritty 配置路径(XDG_CONFIG_HOME 优先,否则 ~/.config / %APPDATA%)。 */
function _alacrittyConfigPath(homedir, platformId, env) {
  const xdg = env && env.XDG_CONFIG_HOME;
  if (xdg && String(xdg).trim()) {
    return path.join(String(xdg).trim(), 'alacritty', 'alacritty.toml');
  }
  if (platformId === 'win32') {
    const appData = env && env.APPDATA;
    if (appData && String(appData).trim()) {
      return path.join(String(appData).trim(), 'alacritty', 'alacritty.toml');
    }
  }
  return path.join(homedir, '.config', 'alacritty', 'alacritty.toml');
}

/**
 * Windows Terminal 的 settings.json 路径。两种安装方式路径不同,以微软商店版为默认
 * (装机量最大),免商店版(%LOCALAPPDATA%\Microsoft\Windows Terminal)在步骤里并列给出。
 * LOCALAPPDATA 缺失(非 win32 / 精简环境)→ null,薄壳只给片段不给路径。
 */
function _windowsTerminalConfigPath(env) {
  const base = env && env.LOCALAPPDATA;
  if (!(base && String(base).trim())) return null;
  return path.join(
    String(base).trim(),
    'Packages',
    'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
    'LocalState',
    'settings.json'
  );
}

/**
 * 是否疑似 VSCode Remote SSH 会话(此时键绑定须装在**本地**机器,而非远端)。
 * 与 CC isVSCodeRemoteSSH 同判据,只读注入的 env。
 */
function isVSCodeRemoteSSH(env = {}) {
  const askpass = String((env && env.VSCODE_GIT_ASKPASS_MAIN) || '');
  const pathEnv = String((env && env.PATH) || '');
  const needles = ['.vscode-server', '.cursor-server', '.windsurf-server'];
  return needles.some((n) => askpass.includes(n) || pathEnv.includes(n));
}

/**
 * 根据终端名 + 平台 + 注入环境,产出 Shift+Enter 配置方案。纯函数,绝不抛。
 *
 * @param {object} input
 *   @param {string} input.name        detectTerminal().name(已小写),如 'vscode'|'iterm.app'|'apple_terminal'|'alacritty'|'zed'
 *   @param {string} input.platform    process.platform,如 'darwin'|'linux'|'win32'
 *   @param {string} input.homedir     os.homedir()(由调用方注入,叶子不做 IO)
 *   @param {object} [input.env]       注入的环境对象(只读;用于 XDG/APPDATA/Remote-SSH 判定)
 * @returns {{
 *   terminal:string, displayName:string, category:'native'|'needs-setup'|'unknown',
 *   needsSetup:boolean, reason:string, method:string|null, configPath:string|null,
 *   snippet:string|null, steps:string[], remoteSSH:boolean
 * }}
 */
function planTerminalSetup(input = {}) {
  const name = String(input.name == null ? '' : input.name)
    .trim()
    .toLowerCase();
  const platformId = String(input.platform || '');
  const homedir = String(input.homedir || '');
  const env = input.env && typeof input.env === 'object' ? input.env : {};

  const base = {
    terminal: name || 'unknown',
    displayName: '',
    category: 'unknown',
    needsSetup: false,
    reason: '',
    method: null,
    configPath: null,
    snippet: null,
    steps: [],
    remoteSSH: isVSCodeRemoteSSH(env),
  };

  // ① 原生 CSI u / Kitty 协议终端 —— 无需配置。
  if (Object.prototype.hasOwnProperty.call(NATIVE_CSIU_TERMINALS, name)) {
    return Object.assign(base, {
      displayName: NATIVE_CSIU_TERMINALS[name],
      category: 'native',
      needsSetup: false,
      reason: '该终端支持 CSI u / Kitty 键盘协议;但键盘协议要由应用向终端申请,khy 目前未申请(ink 的 kittyKeyboard 为 opt-in),故 Shift+Enter 今天仍与 Enter 送出同一字节。现在可用的换行键:Ctrl + J(送裸 LF),或在终端里自配一条「Shift+Enter 发送 ESC+CR」绑定。',
    });
  }

  // ② 已知需配置的终端。
  // VSCode / Cursor / Windsurf(detectTerminal 对三者多返回 'vscode';env 可细分)。
  const editorByName = { vscode: 'VSCode', cursor: 'Cursor', windsurf: 'Windsurf' };
  if (Object.prototype.hasOwnProperty.call(editorByName, name)) {
    const display = editorByName[name];
    const editorDir = display === 'VSCode' ? 'Code' : display;
    return Object.assign(base, {
      displayName: display,
      category: 'needs-setup',
      needsSetup: true,
      method: 'vscode-keybindings',
      reason: `${display} 集成终端默认不投递可区分的 Shift+Enter 序列,需在 keybindings.json 添加一条绑定。`,
      configPath: homedir ? _vscodeKeybindingsPath(homedir, platformId, editorDir) : null,
      snippet: _VSCODE_SNIPPET,
      steps: base.remoteSSH
        ? [
            `检测到疑似 ${display} Remote SSH 会话:键绑定必须装在**本地**机器,而非远端服务器。`,
            `在本地 ${display} 打开命令面板(Cmd/Ctrl+Shift+P)→ "Preferences: Open Keyboard Shortcuts (JSON)"。`,
            '把下面的绑定加入该 JSON 数组(文件须是合法 JSON 数组):',
          ]
        : [
            `打开 ${display} 命令面板(Cmd/Ctrl+Shift+P)→ "Preferences: Open Keyboard Shortcuts (JSON)"。`,
            '把下面的绑定加入该 JSON 数组(若已存在 shift+enter→sendSequence 绑定则跳过):',
            '保存后重启集成终端即可在 khy 输入框用 Shift+Enter 换行。',
          ],
    });
  }

  if (name === 'apple_terminal') {
    return Object.assign(base, {
      displayName: 'Apple Terminal',
      category: 'needs-setup',
      needsSetup: true,
      method: 'apple-terminal',
      reason:
        'macOS Terminal.app 需启用「Use Option as Meta key」,Shift/Option+Enter 方能作为换行投递。',
      configPath: null, // 经偏好设置开启,非文本配置文件。
      snippet: null,
      steps: [
        'Terminal → 设置(Preferences)→ Profiles → Keyboard。',
        '勾选「Use Option as Meta key」。',
        '随后在 khy 输入框用 Option+Enter 换行(Shift+Enter 在部分配置下亦可)。',
      ],
    });
  }

  if (name === 'alacritty') {
    return Object.assign(base, {
      displayName: 'Alacritty',
      category: 'needs-setup',
      needsSetup: true,
      method: 'alacritty-config',
      reason: 'Alacritty 需在 alacritty.toml 添加一条 Shift+Return 键绑定以发送 ESC+CR。',
      configPath: homedir ? _alacrittyConfigPath(homedir, platformId, env) : null,
      snippet: _ALACRITTY_SNIPPET,
      steps: [
        '编辑 Alacritty 配置文件(下方路径,不存在则新建)。',
        '把下面的 [[keyboard.bindings]] 片段追加进去(若已有 Shift+Return 绑定则跳过)。',
        '保存后重启 Alacritty 即可用 Shift+Enter 换行。',
      ],
    });
  }

  if (name === 'zed') {
    return Object.assign(base, {
      displayName: 'Zed',
      category: 'needs-setup',
      needsSetup: true,
      method: 'zed-keymap',
      reason: 'Zed 需在 keymap.json 为 Terminal 上下文添加一条 shift-enter → SendText 绑定。',
      configPath: homedir ? path.join(homedir, '.config', 'zed', 'keymap.json') : null,
      snippet: _ZED_SNIPPET,
      steps: [
        '打开 Zed keymap.json(下方路径,不存在则新建为 JSON 数组)。',
        '把下面的对象加入该数组(若已含 shift-enter 绑定则跳过)。',
        '保存后即可在 khy 终端用 Shift+Enter 换行。',
      ],
    });
  }

  // Windows Terminal(detectTerminal 给 'windows-terminal';TERM_PROGRAM 在时给 'windows terminal')。
  // 实测(BUG-35, WT 1.24):Shift+Enter 与 Enter 同送 `\r`,Ctrl+Enter 被终端自用为全屏、
  // 零字节送达 —— 不装这条绑定,本机可直接用的换行键只有 Ctrl + J(送裸 LF)。
  if (name === 'windows-terminal' || name === 'windows terminal') {
    return Object.assign(base, {
      displayName: 'Windows Terminal',
      category: 'needs-setup',
      needsSetup: true,
      method: 'windows-terminal-keybindings',
      reason:
        'Windows Terminal 默认把 Shift+Enter 送成与 Enter 无异的 `\\r`,需在 settings.json 加一条 sendInput 绑定;不配置时用 Ctrl + J 换行(实测可用)。Alt + Enter 在本终端被自用为全屏切换,只送回一个孤立 ESC,不能当换行键。',
      configPath: _windowsTerminalConfigPath(env),
      snippet: _WINDOWS_TERMINAL_SNIPPET,
      steps: [
        '按 Ctrl+, (逗号) 打开 Windows Terminal 设置 → 右上角「打开 JSON 文件」。',
        '免商店版的路径也可能是 %LOCALAPPDATA%\\Microsoft\\Windows Terminal\\settings.json。',
        '把下面片段并入该 JSON 的顶层(与 "profiles" 同级;若已有 keybindings 数组,把对象追加进去即可)。',
        '保存后新开一个标签页生效 —— 此后 Shift+Enter 会向 khy 投递 ESC+CR,即插入换行。',
      ],
    });
  }

  // ③ 未知终端 —— 通用引导。
  return Object.assign(base, {
    displayName: name || '未知终端',
    category: 'unknown',
    needsSetup: false,
    reason:
      '未识别该终端是否需要 Shift+Enter 配置。多数终端默认把 Shift+Enter 送成与 Enter 同一条字节(实测:Windows Terminal 1.24 即如此),不要假定原生可用。可先试 Ctrl + J(送裸 LF,khy 直接插换行),或查阅终端文档配置「Shift+Enter 发送 ESC+CR(\\u001b\\r)」。',
  });
}

/** 门控读取(KHY_TERMINAL_SETUP 默认开;关 → 命令不接管)。注入 env,叶子不读 process.env。 */
function isEnabled(env = {}) {
  return !_falsy(
    env && env.KHY_TERMINAL_SETUP === undefined ? 'true' : env && env.KHY_TERMINAL_SETUP
  );
}

module.exports = {
  planTerminalSetup,
  isVSCodeRemoteSSH,
  isEnabled,
  NATIVE_CSIU_TERMINALS,
};
