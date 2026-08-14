const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'dataFetch',
  description: 'Fetch historical market data for a symbol',
  category: 'data',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    symbol: { type: 'string', required: true, description: 'Stock symbol to fetch data for' },
    period: { type: 'string', required: false, enum: ['daily', 'weekly', 'monthly'], description: 'Data period' },
  },
  async execute(params, context) {
    try {
      const { handleDataFetch } = require('../cli/handlers/data');
      const opts = {};
      if (params.period) opts.period = params.period;
      const result = await handleDataFetch(params.symbol, opts);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
