/**
 * Deliveries CLI handler — 任务交付台账查询（任务最小闭环的「回查」一环）。
 *
 * 任务终态由 backgroundTaskManager.complete/fail/cancel 与 headless -p 入口
 * 追加进持久台账（services/deliveryLedger，JSONL 自裁剪）；活动任务列表本身
 * 5 分钟 TTL 即焚，台账独立持久，供回查「上次任务交付了什么、缺什么证据」。
 *
 * 用法:
 *   khy deliveries [--limit <n>] [--status succeeded|failed|cancelled] [--task <taskId>]
 *   khy deliveries stats   — 台账路径与总条数
 */
const chalk = (() => {
  const m = require('picocolors');
  return m.default || m;
})();
const { printError, printInfo } = require('../formatters');

const STATUS_ICON = {
  succeeded: chalk.green('✓'),
  failed: chalk.red('✗'),
  cancelled: chalk.yellow('⏸'),
};

// 闭环结论 → 用户可读标签（closure 由调用方自报，未知值原样展示）
const CLOSURE_LABEL = {
  close: '完整闭环',
  close_partial: '部分闭环',
  'delivery-gate-fail': '交付门未过',
  error: '执行出错',
  cancelled: '已取消',
  unknown: '未知',
};

function _fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN');
  } catch {
    return iso || '';
  }
}

async function handleDeliveries(subCommand, args, options) {
  const ledger = require('../../services/deliveryLedger');
  const cmd = subCommand === 'stats' || subCommand === 'list' ? subCommand : 'list';

  if (cmd === 'stats') {
    const stats = ledger.ledgerStats();
    console.log(chalk.bold('\n  📦 交付台账\n'));
    console.log(`  路径: ${chalk.dim(stats.path)}`);
    console.log(`  条数: ${chalk.cyan(String(stats.count))}`);
    console.log(chalk.dim('\n  用法: deliveries [--limit n] [--status <状态>] · stats 查看本页\n'));
    return true;
  }

  const limit = parseInt(options.limit, 10) || 20;
  const status = options.status || undefined;
  const taskId = options.task || undefined;
  const rows = ledger.listDeliveries({ limit, status, taskId });

  console.log(chalk.bold('\n  📦 交付台账\n'));
  if (rows.length === 0) {
    printInfo(
      status
        ? `没有状态为「${status}」的交付记录`
        : '暂无交付记录 —— 任务终态（完成/失败/取消）会自动入账'
    );
    console.log(chalk.dim('\n  用法: deliveries [--limit n] [--status succeeded|failed|cancelled]\n'));
    return true;
  }

  for (const r of rows) {
    const icon = STATUS_ICON[r.status] || chalk.dim('•');
    const closure = chalk.cyan(CLOSURE_LABEL[r.closure] || r.closure);
    const verdictTag =
      r.verdict === 'pass'
        ? chalk.green('[交付门:通过]')
        : r.verdict === 'fail'
          ? chalk.red('[交付门:未过]')
          : '';
    console.log(
      `  ${icon} ${chalk.dim(_fmtTime(r.ts))} ${closure} ${verdictTag} ` +
        `${chalk.dim(r.source)}${r.iterations ? chalk.dim(` · ${r.iterations} 轮`) : ''}` +
        `${r.toolCalls ? chalk.dim(` · ${r.toolCalls} 工具`) : ''}`
    );
    if (r.task) {
      console.log(`     ${r.task}`);
    }
    if (r.error) {
      console.log(`     ${chalk.red('失败原因:')} ${r.error}`);
    }
    if (Array.isArray(r.gaps) && r.gaps.length > 0) {
      console.log(`     ${chalk.yellow('缺口:')}`);
      for (const gap of r.gaps) {
        console.log(`       - ${gap}`);
      }
    }
    if (r.summary) {
      console.log(`     ${chalk.dim(r.summary)}`);
    }
    if (r.taskId) {
      console.log(`     ${chalk.dim(`taskId: ${r.taskId}`)}`);
    }
  }
  console.log(
    chalk.dim(
      `\n  共 ${rows.length} 条${status ? `（status=${status}）` : ''} · 用法: deliveries stats 查看台账位置\n`
    )
  );
  return true;
}

module.exports = { handleDeliveries };
