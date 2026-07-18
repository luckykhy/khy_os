const { BaseTool } = require('../_baseTool');
const vm = require('vm');

class REPLTool extends BaseTool {
  static toolName = 'REPL';
  static category = 'execution';
  static risk = 'medium';
  static aliases = ['repl', 'eval', 'node_repl'];
  static searchHint = 'evaluate javascript node repl execute code';
  static shouldDefer = true;

  isConcurrencySafe() { return false; }

  prompt() {
    return `Execute JavaScript code in a sandboxed Node.js REPL.
Useful for quick calculations, data transformations, and testing snippets.
The REPL has access to Node.js built-in modules.
Each execution gets a fresh context.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
        timeout: { type: 'number', description: 'Execution timeout in ms (default 10000)', default: 10000 },
      },
      required: ['code'],
    };
  }

  async execute(params) {
    const timeout = Math.min(params.timeout || 10000, 60000);
    const output = [];

    const sandbox = {
      console: {
        log: (...args) => output.push(args.map(String).join(' ')),
        error: (...args) => output.push('[stderr] ' + args.map(String).join(' ')),
        warn: (...args) => output.push('[warn] ' + args.map(String).join(' ')),
      },
      require: require,
      Buffer,
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      process: { env: process.env, cwd: process.cwd, platform: process.platform },
    };

    try {
      const ctx = vm.createContext(sandbox);
      const result = vm.runInContext(params.code, ctx, { timeout, filename: 'repl.js' });
      return {
        success: true,
        result: result !== undefined ? String(result) : undefined,
        stdout: output.join('\n') || undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        stdout: output.length > 0 ? output.join('\n') : undefined,
      };
    }
  }

  getActivityDescription() { return '执行 REPL 代码'; }
}

module.exports = REPLTool;
