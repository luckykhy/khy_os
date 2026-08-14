const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');

const _backtestHandler = path.join(__dirname, '../cli/handlers/backtest.js');
let _enabled = null;

module.exports = defineTool({
  name: 'backtest',
  description: 'Run a backtest for a given symbol and strategy',
  category: 'analysis',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: false, // CPU-intensive
  isEnabled() {
    if (_enabled === null) _enabled = fs.existsSync(_backtestHandler);
    return _enabled;
  },
  inputSchema: {
    symbol: { type: 'string', required: true, description: 'Stock symbol to backtest' },
    strategy: { type: 'string', required: false, description: 'Strategy name' },
    start: { type: 'string', required: false, description: 'Start date (YYYY-MM-DD)' },
    end: { type: 'string', required: false, description: 'End date (YYYY-MM-DD)' },
    capital: { type: 'number', required: false, description: 'Initial capital amount' },
  },
  async execute(params, context) {
    try {
      const { handleBacktestRun } = require('../cli/handlers/backtest');
      const opts = {};
      if (params.strategy) opts.strategy = params.strategy;
      if (params.start) opts.start = params.start;
      if (params.end) opts.end = params.end;
      if (params.capital) opts.capital = params.capital;
      const result = await handleBacktestRun(params.symbol, opts);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
