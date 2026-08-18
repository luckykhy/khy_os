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
  // 子命令: log — 查询自愈审计日志
  if (subCommand === 'log') {
    let healAuditSvc;
    try {
      healAuditSvc = require('../../services/healAuditService');
    } catch (err) {
      printError(`自愈审计服务加载失败: ${String((err && err.message) || err)}`);
      return true;
    }

    const last = parseInt(String(options.last || '20'), 10) || 20;
    const component = options.component || null;
    const filter = { last };
    if (component) filter.component = component;

    let events;
    try {
      events = healAuditSvc.queryHealEvents(filter);
    } catch (err) {
      printError(`查询自愈日志失败: ${String((err && err.message) || err)}`);
      return true;
    }

    if (!events || events.length === 0) {
      printInfo('暂无自愈事件记录。');
      return true;
    }

    // 表格输出: 时间 | 组件 | 动作 | 目标 | 结果
    console.log(
      chalk.bold('\n  时间                ') +
        chalk.bold('组件          ') +
        chalk.bold('动作                    ') +
        chalk.bold('目标                          ') +
        chalk.bold('结果')
    );
    console.log(chalk.dim('  ' + '─'.repeat(100)));

    for (const evt of events) {
      const ts = (evt.timestamp || '').slice(0, 19).replace('T', ' ');
      const comp = (evt.component || '').padEnd(12).slice(0, 12);
      const action = (evt.action || '').padEnd(22).slice(0, 22);
      const target = (evt.target || '').padEnd(28).slice(0, 28);
      const result = evt.result || '';

      const resultColored =
        result === 'success'
          ? chalk.green(result)
          : result === 'failure'
          ? chalk.red(result)
          : chalk.yellow(result);

      console.log(`  ${ts}  ${comp}  ${action}  ${target}  ${resultColored}`);
    }

    console.log(chalk.dim(`\n  共 ${events.length} 条记录\n`));
    return true;
  }

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

  // 上次自愈已交人(L3)且尚未清理 → 先把它摆到台面上,免得用户反复跑 heal 却不知道
  // 早就有一份「机器修不了,请人工处理」的记录躺在 .khy/ 里。
  try {
    const escSvc = require('../../services/healEscalationService');
    const pending = escSvc.readPendingEscalation({});
    if (pending && pending.component) {
      printWarn(
        `存在待处理的自愈升级记录（${pending.timestamp || '?'} · ${pending.component} · ` +
          `严重级 ${pending.severity || '?'}）：建议执行 ${pending.suggestedAction || 'khy doctor'}；` +
          `详情 ${escSvc.getEscalationFilePath({})}`
      );
    }
  } catch {
    /* 升级记录读不到不影响本命令 */
  }

  // 自愈失败 → 升级链(仅 --apply 路径:默认 dry-run 的红线是「绝不写盘」,
  // 自然也不能替用户触发 khy restore 这种更重的手段)。开发树同样不升级:
  // 那里的「差异」是正在写的代码,恢复手段是 git。
  if (apply && !svc._isDevTree({})) {
    try {
      const escSvc = require('../../services/healEscalationService');
      const verdict = escSvc.classifySourceHealFailure(res, {
        hadSnapshotBefore: svc._hadSnapshotBefore({}),
      });
      if (verdict.failed) {
        printWarn(`本机自愈(L1)未能修复：${verdict.reason}，正在升级到更重的修复手段…`);
        const out = await escSvc.escalate({
          component: 'sourceHealService',
          trigger: 'cli-heal',
          failedAttempts: verdict.attempts,
          force: force, // 人工显式 --force 时绕过冷却窗
          context: { healReason: reason },
          env,
        });
        if (out.level === 'L2' && out.reason === 'l2-ok') {
          printInfo(chalk.green(`✓ 已升级到 L2（${out.action}）并修复成功。`));
          return true;
        }
        if (out.level === 'L3') {
          // L3 的终端告警已由升级链打印(含具体故障与建议),这里不重复刷屏。
          return true;
        }
        if (out.reason === 'cooldown') {
          printInfo('升级冷却窗内（默认 24h）已升级过，本次不重复执行；如需强制请加 --force。');
        } else if (out.reason === 'gate-off') {
          printWarn('升级链已被 KHY_HEAL_ESCALATION 禁用，失败后无后续动作。');
        }
      }
    } catch (err) {
      printWarn(`自愈升级链执行异常（不影响本次体检结果）: ${String((err && err.message) || err)}`);
    }
  }

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
    chalk.bold('\n  🔧 源码自愈体检') +
      chalk.dim(
        `  (缺失 ${summary.missing || 0} · 损坏 ${summary.corrupt || 0} · 待处理 ${planCount})\n`
      )
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
      `快照版本 (${(res.report && res.report.snapshotVersion) || '?'}) 与运行版本 ` +
        `(${(res.report && res.report.runningVersion) || '?'}) 不一致：这更像版本漂移而非损坏，` +
        `已拒绝自动写回。如确需整树还原，请运行 khy restore。`
    );
    return true;
  }

  // 过量红线拦截。
  if (reason === 'too-many-changes') {
    printWarn(
      `待修复文件数 (${planCount}) 超过安全阈值 ` +
        `(${(res.report && res.report.autoMax) || 25})：这更像系统性差异而非「个别文件损坏」，` +
        `已拒绝自动 mass-write。`
    );
    printInfo(
      '如确认是大范围损坏，请运行 khy restore 整树还原；或 khy heal --apply --force 强制修复（仍守版本红线）。'
    );
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
