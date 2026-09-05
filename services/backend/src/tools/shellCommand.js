/**
 * shellCommand — 平台默认 shell 执行工具。
 *
 * 通过 shellCommandEngine 执行,不显式指定 shell(使用平台默认)。
 * 这是向后兼容的入口,新代码可直接使用 bash / powershell / cmd 工具。
 */
const { defineTool } = require('./_baseTool');
const {
  executeShellCommand,
  _detectCommitInjection,
  _multiCommandBlock,
} = require('./shellCommandEngine');
const { isSearchOrReadCommand, getBaseCommand } = require('./shellClassifier');
const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
const { buildToolAvoidanceBlock: _buildToolAvoidanceBlock } = require('../constants/shellTransparency');

let _adaptiveOutput;
try {
  _adaptiveOutput = require('../services/adaptiveOutput');
} catch {
  _adaptiveOutput = null;
}

const shellCommandTool = defineTool({
  name: 'shellCommand',
  description: `Executes a given shell command and returns its output.

${_buildToolAvoidanceBlock()}

# Instructions
 - Prefer dedicated tools over this tool whenever possible. Use shell execution only when you genuinely need a process, shell syntax, or a command-line program.
 - Always quote file paths that contain spaces with double quotes.
 - You may specify an optional timeout in milliseconds (max 60000).
 - Choose the narrowest sufficient command or check. Prefer targeted tests, focused builds, and scoped inspection commands before wider repo-wide commands.
 - Before running a mutating command, assess reversibility and scope. Confirm with the user if it is destructive, production-facing, or affects shared state unless they already requested it explicitly.
 - For builds, tests, installs, and other potentially long-running commands, tell the user what is being run, watch concrete progress, and avoid assuming a fixed completion time.
  - If a command fails, inspect the exit code and stderr before retrying. Change the approach instead of looping on the same failure.
  - After 2-3 adjusted attempts on the same failing command path, stop and report what you tried, the error observed, the likely cause, and the next fallback option.
  - Prefer root-cause fixes over command-line band-aids. If one attempted fix creates a different failure, re-evaluate before piling on more commands.
  - When reporting output, surface the important lines and summarize noisy logs instead of pasting everything verbatim.
  - Do not jump to a broader command like a full test suite, full build, or repo-wide scan if a narrower command can already prove the result with similar confidence.
  - On Windows, prefer syntax compatible with the active shell and do not assume PowerShell 7-only features are available.
${_multiCommandBlock()}

# Git Safety
 - NEVER update the git config.
 - NEVER run destructive git commands (push --force, reset --hard, checkout ., clean -f, branch -D) unless the user explicitly requests it.
 - NEVER skip hooks (--no-verify) unless the user explicitly requests it.
 - Prefer creating NEW commits over amending existing ones.
 - Before running destructive operations, consider safer alternatives.

# Dangerous Commands
 - Be cautious with rm -rf, mkfs, dd, format, fdisk — these are irreversible.
 - Confirm with user before running destructive commands on shared systems.`,
  category: 'execution',
  risk: 'critical',
  searchHint: 'shell command bash terminal cmd run execute 执行命令 终端 命令行',

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
    const { _detectGitDestructive } = require('./shellCommandEngine');
    return _detectGitDestructive(input.command).length > 0;
  },

  isConcurrencySafe: (input) => {
    if (!input?.command) return false;
    const { isSearch, isRead, isList } = isSearchOrReadCommand(input.command);
    return isSearch || isRead || isList;
  },

  maxResultSizeChars: 20000,

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
        'Shell command line to execute, e.g. "npm test". Quote paths containing spaces with double quotes.',
      example: 'npm test',
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
        'TOTAL wall-clock limit in ms: the command is killed when this elapses regardless of output (default: 60000, max 60000; higher values are clamped).',
      example: 30000,
    },
    idleTimeout: {
      type: 'number',
      required: false,
      description:
        'IDLE (no-output) limit in ms, distinct from timeout: the command is killed if it produces no output for this long even if the total timeout has not elapsed (default: same as timeout). Use for commands that may hang silently (network calls, prompts).',
      example: 15000,
    },
    run_in_background: {
      type: 'boolean',
      required: false,
      description:
        'Run the command detached and return immediately (default: false). Use for slow operations ' +
        '(installs, builds, long test suites, dev servers). Completion is reported later via a ' +
        '<task_notification> block — do NOT poll.',
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
    if (!input?.command) return '执行 Shell 命令';
    const short = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command;
    return `运行命令：${short}`;
  },

  getToolUseSummary(input) {
    if (!input?.command) return null;
    return `Shell：${input.command.slice(0, 80)}`;
  },

  async execute(params, context) {
    return executeShellCommand(params, context, null);
  },
});

module.exports = shellCommandTool;
