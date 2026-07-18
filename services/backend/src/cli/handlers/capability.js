'use strict';

/**
 * Capability Command Handler — `khy capability …`.
 *
 * Surfaces the "capability-as-code" registry: every capability Khyos has
 * learned is a tool authored to the convention (executable code + co-located
 * tests + auto-discovery), shipped with the product. This command lets the user
 * SEE what Khyos can do and whether each capability is test-covered, so a
 * "learned skill" is a verifiable, version-controlled artifact rather than an
 * opaque assistant memory.
 *
 *   capability [list]        — list all capabilities + test-coverage flag
 *   capability show <name>   — details for one capability (declared test paths
 *                              + presence check) and the surfaces it serves
 *
 * @module handlers/capability
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printTable, printSuccess, printWarn } = require('../formatters');
const cap = require('../../services/capabilityRegistry');
const nlConfig = require('../../services/config/nlConfigResolver');

function _handleList() {
  const caps = cap.listCapabilities();
  if (caps.length === 0) {
    printInfo('暂无已登记的能力（capability-as-code）。');
    printInfo('能力 = 带 `capability` 元数据块的工具（见 tools/_baseTool.js）。');
    return true;
  }
  printInfo(`已登记能力 ${caps.length} 项（每项 = 可执行代码 + 测试 + 自动发现）：`);
  const rows = caps.map((c) => {
    const covered = c.tests.length > 0 ? chalk.green('是') : chalk.yellow('无');
    return [c.name, c.summary || '-', (c.surfaces.join('/') || '-'), covered];
  });
  printTable(['能力', '说明', '可用面', '带测试'], rows);
  printInfo('查看详情：khy capability show <能力名>');
  return true;
}

function _handleShow(name) {
  if (!name) {
    printError('用法: capability show <能力名>');
    return true;
  }
  const info = cap.describeCapability(name);
  if (!info) {
    printError(`未找到能力：${name}`);
    printInfo('用 `khy capability list` 查看全部能力。');
    return true;
  }
  printInfo(chalk.bold(`能力：${info.name}`));
  if (info.summary) printInfo(`  说明：${info.summary}`);
  if (info.learnedFrom) printInfo(`  来源：${info.learnedFrom}`);
  printInfo(`  可用面：${info.surfaces.join(' / ') || '-'}`);

  if (info.testsResolved.length === 0) {
    printWarn('  测试：未声明（不符合 capability-as-code 约定，应补测试）。');
  } else {
    printInfo('  测试：');
    for (const t of info.testsResolved) {
      const mark = t.exists ? chalk.green('✓ 存在') : chalk.red('✗ 缺失');
      printInfo(`    ${mark}  ${t.path}`);
    }
    if (info.testsPresent) {
      printSuccess('  全部声明的测试文件均存在。');
    } else {
      printWarn('  有声明的测试文件缺失——能力的测试覆盖不完整。');
    }
  }
  return true;
}

// ── NL-config toggles ────────────────────────────────────────────────────────
// 在 khyos 里用户是最高权限,自然语言即可改这些开关(见 Configure 工具 / 直接对话说
// 「关闭改动监视」)。本 CLI 是等价的命令行入口,reuse 同一注册表 nlConfigResolver +
// 同一持久化 config._writeEnvPatch,绝不让用户自己去文件里改。
async function _handleToggles() {
  const list = nlConfig.describeCapabilities();
  printInfo(`khyos 可控能力开关 ${list.length} 项(自然语言或命令均可改,无需手动改文件):`);

  // RTK 真实生效态对账:KHY_RTK_MODE 这一行的「当前」不能只看 env——开着但二进制没装 = 未生效。
  // 探一次二进制(门控关时跳过,回退纯 env 显示)。绝不因此拖垮命令。
  let rtkInstalled = null; // null = 未探测 / 门控关
  try {
    const rtkEff = require('../../services/rtkEffectiveState');
    if (rtkEff.isEnabled(process.env) && list.some((c) => c.envKey === 'KHY_RTK_MODE')) {
      const bin = await require('../../services/rtkMode').resolveBinary();
      rtkInstalled = !!bin;
    }
  } catch { /* 探测失败 → 回退纯 env 显示 */ }

  const rows = list.map((c) => {
    const raw = process.env[c.envKey];
    const off = ['0', 'false', 'off', 'no'].includes(String(raw == null ? 'true' : raw).trim().toLowerCase());
    let cur = off ? chalk.yellow('关') : chalk.green('开');
    // 幻影启用诚实标注:RTK 开着但没装 → 「开(未装·未生效)」。
    if (!off && c.envKey === 'KHY_RTK_MODE' && rtkInstalled === false) {
      cur = chalk.yellow('开(未装·未生效)');
    }
    return [c.id, c.summary, c.envKey, cur];
  });
  printTable(['能力', '说明', '开关', '当前'], rows);
  printInfo('开/关:khy capability on <能力>  |  khy capability off <能力>');
  printInfo('或直接对话说:「关闭改动监视」「打开省 token 模式」。');
  return true;
}

function _persist(envKey, value) {
  try {
    const { _writeEnvPatch } = require('./config');
    const p = _writeEnvPatch({ [envKey]: value });
    return p;
  } catch (err) {
    printError(`无法持久化:${(err && err.message) || err}`);
    return null;
  }
}

function _handleToggle(name, turnOn) {
  if (!name) {
    printError(`用法: capability ${turnOn ? 'on' : 'off'} <能力名/KHY_键>`);
    printInfo('用 `khy capability toggles` 查看全部可控能力。');
    return true;
  }
  const c = nlConfig.findCapability(name);
  const envKey = c ? c.envKey
    : (/\bKHY_[A-Z0-9_]{2,}\b/.test(name) ? name.match(/\bKHY_[A-Z0-9_]{2,}\b/)[0] : null);
  if (!envKey) {
    printError(`未识别的能力:${name}`);
    printInfo('用 `khy capability toggles` 查看可控能力,或直接给出 KHY_* 键。');
    return true;
  }
  const value = turnOn ? nlConfig.ON_VALUE : nlConfig.OFF_VALUE;
  const p = _persist(envKey, value);
  if (p == null) return true;
  const label = c ? c.summary : envKey;
  printSuccess(`✅ ${label} ${turnOn ? '已开启' : '已关闭'}(${envKey}=${value})。已即时生效并持久化。`);
  printInfo(`已写入:${p}`);
  return true;
}

function _handleSetRaw(name, value) {
  if (!name || value === undefined) {
    printError('用法: capability set <KHY_键> <值>');
    return true;
  }
  const envKey = /\bKHY_[A-Z0-9_]{2,}\b/.test(name)
    ? name.match(/\bKHY_[A-Z0-9_]{2,}\b/)[0]
    : (nlConfig.findCapability(name) || {}).envKey;
  if (!envKey) {
    printError(`未识别的开关:${name}`);
    return true;
  }
  const p = _persist(envKey, String(value));
  if (p == null) return true;
  printSuccess(`✅ ${envKey} 已设为 ${value}。已即时生效并持久化。`);
  printInfo(`已写入:${p}`);
  return true;
}

/**
 * @param {object} parsed - { subCommand, args }
 * @returns {boolean}
 */
function handleCapability(parsed = {}) {
  const sub = String(parsed.subCommand || '').toLowerCase();
  const args = Array.isArray(parsed.args) ? parsed.args : [];

  if (!sub || sub === 'list') return _handleList();
  if (sub === 'show') return _handleShow(args[0]);
  if (sub === 'toggles') return _handleToggles();
  if (sub === 'on') return _handleToggle(args[0], true);
  if (sub === 'off') return _handleToggle(args[0], false);
  if (sub === 'set') return _handleSetRaw(args[0], args[1]);

  printError(`未知子命令：${sub}`);
  printInfo('用法: capability list | show <名> | toggles | on <名> | off <名> | set <KHY_键> <值>');
  return true;
}

module.exports = { handleCapability };
