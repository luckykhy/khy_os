/**
 * bash — 显式使用 bash shell 执行命令。
 *
 * 适用场景:
 *   - 需要 bash 特有语法:数组、[[ ]] 测试、进程替换、brace expansion 等
 *   - Linux/macOS 上默认 /bin/bash
 *   - Windows 上要求 Git Bash (MSYS2/MINGW)
 *
 * 与 shellCommand 的区别:
 *   - shellCommand 使用平台默认 shell(Windows 可能是 cmd/PowerShell)
 *   - bash 始终使用 bash,提供一致的 POSIX 语义
 */
const fs = require('fs');
const { defineTool } = require('./_baseTool');
const {
  executeShellCommand,
  isShellAvailable,
  _detectCommitInjection,
  _detectGitDestructive,
} = require('./shellCommandEngine');
const { isSearchOrReadCommand } = require('./shellClassifier');
const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
const { findGitBashPath } = require('./platformUtils');

const bashTool = defineTool({
  name: 'bash',
  description: `Executes a command in bash shell and returns its output.

Use when you need bash-specific syntax (arrays, [[ ]] tests, process substitution, brace expansion, etc.) or want consistent POSIX semantics across platforms.

Platform notes:
 - Linux/macOS: uses /bin/bash (falls back to /bin/sh if bash unavailable).
 - Windows: requires Git Bash (installed with Git for Windows). If Git Bash is not available, the tool will return an error.

For platform-default shell execution without bash requirement, use shellCommand instead.`,
  category: 'execution',
  risk: 'critical',
  searchHint: 'bash shell command linux unix sh 执行命令 命令行 bash命令 git bash msys',
  maxResultSizeChars: 20000,
  aliases: ['sh', 'shell'],

  isReadOnly: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  isDestructive: (input) => {
    if (!input?.command) return false;
    if (/\b(rm\s+-rf|rm\s+-r|mkfs|dd\s+if=|format\s|fdisk|wipefs|shred)\b/i.test(input.command)) {
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
    if (process.platform === 'win32') {
      try {
        return !!findGitBashPath();
      } catch {
        return false;
      }
    }
    return fs.existsSync('/bin/bash') || fs.existsSync('/bin/sh');
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
        'Bash command to execute. Supports bash syntax: arrays, [[ ]], process substitution, etc.',
      example: 'ls -la',
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
    if (!input?.command) return '执行 Bash 命令';
    const short = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command;
    return `运行 bash：${short}`;
  },

  getToolUseSummary(input) {
    if (!input?.command) return null;
    return `Bash：${input.command.slice(0, 80)}`;
  },

  async execute(params, context) {
    return executeShellCommand(params, context, 'bash');
  },
});

module.exports = bashTool;
