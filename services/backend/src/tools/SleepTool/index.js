const { BaseTool } = require('../_baseTool');

class SleepTool extends BaseTool {
  static toolName = 'Sleep';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['sleep', 'wait'];
  static searchHint = 'wait duration pause timer';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Wait for a specified duration. The user can interrupt the sleep at any time.
Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.
Prefer this over \`Bash(sleep ...)\` — it doesn't hold a shell process.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        duration: { type: 'number', description: 'Duration in seconds to sleep (1-300)', minimum: 1, maximum: 300 },
      },
      required: ['duration'],
    };
  }

  async execute(params) {
    const duration = Math.min(Math.max(params.duration || 10, 1), 300);
    const start = Date.now();
    await new Promise(resolve => setTimeout(resolve, duration * 1000));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return { success: true, sleptFor: `${elapsed}s`, requested: `${duration}s` };
  }

  getActivityDescription(input) { return `等待 ${input.duration || 10} 秒`; }
}

module.exports = SleepTool;
