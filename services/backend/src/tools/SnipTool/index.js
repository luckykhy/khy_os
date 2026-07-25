const { BaseTool } = require('../_baseTool');

class SnipTool extends BaseTool {
  static toolName = 'Snip';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['snip', 'truncate_result'];
  static searchHint = 'truncate trim tool result context window';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Replace a previous tool result with a shorter summary to free context window space.
Use when a tool result is too large and you've already extracted the needed information.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        tool_use_id: { type: 'string', description: 'The tool_use_id of the result to replace' },
        replacement: { type: 'string', description: 'Brief summary to replace the original result' },
      },
      required: ['tool_use_id', 'replacement'],
    };
  }

  async execute(params) {
    return {
      success: true,
      snipped: true,
      tool_use_id: params.tool_use_id,
      replacement: params.replacement,
    };
  }
}

module.exports = SnipTool;
