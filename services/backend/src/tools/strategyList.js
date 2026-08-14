const fs = require('fs');
const path = require('path');

const { defineTool } = require('./_baseTool');

const _backtestHandler = path.join(__dirname, '../cli/handlers/backtest.js');
let _enabled = null;

module.exports = defineTool({
  name: 'strategyList',
  description: 'List all available trading strategies',
  category: 'data',
  risk: 'safe',
  searchHint: 'trading strategies available catalog 策略列表 交易策略 可用策略',
  isReadOnly: true,
  isConcurrencySafe: true,
  isEnabled() {
    if (_enabled === null) {
      _enabled = fs.existsSync(_backtestHandler);
    }
    return _enabled;
  },
  inputSchema: {},
  async execute(params, context) {
    try {
      const { handleStrategyList } = require('../cli/handlers/backtest');
      const result = await handleStrategyList();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
