const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'quote',
  description:
    'Fetch the real-time market quote (price, change, volume) for a single stock symbol. ' +
    'Use it for current-price questions; use dataFetch for historical series and search to resolve a name to a symbol first.',
  category: 'data',
  risk: 'safe',
  searchHint: 'stock realtime price market ticker 股票 实时行情 报价 现价',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    symbol: {
      type: 'string',
      required: true,
      description: 'Exchange-prefixed stock symbol, e.g. "sh600519" or "sz000001".',
      example: 'sh600519',
    },
  },
  async execute(params, context) {
    try {
      const { handleQuote } = require('../cli/handlers/data');
      const result = await handleQuote(params.symbol);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
