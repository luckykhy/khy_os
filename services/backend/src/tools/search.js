const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'search',
  description:
    'Search the local market-data catalog for stocks/instruments by keyword and return matching entries. ' +
    'Use it to resolve a company name or partial code to a tradable symbol before calling quote/dataFetch; do NOT use it for web searches (use webSearch) or file content (use grep).',
  category: 'data',
  risk: 'safe',
  searchHint: 'stock instrument symbol lookup market catalog resolve 股票查询 代码查找 证券',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    keyword: {
      type: 'string',
      required: true,
      description: 'Keyword to match against instrument names/codes, e.g. "茅台" or "600519".',
      example: '600519',
    },
  },
  async execute(params, context) {
    try {
      const { handleDataList } = require('../cli/handlers/data');
      const result = await handleDataList(params.keyword);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
