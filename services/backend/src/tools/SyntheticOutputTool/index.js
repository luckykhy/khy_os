const { BaseTool } = require('../_baseTool');

class SyntheticOutputTool extends BaseTool {
  static toolName = 'SyntheticOutput';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['synthetic_output'];
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Inject synthetic output into the conversation, as if from a tool result.
Used internally for system messages, notifications, and context injection.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to inject' },
        source: { type: 'string', description: 'Source label for the output' },
      },
      required: ['content'],
    };
  }

  async execute(params) {
    return { success: true, content: params.content, source: params.source || 'system' };
  }
}

module.exports = SyntheticOutputTool;
