const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'dataFetch',
  description:
    'Fetch the historical OHLCV market-data series for a stock symbol at daily/weekly/monthly granularity. ' +
    'Use it for backtesting inputs and trend analysis; use quote for the current real-time price instead.',
  category: 'data',
  risk: 'safe',
  searchHint: 'stock market history ohlcv kline candlestick daily 行情 历史数据 K线',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    symbol: {
      type: 'string',
      required: true,
      description: 'Exchange-prefixed stock symbol to fetch history for, e.g. "sh600519".',
      example: 'sh600519',
    },
    period: {
      type: 'string',
      required: false,
      enum: ['daily', 'weekly', 'monthly'],
      description: 'Bar granularity: daily, weekly or monthly (default: daily).',
      example: 'daily',
    },
  },
  async execute(params, context) {
    try {
      const { handleDataFetch } = require('../cli/handlers/data');
      const opts = {};
      if (params.period) {
        opts.period = params.period;
      }
      const result = await handleDataFetch(params.symbol, opts);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
