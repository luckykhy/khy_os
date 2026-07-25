'use strict';

/**
 * RTK Command Handler — `khy rtk …`.
 *
 * RTK(Rust Token Killer)是 khy 默认开启的 token 节省层:执行 shell / grep(content)
 * 前把命令改写成 rtk 等价命令,压缩输出 60–90% 后再喂模型。本命令是它对用户的入口:
 *
 *   rtk            — 等同 rtk status
 *   rtk status     — 显示版本 / 是否启用 / 二进制定位 / 子开关(真实生效态对账)
 *   rtk gain       — 直通 `rtk gain`,展示省了多少 token(--project 仅本项目)
 *   rtk install    — 按需安装 rtk 二进制(cargo / 官方 install.sh),不必等首次 shell 命令
 *   rtk on|off     — 持久化开启/关闭 KHY_RTK_MODE(写入 .env,当前进程立即生效)
 *
 * @module handlers/rtk
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printError, printSuccess, printWarn, printTable } = require('../formatters');
const rtkMode = require('../../services/rtkMode');
const rtkEffectiveState = require('../../services/rtkEffectiveState');

async function _handleStatus() {
  const bin = await rtkMode.resolveBinary();
  const enabled = rtkMode.modeEnabled();
  printInfo(chalk.bold('RTK 省 token 模式'));

  // 真实生效态对账:mode(env 意图)× installed(二进制在否)→ 三态。门控关 → null,
  // 逐字节回退到旧的「只读 env」渲染(声称已启用,不管装没装)。
  const eff = rtkEffectiveState.describeEffectiveState(
    { mode: enabled, installed: !!bin, autoInstall: rtkMode.autoInstallEnabled() },
    process.env
  );
  if (eff) {
    const tone = eff.status === 'active' ? chalk.green
      : eff.status === 'pending-install' ? chalk.yellow
      : chalk.yellow;
    printInfo(`  状态:${tone(eff.label)}(KHY_RTK_MODE)`);
    if (eff.hint) printInfo(`  ${chalk.dim(eff.hint)}`);
  } else {
    printInfo(`  状态:${enabled ? chalk.green('已启用') : chalk.yellow('已关闭')}(KHY_RTK_MODE)`);
  }

  printInfo(`  文件工具(grep content):${rtkMode.fileToolsEnabled() ? chalk.green('开') : chalk.yellow('关')}(KHY_RTK_FILE_TOOLS)`);
  printInfo(`  自动安装:${rtkMode.autoInstallEnabled() ? chalk.green('开') : chalk.yellow('关')}(KHY_RTK_AUTO_INSTALL)`);
  if (bin) {
    const version = rtkMode.probeVersion({ bin }) || '(版本未知)';
    printInfo(`  二进制:${chalk.cyan(bin)}`);
    printInfo(`  版本:${version}`);
  } else {
    printWarn('  二进制:未找到(rtk 未安装)。');
    printInfo(`  立即安装:${chalk.cyan('khy rtk install')}`);
    printInfo(rtkMode.autoInstallEnabled()
      ? '  (或首次跑 shell 命令时会尝试自动安装:cargo / 官方 install.sh)'
      : '  自动安装已关闭;或手动安装见 https://github.com/rtk-ai/rtk');
  }
  printInfo('');
  printInfo(`  查看省量:${chalk.cyan('khy rtk gain')}    开关:${chalk.cyan('khy rtk on|off')}`);
  return true;
}

/**
 * 按需安装 rtk 二进制。此前 khy 只在首次 shell 命令时 fire-and-forget 自动安装,没有显式命令
 * (旧 khy 甚至幻觉建议过不存在的 `khy rtk install`)。这里把它做成真命令:直接 await
 * rtkInstaller.ensureInstalled(),把结果如实报给用户。永不抛。
 */
async function _handleInstall() {
  let installer;
  try {
    installer = require('../../services/rtkInstaller');
  } catch (err) {
    printError(`无法加载安装器:${(err && err.message) || err}`);
    return true;
  }

  // 已装则直接告知,不重复安装。
  const existing = await rtkMode.resolveBinary({ force: true });
  if (existing) {
    printSuccess(`rtk 已安装:${existing}`);
    printInfo(`  版本:${rtkMode.probeVersion({ bin: existing }) || '(版本未知)'}`);
    return true;
  }

  if (!rtkMode.autoInstallEnabled()) {
    printWarn('自动安装当前关闭(KHY_RTK_AUTO_INSTALL=off)。');
    printInfo('开启后重试:khy capability on rtk_auto_install,或手动装:https://github.com/rtk-ai/rtk');
    return true;
  }

  printInfo('正在安装 rtk(优先 cargo,失败回落官方 install.sh)…可能需要联网/编译,请稍候。');
  let res;
  try {
    res = await installer.ensureInstalled();
  } catch (err) {
    printError(`安装失败(未抛给回合):${(err && err.message) || err}`);
    return true;
  }

  if (res && res.success) {
    printSuccess(`rtk 安装成功(${res.method}):${res.path || '(路径未知)'}`);
    printInfo(`  版本:${rtkMode.probeVersion({ bin: res.path }) || '(版本未知)'}`);
    printInfo(`  现在 RTK 省 token 模式已真正生效。查看省量:${chalk.cyan('khy rtk gain')}`);
  } else {
    printWarn(`未能自动安装 rtk(${(res && res.reason) || '未知原因'})。`);
    printInfo('可手动安装:https://github.com/rtk-ai/rtk —— khy 仍会用原生 smartTruncation 兜底。');
  }
  return true;
}

async function _handleGain(options = {}) {
  const bin = await rtkMode.resolveBinary();
  if (!bin) {
    printError('rtk 未安装,无统计可显示。');
    printInfo(rtkMode.autoInstallEnabled()
      ? '首次跑 shell 命令时会自动安装,之后再试 `khy rtk gain`。'
      : '开启自动安装(KHY_RTK_AUTO_INSTALL)或手动安装:https://github.com/rtk-ai/rtk');
    return true;
  }
  const res = rtkMode.runGain({ bin, project: !!options.project });
  if (res.error) {
    printError(`rtk gain 失败:${res.error}`);
    return true;
  }
  // 直通原始报表(rtk 自带美观表格),并附 khy 侧一行汇总。
  const s = res.stats || {};
  if (res.raw) console.log(res.raw);
  if (s.tokensSaved && s.savedPercent != null) {
    printSuccess(`RTK 已为 khy 省下约 ${s.tokensSaved} tokens(${s.savedPercent}%),覆盖 ${s.totalCommands ?? '?'} 条命令。`);
  }
  return true;
}

function _handleToggle(turnOn) {
  let writeEnvPatch;
  try {
    ({ _writeEnvPatch: writeEnvPatch } = require('./config'));
  } catch (err) {
    printError(`无法持久化开关:${(err && err.message) || err}`);
    return true;
  }
  const value = turnOn ? 'true' : 'false';
  const envPath = writeEnvPatch({ KHY_RTK_MODE: value });
  process.env.KHY_RTK_MODE = value; // 当前进程立即生效
  if (turnOn) printSuccess('RTK 省 token 模式已开启(KHY_RTK_MODE=true)。');
  else printSuccess('RTK 省 token 模式已关闭(KHY_RTK_MODE=false)——回到原生命令 + smartTruncation。');
  printInfo(`已写入:${envPath}`);
  return true;
}

/**
 * @param {{ subCommand?:string, args?:string[], options?:object }} parsed
 */
async function handleRtk(parsed = {}) {
  const sub = String(parsed.subCommand || (Array.isArray(parsed.args) && parsed.args[0]) || 'status').toLowerCase();
  const options = parsed.options || {};
  switch (sub) {
    case 'gain':
      return _handleGain(options);
    case 'install':
      return _handleInstall();
    case 'on':
    case 'enable':
      return _handleToggle(true);
    case 'off':
    case 'disable':
      return _handleToggle(false);
    case 'status':
    case '':
      return _handleStatus();
    default:
      printError(`未知子命令:rtk ${sub}`);
      printInfo('可用:khy rtk [status|gain|install|on|off]');
      return true;
  }
}

module.exports = { handleRtk };
