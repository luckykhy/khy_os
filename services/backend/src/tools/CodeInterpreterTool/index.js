const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class CodeInterpreterTool extends BaseTool {
  static toolName = 'CodeInterpreter';
  static category = 'execution';
  static risk = 'high';
  static aliases = ['code_exec', 'run_code', 'execute_code'];
  static searchHint = 'code execution sandbox python javascript';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Execute code in a sandboxed environment.

Supported languages:
- "python" — Python 3
- "javascript" / "js" — Node.js
- "bash" / "shell" — Shell commands

Code runs in isolation with timeout and resource limits.
Returns stdout output or error messages.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Code to execute',
        },
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'js', 'bash', 'shell'],
          description: 'Programming language (default: python)',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000)',
          minimum: 1000,
          maximum: 120000,
        },
      },
      required: ['code'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeout,
      envKey: 'KHY_CODE_INTERPRETER_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 120000,
    });

    try {
      const sandbox = require('../../services/sandbox');

      if (!sandbox.isAvailable()) {
        return { success: false, error: 'Sandbox not available. Install Docker for secure execution.' };
      }

      const result = await withDeadline(
        () => sandbox.executeCode(params.code, {
          language: params.language || 'python',
          timeout: timeoutMs,
        }),
        timeoutMs + 5000
      );

      if (result?.__timedOut) {
        return { success: false, error: `Code execution timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Code execution error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `执行代码：${input.code?.slice(0, 40) || ''}`;
  }
}

module.exports = CodeInterpreterTool;
