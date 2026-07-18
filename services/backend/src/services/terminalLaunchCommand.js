'use strict';

/**
 * terminalLaunchCommand — 把「在一个新终端窗口里启动某个交互式 CLI/TUI 程序」的
 * 每平台命令构造成 argv(纯叶子)。
 *
 * 根因(修复目标):`toolCalling._spawnDetached` 面向 GUI 应用设计——以
 * `stdio:'ignore'` + `windowsHide:true` + `detached:true` 启动。对 opencode /
 * claude / codex 这类**交互式终端 agent**,这等于把它扔进一个没有控制台、被隐藏的
 * 进程里:它无处渲染 TUI、也读不到 stdin → 「让 khy 启动 opencode 却不新开一个终端」。
 *
 * 修法:识别已知交互式终端 agent(保守白名单,零假阳性),为它们构造一条「开一个**新
 * 终端窗口**并在其中运行目标」的命令:
 *   - win32 : `cmd /c start "" cmd /k <target> <args>`(start 开新控制台窗口,cmd /k 运行后保留窗口)
 *   - darwin: `osascript -e 'tell application "Terminal" to do script "<cmd>"'`(+ activate)
 *   - linux : `x-terminal-emulator -e <target> <args>`(Debian alternatives 指向系统默认终端)
 * 纯叶子只**构造 argv**,不 spawn;实际启动与 fail-soft 回退由调用方(_spawnDetached)负责。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛;门控关 / 坏输入 → 使 isInteractiveTerminalApp
 * 恒 false,调用方逐字节回退历史分离启动。
 *
 * 门控 KHY_TERMINAL_LAUNCH 默认开。关 → 不改道任何启动,_spawnDetached 行为逐字节不变。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控解析:优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' && process.env) || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_TERMINAL_LAUNCH', e);
    }
  } catch { /* registry unavailable → local fallback */ }
  const v = e.KHY_TERMINAL_LAUNCH;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 已知交互式终端(TUI)agent:必须在真实终端窗口里跑,分离/隐藏启动无控制台。
 * 保守白名单(零假阳性):只收明确是交互式 CLI 编码 agent 的基名,绝不误伤 GUI 应用。
 */
const INTERACTIVE_TERMINAL_APPS = Object.freeze([
  'opencode', 'claude', 'codex', 'aider', 'gemini', 'crush', 'goose',
  'cursor-agent', 'qwen', 'amp', 'kiro', 'trae',
]);
const _INTERACTIVE_SET = Object.freeze(new Set(INTERACTIVE_TERMINAL_APPS));

/**
 * 取目标的可执行基名(去引号、去 .cmd/.bat/.exe/.ps1/.sh 扩展、小写)。
 * @param {string} target
 * @returns {string}
 */
function _basenameNoExt(target) {
  try {
    const raw = String(target == null ? '' : target).trim().replace(/^"+|"+$/g, '');
    if (!raw) return '';
    // Split on BOTH separators so a Windows-style target (C:\...\opencode.cmd)
    // resolves identically on a POSIX host (path.basename would be host-dependent).
    const seg = raw.split(/[\\/]/).pop() || '';
    return seg.replace(/\.(cmd|bat|exe|ps1|sh)$/i, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 目标是否是已知的交互式终端 agent(且门控开)。门控关 / 未知目标 → false,
 * 调用方据此逐字节回退历史启动。
 * @param {string} target 命令名或可执行路径
 * @param {object} [env]
 * @returns {boolean}
 */
function isInteractiveTerminalApp(target, env) {
  if (!isEnabled(env)) return false;
  const name = _basenameNoExt(target);
  return !!name && _INTERACTIVE_SET.has(name);
}

/** AppleScript 双引号字符串转义(仅转义 \\ 与 ")。 */
function _appleScriptQuote(s) {
  return `"${String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** POSIX 单引号 shell 量化(用于 osascript do script 内的一条命令行)。 */
function _shQuote(token) {
  const s = String(token == null ? '' : token);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 构造「在新终端窗口里运行 target + args」的 spawn argv。
 * 纯构造,不 spawn。坏输入 / 未知平台 → null(调用方回退历史启动)。
 *
 * @param {object} opts
 * @param {string} opts.target   目标可执行(路径或命令名)
 * @param {string[]} [opts.args] 传给目标的参数
 * @param {string} [opts.platform] process.platform(便于测试注入)
 * @param {object} [opts.env]
 * @returns {{command:string, args:string[], windowsHide?:boolean}|null}
 */
function buildTerminalLaunchArgv(opts) {
  try {
    const o = opts || {};
    const target = String(o.target == null ? '' : o.target).trim().replace(/^"+|"+$/g, '');
    if (!target) return null;
    const args = Array.isArray(o.args) ? o.args.map((a) => String(a)) : [];
    const platform = o.platform || (typeof process !== 'undefined' && process.platform) || '';
    const env = o.env || (typeof process !== 'undefined' && process.env) || {};

    if (platform === 'win32') {
      // cmd /c start "" cmd /k <target> <args>
      //   start ""  → 开一个新的控制台窗口(第一个 "" 是窗口标题占位)
      //   cmd /k    → 在新窗口里运行目标,目标退出后仍保留窗口(便于看输出/继续交互)
      const comspec = (env && env.COMSPEC) || 'cmd.exe';
      return {
        command: comspec,
        args: ['/d', '/s', '/c', 'start', '', 'cmd', '/k', target, ...args],
        windowsHide: true, // 只隐藏发起 start 的瞬时 cmd;start 开出的新窗口照常可见
      };
    }

    if (platform === 'darwin') {
      const line = [target, ...args].map(_shQuote).join(' ');
      const script = `tell application "Terminal" to do script ${_appleScriptQuote(line)}`;
      const activate = 'tell application "Terminal" to activate';
      return { command: 'osascript', args: ['-e', script, '-e', activate] };
    }

    // linux / 其它 POSIX:x-terminal-emulator 是 Debian alternatives 指向系统默认终端,
    // 最具可移植性;若本机无它,_spawnDetached 会 fail-soft 回退历史启动。
    return { command: 'x-terminal-emulator', args: ['-e', target, ...args] };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  isInteractiveTerminalApp,
  buildTerminalLaunchArgv,
  INTERACTIVE_TERMINAL_APPS,
  _basenameNoExt,
};
