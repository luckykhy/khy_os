/**
 * ExitWorktreeTool — leave a worktree, optionally removing it.
 * Aligned with Claude Code's ExitWorktree tool.
 */
const { BaseTool } = require('../_baseTool');

// Restore the session cwd to the main repo root, syncing BOTH cwd sources
// (KHYQUANT_CWD + process.chdir) so file/git tools leave the worktree with the
// model. Gate KHY_WORKTREE_TOOL_CWD (default on); off → chdir-only (legacy).
function _restoreCwd(dir) {
  try {
    require('../../services/worktreeSessionCwd').switchToolCwd(dir);
  } catch {
    process.chdir(dir); // fail-soft: at minimum keep legacy behavior
  }
}

class ExitWorktreeTool extends BaseTool {
  static toolName = 'ExitWorktree';
  static category = 'git';
  static risk = 'medium';
  static aliases = ['exit_worktree', 'worktree_exit', 'worktree_remove'];
  static searchHint = 'git worktree leave exit remove';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Exit the current worktree session. Use "keep" to leave worktree on disk, "remove" to delete it.
If the worktree has uncommitted changes, removal will be refused unless discard_changes is true.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['keep', 'remove'],
          description: '"keep" leaves the worktree on disk; "remove" deletes worktree and branch.',
        },
        discard_changes: {
          type: 'boolean',
          description: 'Required true when action is "remove" and the worktree has uncommitted changes.',
          default: false,
        },
      },
    };
  }

  async execute(params) {
    const worktreeManager = require('../../services/worktreeManager');

    if (!worktreeManager.isInsideWorktree()) {
      return { message: 'No active worktree session. No action taken.' };
    }

    const currentPath = process.cwd();
    const gitRoot = worktreeManager.getGitRoot();

    if (params.action === 'keep') {
      // Just switch back to the main working tree
      if (gitRoot) {
        // Navigate to the main repo root (not the worktree)
        const { execSync } = require('child_process');
        try {
          const commonDir = execSync('git rev-parse --git-common-dir', {
            cwd: currentPath,
            encoding: 'utf-8',
          }).trim();
          const mainRoot = require('path').resolve(currentPath, commonDir, '..');
          _restoreCwd(mainRoot);
        } catch {
          // Fallback: go up until not in worktree
          if (gitRoot) _restoreCwd(gitRoot);
        }
      }

      return {
        success: true,
        action: 'keep',
        worktreePath: currentPath,
        message: `Exited worktree. Working directory restored. Worktree kept at ${currentPath}`,
      };
    }

    if (params.action === 'remove') {
      // Find main repo root before removing
      const { execSync } = require('child_process');
      let mainRoot = gitRoot;
      try {
        const commonDir = execSync('git rev-parse --git-common-dir', {
          cwd: currentPath,
          encoding: 'utf-8',
        }).trim();
        mainRoot = require('path').resolve(currentPath, commonDir, '..');
      } catch { /* use gitRoot fallback */ }

      try {
        const result = worktreeManager.removeWorktree(currentPath, {
          force: params.discard_changes === true,
        });

        if (!result.removed) {
          return {
            error: 'Worktree has uncommitted changes. Set discard_changes: true to force removal.',
            uncommittedChanges: result.uncommittedChanges,
          };
        }

        // Switch to main repo
        if (mainRoot) _restoreCwd(mainRoot);

        return {
          success: true,
          action: 'remove',
          message: 'Worktree removed and branch deleted.',
        };
      } catch (err) {
        return { error: err.message };
      }
    }

    return { error: `Invalid action: "${params.action}". Use "keep" or "remove".` };
  }
}

module.exports = ExitWorktreeTool;
