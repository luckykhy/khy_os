'use strict';

/**
 * Heal Command Handler — khy 源码自愈手动入口(`khy heal` / `/heal`)。
 *
 * 承 goal「khy 多节点触发自愈:函数名少打一个字母(源码损坏)或个别文件丢失可
 * 修正补齐」。自动触发点(CLI 启动 / chat 启动 / pip·npm 更新 / 部署 / 重启)由
 * bootstrap + TUI prefetch 的 runStartupHeal 覆盖;本命令是**触发点⑦「其他」+ 人工
 * 控制**:让用户随时主动体检、预览计划、或显式修复。
 *
 * 安全红线(与自动路径一致):
 *   - **默认 dry-run**(apply=false):只体检 + 打印计划,绝不写盘。真修复须显式 --apply。
 *   - --apply 仍受双护栏保护:版本红线(快照版本 != 运行版本 → 拒写)+ 过量红线
 *     (计划 > KHY_SOURCE_HEAL_AUTO_MAX 默认 25 → 拒绝 mass-write,建议 `khy restore`)。
 *   - --force 显式绕过过量红线(仍守版本红线),供人工深修。
 *
 * 用法:
 *   heal                检查缺失/损坏的运行时源码文件(dry-run,只预览计划)
 *   heal --apply        实际修复(逐文件从纯净快照补齐/覆盖,损坏文件先备份 .broken-<ts>)
 *   heal --deep         绕过清单缓存,强制重新解密快照体检
 *   heal --force        与 --apply 合用:绕过过量红线(仍守版本红线)
 *   heal --json         机器可读输出
 *
 * 门控 KHY_SOURCE_HEAL 默认开;关 → {reason:'gate-off'} 不触碰文件系统。
 *
 * @module handlers/heal
 */
const chalk = require('chalk').default || require('chalk');
const { printInfo, printWarn, printError } = require('../formatters');

/**
 * @param {string} subCommand   第一个位置参数(本命令无子命令,忽略)
 * @param {string[]} args        其余位置参数(忽略)
 * @param {object} options       parseInput 解析的 --flags
 */
async function handleHeal(subCommand, args = [], options = {}) {
  const env = process.env;
  let svc;
  try {
    svc = require('../../services/sourceHealService');
  } catch (err) {
    printError(`源码自愈模块加载失败: ${String((err && err.message) || err)}`);
    return true;
  }

  const apply = !!(options.apply || options.fix);
  const deep = !!options.deep;
  const force = !!options.force;

  let res;
  try {
    res = svc.healSource({ env, apply, deep, force });
  } catch (err) {
    printError(`源码自愈执行失败: ${String((err && err.message) || err)}`);
    return true;
  }

  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return true;
  }

  const reason = (res && res.reason) || 'unknown';

  // 门控关。
  if (reason === 'gate-off') {
    printWarn('源码自愈已被 KHY_SOURCE_HEAL 禁用（当前为关闭状态）。');
    return true;
  }

  // 无随包快照(纯 dev 树 / 未打包)。
  if (reason === 'no-snapshot' || reason === 'no-snapshot-header') {
    printInfo('未找到随包源码快照，跳过自愈（开发树或未打包环境属正常）。');
    return true;
  }

  // 快照无法解密(密钥不符 / 文件损坏)。
  if (reason === 'snapshot-unreadable') {
    printWarn('源码快照无法解密（密钥不符或快照损坏），本次跳过。');
    return true;
  }

  if (reason === 'error') {
    printError(`源码自愈遇到错误: ${(res.report && res.report.error) || '未知错误'}`);
    return true;
  }

  const planCount = Array.isArray(res.plan) ? res.plan.length : 0;
  const summary = (res.report && res.report.summary) || {};

  // 健康:无需修复。
  if (reason === 'healthy' || planCount === 0) {
    printInfo(chalk.green('✓ 运行时源码完好，无需修复。'));
    return true;
  }

  console.log(
    chalk.bold('\n  🔧 源码自愈体检')
    + chalk.dim(`  (缺失 ${summary.missing || 0} · 损坏 ${summary.corrupt || 0} · 待处理 ${planCount})\n`),
  );

  // 逐条列出计划(缺失/损坏)。
  const shown = res.plan.slice(0, 40);
  for (const item of shown) {
    const tag = item.reason === 'missing' ? chalk.yellow('缺失') : chalk.red('损坏');
    console.log(`    ${tag}  ${chalk.white(item.relPath)}`);
  }
  if (planCount > shown.length) {
    console.log(chalk.dim(`    …… 另有 ${planCount - shown.length} 个文件`));
  }
  console.log('');

  // 版本红线拦截。
  if (reason === 'version-mismatch') {
    printWarn(
      `快照版本 (${(res.report && res.report.snapshotVersion) || '?'}) 与运行版本 `
      + `(${(res.report && res.report.runningVersion) || '?'}) 不一致：这更像版本漂移而非损坏，`
      + `已拒绝自动写回。如确需整树还原，请运行 khy restore。`,
    );
    return true;
  }

  // 过量红线拦截。
  if (reason === 'too-many-changes') {
    printWarn(
      `待修复文件数 (${planCount}) 超过安全阈值 `
      + `(${(res.report && res.report.autoMax) || 25})：这更像系统性差异而非「个别文件损坏」，`
      + `已拒绝自动 mass-write。`,
    );
    printInfo('如确认是大范围损坏，请运行 khy restore 整树还原；或 khy heal --apply --force 强制修复（仍守版本红线）。');
    return true;
  }

  // 已实际修复。
  if (reason === 'healed') {
    printInfo(chalk.green(`✓ 已修复 ${res.healed} 个文件（损坏原件已备份为 .broken-<时间戳>）。`));
    if (res.failed && res.failed.length) {
      printWarn(`另有 ${res.failed.length} 个文件修复失败，详见 khy heal --json。`);
    }
    return true;
  }

  if (reason === 'attempted') {
    printWarn('已尝试修复，但没有文件被写回（可能全部被安全护栏拦截）。');
    return true;
  }

  // dry-run 预览(默认路径)。
  if (!apply) {
    printInfo('以上为体检预览（dry-run）。确认无误后运行 khy heal --apply 实际修复。');
  }
  return true;
}

module.exports = {
  handleHeal,
};
