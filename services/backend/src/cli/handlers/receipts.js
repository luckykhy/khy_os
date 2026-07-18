/**
 * Receipts CLI handler — browse structured execution receipts (A3).
 *
 * Commands:
 *   khy receipts list [--session <id>] [--limit <n>]   — recent receipts
 *   khy receipts show <id>                              — full receipt detail
 *   khy receipts search <keyword>                       — full-text search
 */
const chalk = (() => {
  const m = require('chalk');
  return m.default || m;
})();
const { printError, printInfo } = require('../formatters');
const { ccFormatDurationOr } = require('../ccFormat');

const RISK_COLOR = {
  safe: (s) => chalk.dim(s),
  low: (s) => chalk.green(s),
  medium: (s) => chalk.cyan(s),
  high: (s) => chalk.yellow(s),
  critical: (s) => chalk.red(s),
};

const STATUS_ICON = {
  completed: chalk.green('✓'),
  partial: chalk.yellow('◑'),
  failed: chalk.red('✗'),
  interrupted: chalk.yellow('⏸'),
  running: chalk.dim('…'),
};

function _riskTag(risk) {
  const fn = RISK_COLOR[risk] || ((s) => s);
  return fn(`[${risk}]`);
}

function _fmtTime(iso) {
  try { return new Date(iso).toLocaleString('zh-CN'); } catch { return iso || ''; }
}

async function handleReceipts(subCommand, args, options) {
  const svc = require('../../services/receiptService');

  // No subcommand → list.
  const cmd = subCommand || 'list';

  if (cmd === 'list') {
    const limit = parseInt(options.limit, 10) || 20;
    const sessionId = options.session || null;
    const rows = svc.listReceipts({ sessionId, limit });
    console.log(chalk.bold('\n  📑 执行回执\n'));
    if (rows.length === 0) {
      printInfo('暂无回执记录');
      console.log('');
      return true;
    }
    for (const r of rows) {
      const icon = STATUS_ICON[r.status] || chalk.dim('•');
      console.log(
        `  ${icon} ${chalk.cyan(r.id)} ${_riskTag(r.maxRisk)} ` +
        `${chalk.dim(_fmtTime(r.startedAt))} ${chalk.dim(`(${r.tools} 工具)`)}`
      );
      if (r.goal) console.log(`     ${chalk.dim(r.goal)}`);
    }
    console.log(chalk.dim(`\n  共 ${rows.length} 条 · 用法: receipts show <id> · receipts search <kw>\n`));
    return true;
  }

  if (cmd === 'show') {
    const id = args[0];
    if (!id) { printError('用法: receipts show <RCPT-id>'); return true; }
    const r = svc.getReceipt(id);
    if (!r) { printError(`未找到回执: ${id}`); return true; }

    const icon = STATUS_ICON[r.status] || '•';
    console.log(chalk.bold(`\n  📑 回执 ${chalk.cyan(r.id)}  ${icon} ${r.status}\n`));
    // 1. 执行目标
    console.log(chalk.bold('  执行目标 (goal)'));
    console.log(`    ${r.goal || chalk.dim('(无)')}`);
    // 2. 执行计划
    if (r.plan) {
      console.log(chalk.bold('\n  执行计划 (plan)'));
      console.log(`    ${r.plan.replace(/\n/g, '\n    ')}`);
    }
    // 3. 工具调用链
    console.log(chalk.bold('\n  工具调用链 (toolChain)'));
    if (!r.toolChain || r.toolChain.length === 0) {
      console.log(chalk.dim('    (无)'));
    } else {
      for (const c of r.toolChain) {
        const ci = c.status === 'ok' ? chalk.green('✓') : c.status === 'denied' ? chalk.red('⊘') : chalk.red('✗');
        const gate = c.stepType === 'human-gate' ? chalk.red(' 🔒人闸门') : '';
        console.log(
          `    ${ci} ${String(c.seq).padStart(2)}. ${chalk.cyan(c.tool)} ` +
          `${_riskTag(c.risk)} ${chalk.dim(`${c.elapsedMs}ms · ${c.permission}`)}${gate}`
        );
        if (c.error) console.log(chalk.red(`        ↳ ${c.error}`));
      }
    }
    // 4. 产物与变更
    console.log(chalk.bold('\n  产物与变更 (artifacts)'));
    if (r.artifacts?.files?.length) {
      for (const f of r.artifacts.files) console.log(`    ${chalk.magenta(f.action)} ${f.path}`);
    } else {
      console.log(chalk.dim('    (无文件变更)'));
    }
    if (r.artifacts?.summary) console.log(`    ${chalk.dim(r.artifacts.summary)}`);
    // 5. 风险与审批
    console.log(chalk.bold('\n  风险与审批 (riskApproval)'));
    console.log(`    最高风险: ${_riskTag(r.riskApproval?.maxRisk || 'safe')}`);
    console.log(`    人闸门: ${r.riskApproval?.humanGated?.length || 0} · 拒绝: ${r.riskApproval?.denied?.length || 0}`);
    // 6. 错误信息
    if (r.error) {
      console.log(chalk.bold('\n  错误信息 (error)'));
      console.log(chalk.red(`    ${r.error}`));
    }
    console.log(chalk.dim(
      `\n  ${r.counts?.ok || 0} 成功 / ${r.counts?.failed || 0} 失败 · ` +
      `耗时 ${r.durationMs}ms${r.gitCommit ? ` · commit ${r.gitCommit.slice(0, 8)}` : ''}\n`
    ));
    return true;
  }

  if (cmd === 'search') {
    const kw = args[0];
    if (!kw) { printError('用法: receipts search <keyword>'); return true; }
    const hits = svc.searchReceipts(kw, { limit: parseInt(options.limit, 10) || 30 });
    console.log(chalk.bold(`\n  🔍 搜索 "${kw}"\n`));
    if (hits.length === 0) {
      printInfo('无匹配回执');
    } else {
      for (const h of hits) {
        const icon = STATUS_ICON[h.status] || chalk.dim('•');
        console.log(`  ${icon} ${chalk.cyan(h.id)} ${chalk.dim(_fmtTime(h.startedAt))}`);
        if (h.goal) console.log(`     ${chalk.dim(h.goal)}`);
      }
    }
    console.log('');
    return true;
  }

  if (cmd === 'orchestration' || cmd === 'orch') {
    const limit = parseInt(options.limit, 10) || 20;
    const rows = svc.listOrchestrationReceipts({ limit });
    console.log(chalk.bold('\n  🧭 编排回执 (orchestration)\n'));
    if (rows.length === 0) {
      printInfo('暂无编排回执');
      console.log('');
      return true;
    }
    for (const r of rows) {
      const icon = STATUS_ICON[r.status] || chalk.dim('•');
      const dur = ccFormatDurationOr(r.totalDurationMs || 0, `${((r.totalDurationMs || 0) / 1000).toFixed(1)}s`, process.env);
      console.log(
        `  ${icon} ${chalk.cyan(r.id)} ${chalk.magenta(`[${r.mode}]`)} ` +
        `${chalk.dim(`${r.successCount}/${r.subtaskCount} 成功 · ${dur}`)}`
      );
      if (r.goal) console.log(`     ${chalk.dim(r.goal)}`);
      const exec = Object.entries(r.byExecutor || {}).map(([k, v]) => `${k}:${v}`).join(' ');
      const steps = Object.entries(r.byStepType || {}).map(([k, v]) => `${k}:${v}`).join(' ');
      if (exec || steps) console.log(chalk.dim(`     executors[${exec}] steps[${steps}]`));
    }
    console.log(chalk.dim(`\n  共 ${rows.length} 条\n`));
    return true;
  }

  printError(`未知子命令: ${cmd} (支持: list | show <id> | search <kw> | orchestration)`);
  return true;
}

module.exports = { handleReceipts };
