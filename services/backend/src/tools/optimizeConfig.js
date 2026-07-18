const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'optimizeConfig',
  description: 'Optimize a configuration key-value pair via the self-optimizer service',
  category: 'optimization',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,
  inputSchema: {
    key: { type: 'string', required: true, description: 'Configuration key to optimize' },
    value: { type: 'string', required: true, description: 'New value to apply' },
  },
  async execute(params, context) {
    try {
      const selfOptimizer = require('../services/selfOptimizer');
      const result = await selfOptimizer.optimize(params.key, params.value);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
