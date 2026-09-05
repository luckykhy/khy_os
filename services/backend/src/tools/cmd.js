/**
 * cmd — 显式使用 Windows CMD.exe 执行命令。
 *
 * 适用场景:
 *   - 需要 CMD 特有语法:batch 脚本、for /f、set 变量扩展等
 *   - 兼容旧的 .bat 脚本
 *   - 仅 Windows 平台可用
 */
const { defineTool } = require('./_baseTool');
const {
  executeShellCommand,
  _detectCommitInjection,
  _detectGitDestructive,
} = require('./shellCommandEngine');
const { isSearchOrReadCommand } = require('./shellClassifier');
const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');

const cmdTool = defineTool({
  name: 'cmd',
  description: `Executes a command in Windows CMD.exe and returns its output.

Use when you need CMD-specific syntax: batch constructs, for /f loops, CMD variable expansion (%VAR%), or .bat script compatibility.

IMPORTANT: This tool is Windows-only. On Linux/macOS it will return an error.
Use bash instead for cross-platform shell execution.

Note: CMD does NOT support && chaining. Use & for sequential commands or && (only on NT-based Windows).`,
  category: 'execution',
  risk: 'critical',
  searchHint: 'cmd batch bat dos windows 批处理 cmd命令 command prompt',
  maxResultSizeChars: 30000,

  isReadOnly: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  isDestructive: (input) => {
    if (!input?.command) return false;
    if (/\b(rm\s+-rf|rm\s+-r|mkfs|dd\s+if=|format\s|fdisk|wipefs|shred|del\s+\/s|rd\s+\/s)\b/i.test(input.command)) {
      return true;
    }
    return _detectGitDestructive(input.command).length > 0;
  },

  isConcurrencySafe: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  isEnabled: () => {
    return process.platform === 'win32';
  },

  normalizeParams(params, env) {
    try {
      return require('../services/shellTimeoutClamp').clampTimeoutParams(params, env);
    } catch {
      return params;
    }
  },

  inputSchema: {
    command: {
      type: 'string',
      required: true,
      description:
        'CMD command to execute. Supports CMD syntax: batch commands, for loops, variable expansion.',
      example: 'dir /s /b *.js',
    },
    cwd: {
      type: 'string',
      required: false,
      description:
        'Working directory for the command, relative to CWD or absolute (default: current working directory).',
      example: 'services/backend',
    },
    timeout: {
      type: 'number',
      required: false,
      max: 60000,
      description:
        'TOTAL wall-clock limit in ms (default: 60000, max 60000; higher values are clamped).',
      example: 30000,
    },
    idleTimeout: {
      type: 'number',
      required: false,
      description:
        'IDLE (no-output) limit in ms. Kills command if no output for this long.',
      example: 15000,
    },
    run_in_background: {
      type: 'boolean',
      required: false,
      description:
        'Run the command detached and return immediately. Completion reported via <task_notification>.',
      example: true,
    },
  },

  async validateInput(input) {
    if (input.command) {
      const injectionError = _detectCommitInjection(input.command);
      if (injectionError) {
        return { valid: false, message: injectionError };
      }
    }

    if (input.command) {
      const tokens = input.command.split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith('/dev/')) {
          const devCheck = validateNotDevicePath(token);
          if (!devCheck.valid) return devCheck;
        }
      }
    }

    if (input.cwd) {
      return composeValidations(validateNotUNCPath(input.cwd));
    }

    return { valid: true };
  },

  getActivityDescription(input) {
    if (!input?.command) return '执行 CMD 命令';
    const short = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command;
    return `运行 CMD：${short}`;
  },

  getToolUseSummary(input) {
    if (!input?.command) return null;
    return `CMD：${input.command.slice(0, 80)}`;
  },

  async execute(params, context) {
    return executeShellCommand(params, context, 'cmd');
  },
});

module.exports = cmdTool;
