const fs = require('fs');
const path = require('path');

const { defineTool } = require('./_baseTool');

const _backtestHandler = path.join(__dirname, '../cli/handlers/backtest.js');
let _enabled = null;

module.exports = defineTool({
  name: 'backtest',
  description:
    'Run a strategy backtest over historical data for a stock symbol and return performance results. ' +
    'Use it to evaluate a strategy; use dataFetch for the raw historical series. CPU-intensive — runs are serialized.',
  category: 'analysis',
  risk: 'safe',
  searchHint: 'strategy historical simulation performance returns 回测 策略 历史行情 收益',
  isReadOnly: true,
  isConcurrencySafe: false, // CPU-intensive
  isEnabled() {
    if (_enabled === null) {
      _enabled = fs.existsSync(_backtestHandler);
    }
    return _enabled;
  },
  inputSchema: {
    symbol: {
      type: 'string',
      required: true,
      description: 'Exchange-prefixed stock symbol to backtest, e.g. "sh600519".',
      example: 'sh600519',
    },
    strategy: {
      type: 'string',
      required: false,
      description: 'Strategy name to run (default: the configured default strategy).',
      example: 'ma_cross',
    },
    start: {
      type: 'string',
      required: false,
      description: 'Start date in YYYY-MM-DD format (default: earliest available).',
      example: '2024-01-01',
    },
    end: {
      type: 'string',
      required: false,
      description: 'End date in YYYY-MM-DD format (default: latest available).',
      example: '2024-12-31',
    },
    capital: {
      type: 'number',
      required: false,
      description: 'Initial capital amount for the simulation (default: strategy default).',
      example: 100000,
    },
  },
  async execute(params, context) {
    try {
      const { handleBacktestRun } = require('../cli/handlers/backtest');
      const opts = {};
      if (params.strategy) {
        opts.strategy = params.strategy;
      }
      if (params.start) {
        opts.start = params.start;
      }
      if (params.end) {
        opts.end = params.end;
      }
      if (params.capital) {
        opts.capital = params.capital;
      }
      const result = await handleBacktestRun(params.symbol, opts);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
