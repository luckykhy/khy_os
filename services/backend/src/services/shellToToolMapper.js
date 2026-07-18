'use strict';

/**
 * shellToToolMapper.js — Maps shell commands to virtual tool permissions.
 *
 * Bridges the gap between shell command execution and the tool permission
 * system by mapping each command segment to a virtual tool with risk/readOnly
 * properties. For compound commands (pipes, &&, ;), takes the strictest
 * permission level across all segments.
 *
 * Key features:
 *   1. Shell command → virtual tool name mapping
 *   2. Compound command → strictest-wins aggregation
 *   3. Command substitution ($() / ``) detection
 *   4. Git subcommand awareness (git status=safe, git push=medium)
 */

const {
  splitCommandWithOperators,
  getBaseCommand,
  SEARCH_COMMANDS,
  READ_COMMANDS,
  LIST_COMMANDS,
  NEUTRAL_COMMANDS,
  SILENT_COMMANDS,
} = require('../tools/shellClassifier');

// ── Risk severity ordering ─────────────────────────────────────────
// Single source of truth: zero-dependency leaf constants/riskOrder.js.
const { RISK_ORDER } = require('../constants/riskOrder');

function maxRisk(a, b) {
  return (RISK_ORDER[a] || 0) >= (RISK_ORDER[b] || 0) ? a : b;
}

// ── Command → Virtual Tool Mapping ─────────────────────────────────

// Read-like commands → virtual read_file
const READ_TOOL_COMMANDS = new Set([
  ...READ_COMMANDS,    // cat, head, tail, less, more, wc, stat, file, strings, jq, awk, cut, sort, uniq, tr
]);

// Search-like commands → virtual grep
const SEARCH_TOOL_COMMANDS = new Set([
  ...SEARCH_COMMANDS,  // find, grep, rg, ag, ack, locate, which, whereis
]);

// List-like commands → virtual glob
const LIST_TOOL_COMMANDS = new Set([
  ...LIST_COMMANDS,    // ls, dir, tree, du, df
]);

// Info/status commands → safe, read-only
const INFO_COMMANDS = new Set([
  'pwd', 'whoami', 'hostname', 'uname', 'date', 'uptime', 'id',
  'env', 'printenv', 'set', 'type', 'command',
]);

// Destructive commands → high risk
const DESTRUCTIVE_COMMANDS = new Set([
  'rm', 'rmdir', 'mv', 'chmod', 'chown', 'chgrp', 'ln',
]);

// Critical system commands
const CRITICAL_COMMANDS = new Set([
  'reboot', 'shutdown', 'halt', 'poweroff', 'init',
  'mkfs', 'fdisk', 'parted', 'dd',
  'kill', 'killall', 'pkill',
]);

// Write commands → medium risk
const WRITE_COMMANDS = new Set([
  'tee', 'touch', 'mkdir', 'install', 'cp',
]);

// Package manager commands → medium risk
const PACKAGE_COMMANDS = new Set([
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'apt', 'apt-get', 'yum',
  'dnf', 'pacman', 'brew', 'cargo', 'go',
]);

// Git subcommand classification
const GIT_READONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'stash', 'describe', 'shortlog', 'reflog', 'blame', 'bisect',
  'ls-files', 'ls-tree', 'ls-remote',
]);

const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'merge', 'rebase', 'cherry-pick', 'pull',
  'fetch', 'clone', 'init', 'checkout', 'switch', 'restore',
]);

const GIT_DANGEROUS_SUBCOMMANDS = new Set([
  'push', 'reset', 'clean', 'gc', 'filter-branch',
]);

// ── Command substitution detection ─────────────────────────────────

const CMD_SUBST_RE = /\$\(|`[^`]*`/;

/**
 * Detect command substitution ($() or backticks) in a raw command string.
 * @param {string} command
 * @returns {boolean}
 */
function hasCommandSubstitution(command) {
  if (!command || typeof command !== 'string') return false;
  return CMD_SUBST_RE.test(command);
}

// ── Single command mapping ─────────────────────────────────────────

/**
 * Map a single command (no pipes/operators) to a virtual tool.
 *
 * @param {string} cmd - Single shell command
 * @returns {{ tool: string, risk: string, isReadOnly: boolean, isDestructive: boolean, command: string }}
 */
function mapSingleCommand(cmd) {
  const base = getBaseCommand(cmd);
  if (!base) {
    return { tool: 'shell_command', risk: 'low', isReadOnly: false, isDestructive: false, command: cmd };
  }

  const lower = base.toLowerCase();

  // Git — subcommand-aware
  if (lower === 'git') {
    return _mapGitCommand(cmd, base);
  }

  // Read-like → read_file
  if (READ_TOOL_COMMANDS.has(lower)) {
    return { tool: 'read_file', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  // Search-like → grep
  if (SEARCH_TOOL_COMMANDS.has(lower)) {
    return { tool: 'grep', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  // List-like → glob
  if (LIST_TOOL_COMMANDS.has(lower)) {
    return { tool: 'glob', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  // Info commands → safe
  if (INFO_COMMANDS.has(lower)) {
    return { tool: 'shell_command', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  // Neutral → safe
  if (NEUTRAL_COMMANDS.has(lower)) {
    return { tool: 'shell_command', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  // Critical system commands
  if (CRITICAL_COMMANDS.has(lower)) {
    return { tool: 'shell_command', risk: 'critical', isReadOnly: false, isDestructive: true, command: cmd };
  }

  // Destructive commands
  if (DESTRUCTIVE_COMMANDS.has(lower)) {
    return { tool: 'shell_command', risk: 'high', isReadOnly: false, isDestructive: true, command: cmd };
  }

  // Write commands
  if (WRITE_COMMANDS.has(lower)) {
    return { tool: 'write_file', risk: 'medium', isReadOnly: false, isDestructive: false, command: cmd };
  }

  // Package managers
  if (PACKAGE_COMMANDS.has(lower)) {
    return { tool: 'shell_command', risk: 'medium', isReadOnly: false, isDestructive: false, command: cmd };
  }

  // Unknown command → default medium
  return { tool: 'shell_command', risk: 'medium', isReadOnly: false, isDestructive: false, command: cmd };
}

/**
 * Map a git command with subcommand awareness.
 * @param {string} cmd - Full git command
 * @param {string} base - 'git'
 * @returns {{ tool: string, risk: string, isReadOnly: boolean, isDestructive: boolean, command: string }}
 */
function _mapGitCommand(cmd) {
  const tokens = cmd.trim().split(/\s+/);
  // Find the first token after 'git' that isn't a flag
  let subCmd = '';
  for (let i = 1; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) {
      subCmd = tokens[i].toLowerCase();
      break;
    }
  }

  if (!subCmd) {
    return { tool: 'shell_command', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  if (GIT_READONLY_SUBCOMMANDS.has(subCmd)) {
    return { tool: 'git_status', risk: 'safe', isReadOnly: true, isDestructive: false, command: cmd };
  }

  if (GIT_WRITE_SUBCOMMANDS.has(subCmd)) {
    return { tool: 'shell_command', risk: 'medium', isReadOnly: false, isDestructive: false, command: cmd };
  }

  if (GIT_DANGEROUS_SUBCOMMANDS.has(subCmd)) {
    // Check for --force flag
    const hasForce = tokens.some(t => t === '--force' || t === '-f' || t === '--force-with-lease');
    if (subCmd === 'push' && hasForce) {
      return { tool: 'shell_command', risk: 'critical', isReadOnly: false, isDestructive: true, command: cmd };
    }
    if (subCmd === 'reset' && tokens.includes('--hard')) {
      return { tool: 'shell_command', risk: 'critical', isReadOnly: false, isDestructive: true, command: cmd };
    }
    return { tool: 'shell_command', risk: 'high', isReadOnly: false, isDestructive: true, command: cmd };
  }

  // Unknown git subcommand → medium
  return { tool: 'shell_command', risk: 'medium', isReadOnly: false, isDestructive: false, command: cmd };
}

// ── Compound command mapping ───────────────────────────────────────

const OPERATORS = new Set(['|', '||', '&&', ';']);
const REDIRECT_OPS = new Set(['>', '>>', '2>', '2>>', '&>', '&>>']);

/**
 * Map a full shell command (including pipes, &&, ;) to virtual tools.
 * For compound commands, takes the strictest permission level.
 *
 * @param {string} command - Full shell command string
 * @returns {{
 *   virtualTools: Array<{ tool, risk, isReadOnly, isDestructive, command }>,
 *   overallRisk: string,
 *   overallReadOnly: boolean,
 *   overallDestructive: boolean,
 *   hasCommandSubstitution: boolean
 * }}
 */
function mapCommandToVirtualTools(command) {
  const empty = {
    virtualTools: [],
    overallRisk: 'medium',
    overallReadOnly: false,
    overallDestructive: false,
    hasCommandSubstitution: false,
  };

  if (!command || typeof command !== 'string') return empty;

  const hasCmdSubst = hasCommandSubstitution(command);

  const parts = splitCommandWithOperators(command);
  if (parts.length === 0) return { ...empty, hasCommandSubstitution: hasCmdSubst };

  const virtualTools = [];
  let overallRisk = 'safe';
  let overallReadOnly = true;
  let overallDestructive = false;
  let skipNext = false;

  for (const part of parts) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    // Redirect operators → write operation, next part is target
    if (REDIRECT_OPS.has(part)) {
      overallReadOnly = false;
      overallRisk = maxRisk(overallRisk, 'medium');
      skipNext = true;
      continue;
    }

    // Skip pipeline/logic operators
    if (OPERATORS.has(part)) continue;

    const mapped = mapSingleCommand(part);
    virtualTools.push(mapped);

    // Aggregate: strictest wins
    overallRisk = maxRisk(overallRisk, mapped.risk);
    if (!mapped.isReadOnly) overallReadOnly = false;
    if (mapped.isDestructive) overallDestructive = true;
  }

  return {
    virtualTools,
    overallRisk,
    overallReadOnly,
    overallDestructive,
    hasCommandSubstitution: hasCmdSubst,
  };
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  mapCommandToVirtualTools,
  mapSingleCommand,
  hasCommandSubstitution,
  // For testing
  RISK_ORDER,
  maxRisk,
};
