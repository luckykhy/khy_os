/**
 * EnterWorktreeTool — create an isolated git worktree and switch into it.
 * Aligned with Claude Code's EnterWorktree tool.
 */
const { BaseTool } = require('../_baseTool');

class EnterWorktreeTool extends BaseTool {
  static toolName = 'EnterWorktree';
  static category = 'git';
  static risk = 'medium';
  static aliases = ['enter_worktree', 'worktree_create'];
  static searchHint = 'git worktree isolate branch agent';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Create an isolated git worktree and switch the session into it.
Use when the user explicitly asks to work in a worktree, or when an agent needs isolated git state.
Must be in a git repository and not already inside a worktree.
Creates a new branch based on HEAD inside .khy/worktrees/.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional name for the worktree. Auto-generated if omitted. Max 64 chars, letters/digits/dots/underscores/dashes only.',
        },
      },
    };
  }

  async execute(params) {
    const worktreeManager = require('../../services/worktreeManager');

    if (worktreeManager.isInsideWorktree()) {
      return { error: 'Already inside a git worktree. Exit the current worktree first.' };
    }

    const gitRoot = worktreeManager.getGitRoot();
    if (!gitRoot) {
      return { error: 'Not inside a git repository. Worktrees require git.' };
    }

    try {
      const result = worktreeManager.createWorktree({
        name: params.name || undefined,
      });

      // Switch BOTH cwd sources (KHYQUANT_CWD + process.chdir) so file/git tools,
      // the file lock, red/green diff and checkpoints follow the model into the
      // worktree — not just process.cwd(). Gate KHY_WORKTREE_TOOL_CWD (default on);
      // off → chdir-only (legacy). See services/worktreeSessionCwd.
      try {
        require('../../services/worktreeSessionCwd').switchToolCwd(result.path);
      } catch {
        process.chdir(result.path); // fail-soft: at minimum keep legacy behavior
      }

      return {
        success: true,
        path: result.path,
        branch: result.branch,
        name: result.name,
        message: `Worktree created at ${result.path} on branch ${result.branch}`,
      };
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = EnterWorktreeTool;
