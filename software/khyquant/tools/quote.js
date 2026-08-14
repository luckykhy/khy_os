const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'quote',
  description: 'Fetch real-time quote for a stock symbol',
  category: 'data',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    symbol: { type: 'string', required: true, description: 'Stock symbol (e.g. sh600519)' },
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
