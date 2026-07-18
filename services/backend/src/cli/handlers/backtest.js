/**
 * Backtest CLI handlers: backtest run, backtest list, strategy list.
 */
const fs = require('fs');
const path = require('path');
const { bootstrap, muteDbLogs, restoreDbLogs } = require('../bootstrap');
const { printBacktestResult, printTable, printSuccess, printError, withSpinner } = require('../formatters');

// Built-in strategies that work universally (stocks, futures, ETFs)
const BUILTIN_STRATEGIES = {
  ma_cross: {
    name: '均线交叉策略 (MA5×MA20)',
    code: `if (i < 20) return null;
let ma5 = 0, ma20 = 0;
for (let j = i - 4; j <= i; j++) ma5 += bars[j].close;
for (let j = i - 19; j <= i; j++) ma20 += bars[j].close;
ma5 /= 5; ma20 /= 20;
let pma5 = 0, pma20 = 0;
for (let j = i - 5; j <= i - 1; j++) pma5 += bars[j].close;
for (let j = i - 20; j <= i - 1; j++) pma20 += bars[j].close;
pma5 /= 5; pma20 /= 20;
if (pma5 <= pma20 && ma5 > ma20) return 'buy';
if (pma5 >= pma20 && ma5 < ma20) return 'sell';
return null;`,
  },
  rsi: {
    name: 'RSI反转策略 (RSI14)',
    code: `if (i < 15) return null;
let gains = 0, losses = 0;
for (let j = i - 13; j <= i; j++) {
  const d = bars[j].close - bars[j-1].close;
  if (d > 0) gains += d; else losses -= d;
}
const rs = losses === 0 ? 100 : gains / losses;
const rsi = 100 - 100 / (1 + rs);
if (rsi < 30) return 'buy';
if (rsi > 70) return 'sell';
return null;`,
  },
  macd: {
    name: 'MACD动量策略',
    code: `if (i < 35) return null;
function ema(data, period, end) {
  let k = 2 / (period + 1), val = data[0].close;
  for (let j = 1; j <= end; j++) val = data[j].close * k + val * (1 - k);
  return val;
}
const dif = ema(bars, 12, i) - ema(bars, 26, i);
const pdif = ema(bars, 12, i-1) - ema(bars, 26, i-1);
if (pdif <= 0 && dif > 0) return 'buy';
if (pdif >= 0 && dif < 0) return 'sell';
return null;`,
  },
};

async function handleBacktestRun(symbol, options = {}) {
  try {
    await bootstrap({ silent: true });
  } catch (bootErr) {
    printError(`数据库初始化失败: ${bootErr.message}`);
    return;
  }

  // Mute module-level logs from backtestEngine → klineDataService → pythonPath
  muteDbLogs();
  let backtestEngine, Strategy;
  try {
    backtestEngine = require('../../services/backtestEngine');
    ({ Strategy } = require('../../models'));
  } catch (reqErr) {
    restoreDbLogs();
    printError(`加载回测模块失败: ${reqErr.message}`);
    return;
  }
  restoreDbLogs();

  // Resolve strategy code
  let signalFn;
  let strategyName = 'custom';
  const strategyRef = options.strategy;

  if (strategyRef) {
    // Built-in strategy name (ma_cross, rsi, macd)
    if (BUILTIN_STRATEGIES[strategyRef]) {
      signalFn = BUILTIN_STRATEGIES[strategyRef].code;
      strategyName = BUILTIN_STRATEGIES[strategyRef].name;
    // Numeric ID → load from database
    } else if (/^\d+$/.test(strategyRef)) {
      const dbStrategy = await Strategy.findByPk(parseInt(strategyRef));
      if (!dbStrategy) {
        printError(`策略 ID ${strategyRef} 不存在`);
        return;
      }
      signalFn = dbStrategy.code;
      strategyName = dbStrategy.name;
    } else if (fs.existsSync(path.resolve(strategyRef))) {
      // File path → read file
      const filePath = path.resolve(strategyRef);
      signalFn = fs.readFileSync(filePath, 'utf-8');
      strategyName = path.basename(filePath, path.extname(filePath));
    } else {
      printError(`策略 "${strategyRef}" 不存在（非数字ID、非内置策略名、非文件路径）`);
      const chalk = require('chalk').default || require('chalk');
      console.log(chalk.dim('  内置策略: ma_cross, rsi, macd'));
      console.log(chalk.dim('  示例: backtest 比亚迪 --strategy ma_cross'));
      return;
    }
  } else {
    // Default: load first strategy from DB
    const first = await Strategy.findOne({ order: [['id', 'ASC']] });
    if (first) {
      signalFn = first.code;
      strategyName = first.name;
    } else {
      // No DB strategies — use built-in MA crossover as default
      signalFn = BUILTIN_STRATEGIES.ma_cross.code;
      strategyName = BUILTIN_STRATEGIES.ma_cross.name;
    }
  }

  const startDate = options.start || '2024-01-01';
  const endDate = options.end || new Date().toISOString().slice(0, 10);
  const initialCapital = parseInt(options.capital) || 100000;

  console.log(`  策略: ${strategyName}`);

  let result;
  try {
    result = await withSpinner(
      `回测 ${symbol} (${startDate} → ${endDate})...`,
      () => backtestEngine.run({ symbol, startDate, endDate, initialCapital, signalFn }),
      { muteOutput: true }
    );
  } catch (runErr) {
    printError(`回测执行失败: ${runErr.message}`);
    const chalk = require('chalk').default || require('chalk');
    console.log(chalk.dim(`  ${runErr.stack?.split('\n')[1]?.trim() || ''}`));
    return;
  }

  printBacktestResult(result);

  // Hint when strategy produced no trades — auto-retry with fallback
  if (!result.trades || result.trades.length === 0) {
    const chalk = require('chalk').default || require('chalk');
    console.log(chalk.yellow('  ⚠ 该策略在此区间内未产生任何交易信号'));
    console.log(chalk.dim(`    策略 "${strategyName}" 可能与该品种不兼容`));

    // Auto-retry with MA crossover if we weren't already using it
    const usedBuiltinMA = signalFn === BUILTIN_STRATEGIES.ma_cross.code;
    if (!usedBuiltinMA && !options.noFallback) {
      console.log(chalk.cyan('  → 自动使用内置均线策略重试...'));
      const fallbackResult = await withSpinner(
        `均线策略回测 ${symbol}...`,
        () => backtestEngine.run({ symbol, startDate, endDate, initialCapital, signalFn: BUILTIN_STRATEGIES.ma_cross.code }),
        { muteOutput: true }
      );
      if (fallbackResult.trades && fallbackResult.trades.length > 0) {
        console.log(chalk.green(`  ✓ 均线交叉策略产生了 ${fallbackResult.trades.length} 笔交易:`));
        printBacktestResult(fallbackResult);
      } else {
        console.log(chalk.dim('    均线策略同样无信号 — 可能是数据区间过短或数据源问题'));
      }
    }
    console.log(chalk.dim('    可用内置策略: backtest <代码> --strategy ma_cross|rsi|macd'));
  }

  // Print trade log if verbose
  if (options.verbose && result.trades && result.trades.length > 0) {
    const chalk = require('chalk').default || require('chalk');
    console.log(chalk.bold('  交易记录'));
    printTable(
      ['日期', '方向', '价格', '数量', '盈亏'],
      result.trades.map(t => [
        t.date || '-',
        t.side === 'buy' ? chalk.red('买入') : chalk.green('卖出'),
        '¥' + Number(t.price).toFixed(2),
        String(t.quantity),
        t.profit !== undefined ? (t.profit >= 0 ? '+' : '') + Number(t.profit).toFixed(2) : '-',
      ])
    );
  }
}

async function handleBacktestList(options = {}) {
  await bootstrap({ silent: true });

  const { Backtest } = require('../../models');
  const limit = parseInt(options.limit) || 20;

  const where = {};
  if (options.status) where.status = options.status;

  const backtests = await Backtest.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    raw: true,
  });

  if (!backtests || backtests.length === 0) {
    printError('暂无回测记录');
    return;
  }

  printSuccess(`共 ${backtests.length} 条回测记录`);
  printTable(
    ['ID', '名称', '品种', '状态', '收益率', '夏普', '创建时间'],
    backtests.map(b => [
      String(b.id),
      (b.name || '-').substring(0, 16),
      b.symbol || '-',
      b.status || '-',
      b.totalReturn !== undefined ? b.totalReturn + '%' : '-',
      b.sharpeRatio !== undefined ? String(b.sharpeRatio) : '-',
      b.created_at ? new Date(b.created_at).toLocaleDateString('zh-CN') : '-',
    ])
  );
}

async function handleStrategyList() {
  await bootstrap({ silent: true });

  const { Strategy } = require('../../models');

  const strategies = await Strategy.findAll({
    order: [['id', 'ASC']],
    raw: true,
  });

  // Always show built-in strategies
  const chalk = require('chalk').default || require('chalk');
  console.log(chalk.bold('  内置策略 (无需数据库)'));
  printTable(
    ['名称', '标识', '适用品种', '说明'],
    [
      ['均线交叉 MA5×MA20', 'ma_cross', '通用', '经典趋势跟踪'],
      ['RSI反转 RSI14', 'rsi', '通用', '超买超卖反转'],
      ['MACD动量', 'macd', '通用', 'DIF零轴穿越'],
    ]
  );
  console.log(chalk.dim('  使用: backtest <代码> --strategy ma_cross'));

  if (strategies && strategies.length > 0) {
    console.log('');
    printSuccess(`数据库策略 (${strategies.length} 个)`);
    printTable(
      ['ID', '名称', '语言', '类型', '状态'],
      strategies.map(s => [
        String(s.id),
        (s.name || '-').substring(0, 20),
        s.language || 'javascript',
        s.type || '-',
        s.status || 'active',
      ])
    );
  } else {
    console.log(chalk.dim('\n  数据库无自定义策略。运行 db seed 可导入更多'));
  }
}

module.exports = { handleBacktestRun, handleBacktestList, handleStrategyList };
