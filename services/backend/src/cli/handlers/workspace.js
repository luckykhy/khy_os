/**
 * CLI Handler: workspace checkpoint commands.
 *
 * Commands:
 *   khy workspace save   [-m <message>] [--mode <auto|git-diff|tar-full>]
 *   khy workspace restore <id> [--dry-run]
 *   khy workspace list
 *   khy workspace diff    <id>
 *   khy workspace delete  <id>
 *   khy workspace cleanup [--keep <n>]
 *   khy workspace stats
 */
'use strict';

const path = require('path');
const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo, printTable,
} = require('../formatters');

let _checkpointService = null;

function _getService() {
  if (!_checkpointService) {
    _checkpointService = require('../../services/workspace/checkpointService');
  }
  return _checkpointService;
}

function _getProjectDir() {
  // Use current working directory as the project root
  return process.cwd();
}

// ─── Save ──────────────────────────────────────────────────────────────────

async function handleWorkspaceSave(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const message = options.m || options.message || args.join(' ') || undefined;
  const mode = options.mode || 'auto';

  try {
    printInfo('Saving workspace checkpoint...');
    const result = svc.saveCheckpoint(projectDir, { message, mode });
    printSuccess(`Checkpoint saved: ${chalk.cyan(result.id)}`);
    console.log(`  Mode:    ${result.mode}`);
    console.log(`  Message: ${result.message}`);
    console.log(`  Branch:  ${result.branch || 'N/A'}`);
    console.log(`  Commit:  ${result.commitHash || 'N/A'}`);
    if (result.size > 0) console.log(`  Size:    ${_formatSize(result.size)}`);
    return result;
  } catch (err) {
    printError(`Failed to save checkpoint: ${err.message}`);
    return null;
  }
}

// ─── Restore ───────────────────────────────────────────────────────────────

async function handleWorkspaceRestore(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('Usage: workspace restore <checkpoint-id>');
    return null;
  }

  const dryRun = options['dry-run'] || options.dryRun || false;

  try {
    if (dryRun) {
      printInfo(`[dry-run] Previewing restore of ${checkpointId}...`);
    } else {
      printWarn(`Restoring checkpoint ${chalk.cyan(checkpointId)}...`);
    }

    const result = svc.restoreCheckpoint(projectDir, checkpointId, { dryRun });
    if (result.restored) {
      printSuccess(`Restored: ${result.message}`);
    } else {
      printInfo(result.message);
    }
    return result;
  } catch (err) {
    printError(`Failed to restore: ${err.message}`);
    return null;
  }
}

// ─── List ──────────────────────────────────────────────────────────────────

async function handleWorkspaceList() {
  const svc = _getService();
  const projectDir = _getProjectDir();

  const checkpoints = svc.listCheckpoints(projectDir);
  if (checkpoints.length === 0) {
    printInfo('No checkpoints found. Use `workspace save` to create one.');
    return [];
  }

  console.log(`\n  ${chalk.bold('Workspace Checkpoints')} (${checkpoints.length})\n`);

  const rows = checkpoints.map((c, i) => [
    String(i + 1),
    c.id,
    c.mode,
    c.branch || '-',
    c.commitHash || '-',
    _formatSize(c.size || 0),
    c.timestamp ? new Date(c.timestamp).toLocaleString() : '-',
    (c.message || '').slice(0, 40),
  ]);

  printTable(
    ['#', 'ID', 'Mode', 'Branch', 'Commit', 'Size', 'Time', 'Message'],
    rows,
  );

  return checkpoints;
}

// ─── Diff ──────────────────────────────────────────────────────────────────

async function handleWorkspaceDiff(args = []) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('Usage: workspace diff <checkpoint-id>');
    return null;
  }

  try {
    const result = svc.diffCheckpoint(projectDir, checkpointId);
    if (result.diff) {
      console.log(result.diff);
      if (result.stats.additions || result.stats.deletions) {
        console.log(`\n  ${chalk.green(`+${result.stats.additions}`)} / ${chalk.red(`-${result.stats.deletions}`)}`);
      }
    }
    return result;
  } catch (err) {
    printError(`Failed to diff: ${err.message}`);
    return null;
  }
}

// ─── Delete ────────────────────────────────────────────────────────────────

async function handleWorkspaceDelete(args = []) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const checkpointId = args[0];

  if (!checkpointId) {
    printError('Usage: workspace delete <checkpoint-id>');
    return null;
  }

  try {
    const ok = svc.deleteCheckpoint(projectDir, checkpointId);
    if (ok) {
      printSuccess(`Deleted checkpoint: ${checkpointId}`);
    } else {
      printWarn(`Checkpoint not found: ${checkpointId}`);
    }
    return ok;
  } catch (err) {
    printError(`Failed to delete: ${err.message}`);
    return false;
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

async function handleWorkspaceCleanup(args = [], options = {}) {
  const svc = _getService();
  const projectDir = _getProjectDir();
  const keep = parseInt(options.keep, 10) || 10;

  try {
    const removed = svc.cleanupCheckpoints(projectDir, keep);
    if (removed > 0) {
      printSuccess(`Cleaned up ${removed} old checkpoint(s), keeping ${keep} most recent.`);
    } else {
      printInfo(`Nothing to clean — ${svc.listCheckpoints(projectDir).length} checkpoints within limit.`);
    }
    return removed;
  } catch (err) {
    printError(`Cleanup failed: ${err.message}`);
    return 0;
  }
}

// ─── Stats ─────────────────────────────────────────────────────────────────

async function handleWorkspaceStats() {
  const svc = _getService();
  const projectDir = _getProjectDir();

  const stats = svc.getCheckpointStats(projectDir);
  console.log(`\n  ${chalk.bold('Checkpoint Stats')}`);
  console.log(`  Project:     ${projectDir}`);
  console.log(`  Checkpoints: ${stats.count}`);
  console.log(`  Total size:  ${stats.formatted}`);
  return stats;
}

// ─── Router ────────────────────────────────────────────────────────────────

/**
 * Route workspace sub-commands.
 * @param {string[]} args - Sub-command and arguments
 * @param {object} options - Parsed flags
 */
async function handleWorkspace(args = [], options = {}) {
  const subCommand = args[0] || 'list';
  const subArgs = args.slice(1);

  switch (subCommand) {
    case 'save':
    case 's':
      return handleWorkspaceSave(subArgs, options);
    case 'restore':
    case 'r':
      return handleWorkspaceRestore(subArgs, options);
    case 'list':
    case 'ls':
    case 'l':
      return handleWorkspaceList();
    case 'diff':
    case 'd':
      return handleWorkspaceDiff(subArgs);
    case 'delete':
    case 'rm':
      return handleWorkspaceDelete(subArgs);
    case 'cleanup':
    case 'clean':
      return handleWorkspaceCleanup(subArgs, options);
    case 'stats':
    case 'info':
      return handleWorkspaceStats();
    default:
      printError(`Unknown workspace command: ${subCommand}`);
      console.log('  Available: save, restore, list, diff, delete, cleanup, stats');
      return null;
  }
}

// CC 后端口径对齐:字节数 → 人类可读走 CC `formatFileSize` 单一真源(ccFormat SSOT)。
// 门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认开;关 / require 失败 → 逐字节回退旧本地口径。
function _formatSize(bytes, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(bytes);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

module.exports = {
  handleWorkspace,
  handleWorkspaceSave,
  handleWorkspaceRestore,
  handleWorkspaceList,
  handleWorkspaceDiff,
  handleWorkspaceDelete,
  handleWorkspaceCleanup,
  handleWorkspaceStats,
};
