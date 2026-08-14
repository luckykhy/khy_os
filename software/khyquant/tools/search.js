const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'search',
  description: 'Search for stocks or data by keyword',
  category: 'data',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  inputSchema: {
    keyword: { type: 'string', required: true, description: 'Search keyword to filter results' },
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
