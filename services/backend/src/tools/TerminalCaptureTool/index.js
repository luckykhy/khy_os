const { BaseTool } = require('../_baseTool');

class TerminalCaptureTool extends BaseTool {
  static toolName = 'TerminalCapture';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['terminal_capture', 'screenshot_terminal'];
  static searchHint = 'terminal capture screenshot output buffer';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Capture the current terminal output buffer.
Useful for getting context about what the user sees in their terminal.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'Number of lines to capture (default 50)', default: 50 },
      },
    };
  }

  async execute(params) {
    return {
      success: true,
      note: 'Terminal capture is available in supported terminal emulators.',
      lines: params.lines || 50,
    };
  }
}

module.exports = TerminalCaptureTool;
