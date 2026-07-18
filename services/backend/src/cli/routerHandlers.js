'use strict';

const path = require('path');

function createRouterHandlers({ fmt, chk, symResolver }) {
  async function resolveArg0(args) {
    if (!args[0]) return args[0];
    const result = await symResolver().resolveSymbol(args[0]);
    if (result.matched && result.symbol !== args[0]) {
      fmt().printInfo(`${args[0]} → ${result.symbol} (${result.name})`);
      if (result.alternatives) {
        fmt().printInfo(`其他匹配: ${result.alternatives.join(', ')}`);
      }
    }
    return result.symbol;
  }

  async function handleLogCommand(subCommand, args, options) {
    const { printError, printSuccess, printInfo } = fmt();
    const chalk = chk();
    const fs = require('fs');
    const logsDir = path.join(process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..'), 'logs');
    const errorLogPath = path.join(logsDir, 'error.log');
    const combinedLogPath = path.join(logsDir, 'combined.log');

    if (subCommand === 'clear') {
      try {
        if (fs.existsSync(errorLogPath)) fs.writeFileSync(errorLogPath, '');
        if (fs.existsSync(combinedLogPath)) fs.writeFileSync(combinedLogPath, '');
        printSuccess('日志已清理');
      } catch (e) { printError(`清理失败: ${e.message}`); }
      return;
    }

    const logPath = subCommand === 'tail' ? combinedLogPath : errorLogPath;
    // `--n <count>` caps how many trailing lines to show (default 20). The `||'20'`
    // idiom only guards undefined/empty — a non-numeric ('abc'), valueless (bare
    // `--n` → true), zero, or negative value slips through to parseInt as NaN/≤0,
    // and `slice(-NaN)`/`slice(-0)` degrade to `slice(0)` = the WHOLE file. Validate
    // the parsed number and fall back to 20 for anything that isn't a positive int.
    const _n = Number.parseInt(options.n, 10);
    const lines = Number.isFinite(_n) && _n > 0 ? _n : 20;

    if (!fs.existsSync(logPath)) {
      printInfo('暂无日志文件 — 系统运行正常');
      return;
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.trim().split('\n').filter(Boolean);
    const recentLines = allLines.slice(-lines);

    if (recentLines.length === 0) {
      printSuccess('日志为空 — 没有错误记录');
      return;
    }

    console.log('');
    console.log(chalk.bold(`  📋 最近 ${recentLines.length} 条${subCommand === 'tail' ? '' : '错误'}日志:`));
    console.log(chalk.dim('  ─'.repeat(25)));

    const knownFixes = {
      ECONNREFUSED: { desc: '连接被拒绝', fix: '检查目标服务是否运行', cmd: 'server start' },
      EADDRINUSE: { desc: '端口被占用', fix: '更换端口或关闭占用进程', cmd: null },
      ENOMEM: { desc: '内存不足', fix: '清理缓存或增加内存', cmd: 'cache clear' },
      SQLITE_CORRUPT: { desc: '数据库损坏', fix: '重新初始化数据库', cmd: 'db init --force' },
      MODULE_NOT_FOUND: { desc: '模块缺失', fix: '重新安装依赖', cmd: null },
      ETIMEOUT: { desc: '请求超时', fix: '检查网络或稍后重试', cmd: null },
      SequelizeConnectionError: { desc: '数据库连接失败', fix: '检查数据库服务', cmd: 'doctor' },
      'rate limit': { desc: 'API 限流', fix: '降低请求频率', cmd: null },
    };

    const suggestedFixes = new Set();

    recentLines.forEach((line) => {
      const isError = line.includes('error') || line.includes('Error') || line.includes('FATAL');
      const color = isError ? chalk.red : chalk.dim;
      const truncated = line.length > 120 ? `${line.slice(0, 120)}...` : line;
      console.log(`  ${color(truncated)}`);

      for (const [pattern, info] of Object.entries(knownFixes)) {
        if (line.includes(pattern)) {
          suggestedFixes.add(info);
        }
      }
    });

    if (suggestedFixes.size > 0) {
      console.log('');
      console.log(chalk.yellow.bold('  💡 建议修复措施:'));
      let fixIdx = 1;
      for (const fix of suggestedFixes) {
        console.log(`  ${fixIdx}. ${chalk.yellow(fix.desc)} → ${fix.fix}${fix.cmd ? chalk.cyan(` (运行: ${fix.cmd})`) : ''}`);
        fixIdx += 1;
      }

      console.log('');
      printInfo('输入 ai on 后可以问 AI 分析完整错误原因');
    }

    console.log('');
  }

  async function handleAccountInfo() {
    const { printTable, printError } = fmt();
    const chalk = chk();
    const { bootstrap, muteDbLogs, restoreDbLogs } = require('./bootstrap');
    await bootstrap({ silent: true });
    muteDbLogs();
    const { Trade, User } = require('../models');
    restoreDbLogs();

    const cliAuth = require('../services/cliAuthService');
    const currentUser = cliAuth.getCurrentUser();
    if (!currentUser) { printError('请先登录 (login)'); return; }
    const dbUser = await User.findOne({ where: { username: currentUser.username }, raw: true });
    if (!dbUser) { printError('用户不存在'); return; }

    const trades = await Trade.findAll({ where: { user_id: dbUser.id, status: 'filled' }, raw: true });

    let totalProfit = 0;
    let positionCost = 0;
    trades.forEach((t) => {
      if (t.isClosed && t.profit) totalProfit += Number.parseFloat(t.profit);
      else if (!t.isClosed && t.side === 'buy') positionCost += Number.parseFloat(t.amount || 0);
    });

    const initial = 1000000;
    const available = initial + totalProfit - positionCost;

    printTable(
      ['项目', '金额'],
      [
        ['初始资金', `¥${initial.toLocaleString()}`],
        ['累计盈亏', (totalProfit >= 0 ? chalk.red('+') : chalk.green('')) + `¥${totalProfit.toFixed(2)}`],
        ['持仓占用', `¥${positionCost.toFixed(2)}`],
        ['可用资金', chalk.bold(`¥${available.toFixed(2)}`)],
        ['总成交笔数', String(trades.length)],
      ]
    );
  }

  async function handlePositionInfo() {
    const { printInfo, printSuccess, printTable, printError } = fmt();
    const { bootstrap, muteDbLogs, restoreDbLogs } = require('./bootstrap');
    await bootstrap({ silent: true });
    muteDbLogs();
    const { Trade, User } = require('../models');
    restoreDbLogs();

    const cliAuth = require('../services/cliAuthService');
    const currentUser = cliAuth.getCurrentUser();
    if (!currentUser) { printError('请先登录 (login)'); return; }
    const dbUser = await User.findOne({ where: { username: currentUser.username }, raw: true });
    if (!dbUser) { printError('用户不存在'); return; }

    const openTrades = await Trade.findAll({
      where: { user_id: dbUser.id, status: 'filled', isClosed: false, side: 'buy' },
      raw: true,
    });

    if (!openTrades || openTrades.length === 0) {
      printInfo('当前无持仓');
      return;
    }

    printSuccess(`当前 ${openTrades.length} 笔持仓`);
    printTable(
      ['品种', '方向', '数量', '成本价', '金额', '时间'],
      openTrades.map((t) => [
        t.symbol || '-',
        t.side || '-',
        String(t.quantity || 0),
        `¥${Number(t.price || 0).toFixed(2)}`,
        `¥${Number(t.amount || 0).toFixed(2)}`,
        t.createdAt ? new Date(t.createdAt).toLocaleDateString('zh-CN') : '-',
      ])
    );
  }

  return {
    handleAccountInfo,
    handleLogCommand,
    handlePositionInfo,
    resolveArg0,
  };
}

module.exports = {
  createRouterHandlers,
};
