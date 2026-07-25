'use strict';

/**
 * `desktop` command — manage the desktop-control gate (mouse/keyboard/window automation).
 *
 * Real mouse/keyboard/window control is a CRITICAL capability and is OFF by default
 * (KHY_DESKTOP_CONTROL=off, fail-closed). This command lets the user opt in/out without
 * hand-editing environment variables. The safetyGate re-reads KHY_DESKTOP_CONTROL on every
 * action, so changing it here takes effect immediately for the current process.
 *
 * Usage:
 *   khy desktop                 → show current mode + detected capabilities
 *   khy desktop status          → same as above
 *   khy desktop on              → autonomous (no per-action approval)
 *   khy desktop ask             → approve once per session
 *   khy desktop strict          → approve every single action
 *   khy desktop off             → deny all desktop control (default, safe)
 *
 * NOTE: setting it from the CLI only affects THIS process. For a persistent default,
 * export KHY_DESKTOP_CONTROL in your shell profile.
 */

const chalk = require('chalk');
const { printError, printInfo, printSuccess, printWarn } = require('../formatters');

const VALID = {
  on: 'on', ask: 'ask', strict: 'strict', off: 'off',
  '1': 'on', '0': 'off', enable: 'on', disable: 'off',
};

function _currentMode() {
  const raw = String(process.env.KHY_DESKTOP_CONTROL || '').trim().toLowerCase();
  return VALID[raw] || 'off';
}

function _printStatus() {
  const c = chalk;
  const mode = _currentMode();
  let caps = null;
  try { caps = require('../../services/desktopControl').create().capabilities(); } catch { /* optional */ }

  console.log('');
  console.log(c.cyan(`  桌面操控当前模式: ${mode}`));
  console.log(c.dim('    off=全拒(默认安全) | ask=每会话审批一次 | strict=每步审批 | on=无人值守自主'));
  if (caps && caps.summary) {
    const s = caps.summary;
    console.log('');
    console.log(c.dim('  本机能力探测:'));
    console.log(c.dim(`    眼(截屏): ${s.canSee ? c.green('✓') : c.red('✗')}`));
    console.log(c.dim(`    手(鼠标/键盘): ${s.canActuate ? c.green('✓') : c.red('✗')}`));
    console.log(c.dim(`    感知(可点元素): ${s.canPerceive ? c.green('✓') : c.red('✗')}`));
    if (!s.canActuate && caps.hands && Array.isArray(caps.hands.installHints) && caps.hands.installHints.length) {
      const h = caps.hands.installHints[0];
      console.log(c.yellow(`    提示: ${h.hint || `安装 ${h.package}`}`));
    }
  }
  console.log('');
  console.log(c.dim('  切换: khy desktop on | ask | strict | off'));
  console.log('');
}

/**
 * @param {string|null} subCommand - first positional after `desktop`
 * @param {string[]} args
 * @param {object} options
 */
async function handleDesktop(subCommand, args /* , options */) {
  const arg = String(subCommand || (args && args[0]) || '').trim().toLowerCase();

  if (!arg || arg === 'status' || arg === 'show') {
    _printStatus();
    return;
  }

  const next = VALID[arg];
  if (!next) {
    printError(`未知模式「${arg}」。可用: on / ask / strict / off`);
    printInfo('运行 `khy desktop` 查看当前状态与本机能力。');
    return;
  }

  process.env.KHY_DESKTOP_CONTROL = next;
  if (next === 'off') {
    printSuccess('桌面操控已关闭（鼠标/键盘/窗口自动化被拒绝）。');
  } else {
    const note = next === 'on' ? '无人值守自主' : next === 'ask' ? '每会话审批一次' : '每步审批';
    printSuccess(`桌面操控已开启 [${next}] — ${note}。`);
    printInfo('现在可用自然语言操控，例如「关闭火狐窗口」「激活 VS Code」「打开 example.com」。');
    printWarn('⚠ 这是高危能力（接管真实鼠标/键盘）。这只对当前进程生效；要持久生效请在 shell 中 export KHY_DESKTOP_CONTROL。');
  }
}

module.exports = { handleDesktop, _currentMode };
