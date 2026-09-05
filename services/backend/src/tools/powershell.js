/**
 * powershell — 显式使用 PowerShell 执行命令。
 *
 * 适用场景:
 *   - 需要 PowerShell cmdlet (Get-ChildItem, Invoke-RestMethod, Where-Object 等)
 *   - 需要管道传递对象而非文本
 *   - 执行 .ps1 脚本
 *   - Windows 上默认使用 PowerShell Core (pwsh),回退到 Windows PowerShell 5.1
 *   - Linux/macOS 上需要安装 PowerShell Core (pwsh)
 */
const { defineTool } = require('./_baseTool');
const {
  executeShellCommand,
  _detectCommitInjection,
  _detectGitDestructive,
} = require('./shellCommandEngine');
const { isSearchOrReadCommand } = require('./shellClassifier');
const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
const { searchExecutable } = require('./platformUtils');

const powershellTool = defineTool({
  name: 'powershell',
  description: `Executes a command in PowerShell and returns its output.

Use when you need PowerShell-specific features: cmdlets (Get-ChildItem, Where-Object, Invoke-RestMethod), object pipelines, or .ps1 script execution.

Platform notes:
 - Windows: uses PowerShell Core (pwsh) if available, falls back to Windows PowerShell 5.1.
 - Linux/macOS: requires PowerShell Core (pwsh) installed.

Note: Windows PowerShell 5.1 does NOT support && chaining. Use ; for sequential commands or if ($?) { ... } for conditional execution.`,
  category: 'execution',
  risk: 'critical',
  searchHint: 'powershell ps cmdlet invoke script 命令行 powershell命令 ps1 windows',
  maxResultSizeChars: 20000,
  aliases: ['ps', 'pwsh'],

  isReadOnly: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  isDestructive: (input) => {
    if (!input?.command) return false;
    if (/\b(rm\s+-rf|rm\s+-r|mkfs|dd\s+if=|format\s|fdisk|wipefs|shred|Remove-Item\s+-Recurse\s+-Force)\b/i.test(input.command)) {
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
    if (process.platform === 'win32') return true;
    try {
      return !!searchExecutable('pwsh');
    } catch {
      return false;
    }
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
        'PowerShell command to execute. Supports cmdlets, pipelines, and PowerShell syntax.',
      example: 'Get-ChildItem -Path . -Recurse -File',
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
    if (!input?.command) return '执行 PowerShell 命令';
    const short = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command;
    return `运行 PowerShell：${short}`;
  },

  getToolUseSummary(input) {
    if (!input?.command) return null;
    return `PowerShell：${input.command.slice(0, 80)}`;
  },

  async execute(params, context) {
    return executeShellCommand(params, context, 'powershell');
  },
});

module.exports = powershellTool;
