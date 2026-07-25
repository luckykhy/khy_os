'use strict';

/**
 * sandboxToggle.js — `/sandbox-toggle` 命令薄壳:查看 / 切换 OS 级命令沙箱(bwrap / Seatbelt /
 * Windows Job Object)的开关。
 *
 * 对齐 Claude Code 的 /sandbox-toggle。**背后逻辑**(flag × 平台可用性 → 是否生效的判定表 + 期望
 * 动作 → 该落什么 env 的规划)在纯叶子 sandboxToggleState.js(单一真源,复刻 toolSandbox
 * .isOsSandboxEnabled 的判定);本薄壳只做 IO:探测平台后端、读写 .env、回显。
 *
 * **增强既有,绝不另起炉灶**:
 *   - 状态真源 = toolSandbox.isOsSandboxEnabled()(读 env KHY_OS_SANDBOX,本薄壳沿用其判定)。
 *   - 平台后端探测 = toolSandbox._detectBwrap() / _detectSeatbelt()(不另写探测)。
 *   - 持久化 = gatewayEnvFile.writeEnvMap / unsetEnvKeys(patch backend/.env + 同步更新
 *     process.env → 立即生效、无需重启;启动时 .env 经 KHY_ENV_FILE 加载,故重启亦保留)。
 *
 * 用法:`/sandbox-toggle`(查看当前态)、`/sandbox-toggle on|off|auto|toggle`(切换并持久化)。
 * 门控 KHY_SANDBOX_TOGGLE 默认开;关 → 命令不接管(字节回退到「无此命令」的历史世界)。
 *
 * **诚实边界**:沙箱是否真生效取决于平台依赖(Linux 需 bwrap、macOS 需 sandbox-exec)。若依赖
 * 缺失,本命令如实告知「已写 KHY_OS_SANDBOX=true 但当前平台后端不可用,沙箱仍不生效」,绝不假装。
 */

const { printInfo, printSuccess, printWarn } = require('../formatters');
const leaf = require('../../services/config/sandboxToggleState');
const toolSandbox = require('../../services/toolSandbox');
const envFile = require('../../services/gatewayEnvFile');

/** 由 toolSandbox 探测器收集当前平台的沙箱后端可用性(fail-soft)。 */
function _detectFacts() {
  let bwrapAvailable = false;
  let seatbeltAvailable = false;
  try {
    if (process.platform === 'linux') bwrapAvailable = !!toolSandbox._detectBwrap();
    else if (process.platform === 'darwin') seatbeltAvailable = !!toolSandbox._detectSeatbelt();
  } catch { /* fail-soft:探测失败按不可用处理 */ }
  return { platform: process.platform, bwrapAvailable, seatbeltAvailable };
}

/** 把当前 env 里的 KHY_OS_SANDBOX 归一为 leaf 认得的 flag。 */
function _currentFlag() {
  return leaf.normalizeSandboxFlag(process.env.KHY_OS_SANDBOX) || 'auto';
}

function _printState(label) {
  const facts = _detectFacts();
  const state = leaf.resolveSandboxState({ flag: _currentFlag(), ...facts });
  const onOff = state.effective ? '✓ 生效' : '✗ 未生效';
  printInfo(`${label}OS 沙箱:${onOff}(KHY_OS_SANDBOX=${state.flag},后端=${state.backend})`);
  printInfo(`  ${state.reason}`);
  if (!state.effective && state.flag !== 'false' && !state.available) {
    printWarn('  提示:沙箱后端不可用——开启 flag 也不会真正生效,需先安装平台依赖' +
      '(Linux: bubblewrap;macOS: 自带 sandbox-exec)。');
  }
}

/**
 * @param {string} subCommand on|off|auto|toggle(可空 → 查看)
 * @param {string[]} args 备用位置参(无 subCommand 时第一个位置参当动作)
 * @returns {Promise<boolean>}
 */
async function handleSandboxToggle(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('OS 沙箱开关命令未启用(KHY_SANDBOX_TOGGLE=off)。');
    return false;
  }

  const list = Array.isArray(args) ? args : [];
  const action = String(subCommand || list[0] || '').trim();

  // 无动作 → 只读查看当前态。
  if (!action) {
    _printState('当前');
    printInfo('用法:/sandbox-toggle on|off|auto|toggle');
    return true;
  }

  const plan = leaf.planSandboxAction(action, _currentFlag());
  if (!plan.ok) {
    printWarn(plan.parseError);
    printInfo('用法:/sandbox-toggle on|off|auto|toggle');
    return true;
  }

  try {
    if (plan.unset) {
      envFile.unsetEnvKeys(['KHY_OS_SANDBOX']);
      printSuccess('已重置 OS 沙箱为 auto(删除 KHY_OS_SANDBOX,跟随平台默认)。');
    } else {
      envFile.writeEnvMap({ KHY_OS_SANDBOX: plan.flag });
      printSuccess(`已写入 KHY_OS_SANDBOX=${plan.flag}(已持久化到 .env 并即时生效)。`);
    }
  } catch (err) {
    printWarn(`写入 .env 失败:${err && err.message ? err.message : err}`);
    return true;
  }

  _printState('现在');
  return true;
}

module.exports = { handleSandboxToggle };
