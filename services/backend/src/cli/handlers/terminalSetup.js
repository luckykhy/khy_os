'use strict';

/**
 * terminalSetup.js — `/terminalSetup` 命令薄壳:检测当前终端,给出 Shift+Enter 换行配置方案。
 *
 * 对齐 Claude Code 的 terminalSetup。**背后逻辑分类**(原生支持 / 需配置 / 未知 + 各终端的配置
 * 文件位置与片段)在纯叶子 terminalSetupPlan.js;本薄壳只做 IO:复用既有 `adaptiveConfig.detectTerminal()`
 * (SSOT,绝不另写终端检测)取终端名 + remote 标志,注入 os.homedir()/process.platform/process.env,
 * 让叶子产出方案,再打印引导。
 *
 * **诚实边界(与 CC 的取舍不同)**:CC 自动改写用户的 VSCode keybindings.json / alacritty.toml /
 * zed keymap.json / Apple Terminal plist。khy **刻意不静默改写外部编辑器配置** —— 无 JSONC 解析器、
 * plist 为二进制,自动写入风险高、易破坏用户主配置(违「不要真的破坏主文件」的稳健取向)。改为打印
 * 精确的配置文件路径 + 可直接粘贴的片段 + 步骤,由用户掌控落盘。
 *
 * 门控 KHY_TERMINAL_SETUP 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界)。
 */

const os = require('os');
const { printInfo, printSuccess, printWarn } = require('../formatters');
const plan = require('../../services/terminal/terminalSetupPlan');

/**
 * @param {string} _subCommand 预留(本命令无子命令)
 * @param {string[]} _args 预留
 * @returns {Promise<boolean>}
 */
async function handleTerminalSetup(_subCommand, _args = [], _options = {}) {
  if (!plan.isEnabled(process.env)) {
    printInfo('终端 Shift+Enter 配置说明请查阅终端文档(配置「Shift+Enter 发送 ESC+CR」)。');
    return false;
  }

  // 复用既有终端检测 SSOT,绝不另写一份。
  let detected = { name: 'unknown', isRemote: false };
  try {
    const { detectTerminal } = require('../../services/adaptiveConfig');
    if (typeof detectTerminal === 'function') detected = detectTerminal() || detected;
  } catch { /* fail-soft:检测不到按 unknown 处理 */ }

  const result = plan.planTerminalSetup({
    name: detected.name,
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
  });

  printInfo(`检测到终端:${result.displayName}${result.terminal && result.terminal !== result.displayName.toLowerCase() ? `(${result.terminal})` : ''}`);

  if (result.category === 'native') {
    printSuccess(result.reason);
    printInfo('khy TUI 已支持 Shift+Enter 换行,无需额外配置。');
    return true;
  }

  if (result.category === 'unknown') {
    printWarn(result.reason);
    return true;
  }

  // needs-setup:打印方案(诚实:khy 给步骤与片段,不静默改你的配置)。
  printInfo(result.reason);
  if (result.configPath) printInfo(`配置文件:${result.configPath}`);
  if (Array.isArray(result.steps) && result.steps.length) {
    printInfo('步骤:');
    result.steps.forEach((s, i) => printInfo(`  ${i + 1}. ${s}`));
  }
  if (result.snippet) {
    printInfo('需添加的配置片段:');
    printInfo(result.snippet);
  }
  printInfo('(khy 不会自动改写你的编辑器配置 —— 按上面步骤手动添加最稳妥。)');
  return true;
}

module.exports = { handleTerminalSetup };
