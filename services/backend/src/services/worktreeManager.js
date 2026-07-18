/**
 * Worktree Manager — Git worktree isolation for agents and CLI.
 *
 * Creates isolated git worktrees in .khy/worktrees/ so agents can work
 * on separate branches without affecting the main working tree.
 * Aligned with Claude Code's EnterWorktree/ExitWorktree architecture.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Windows 优先 Git Bash 的 git 执行辅助（回退系统 PATH）。所有 git 调用走此辅助,
// 让没有 Git Bash 的环境也能降级到系统 git。
const { spawnGit, spawnGitOutput } = require('./gitSpawnHelper');

// Pure name validation lives in a zero-dep leaf (src/utils/worktreeName.js) so
// both this manager and tools/_taskStore.js can share it without a require
// cycle (DESIGN-ARCH-020, R3). Re-exported below for backward compatibility.
const { validateName } = require('../utils/worktreeName');

const WORKTREE_DIR_NAME = '.khy/worktrees';
const EVENTS_FILE_NAME = 'events.jsonl';

/**
 * Generate a random worktree name.
 */
function generateWorktreeName() {
  const adjectives = ['swift', 'quiet', 'bright', 'bold', 'calm', 'cool', 'keen', 'warm'];
  const nouns = ['oak', 'river', 'hawk', 'stone', 'pine', 'wolf', 'star', 'flame'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${adj}-${noun}-${suffix}`;
}

// validateName (s18 path-traversal hardening) is imported from
// ../utils/worktreeName above and re-exported for compatibility.

// ── s18: worktree lifecycle audit log ───────────────────────────────────────
//
// Every create / remove / keep is appended to .khy/worktrees/events.jsonl so the
// worktree lifecycle is auditable (engineering rule: state transparency). Logs
// are written only AFTER the underlying git command succeeds, so the log always
// reflects real on-disk state.

function _eventsPath(gitRoot) {
  return path.join(gitRoot, WORKTREE_DIR_NAME, EVENTS_FILE_NAME);
}

/**
 * Append one lifecycle event. Best-effort: never throws (auditing must not break
 * the operation it records).
 * @param {('create'|'remove'|'keep')} eventType
 * @param {string} worktreeName
 * @param {object} [options]
 * @param {string} [options.gitRoot]
 * @param {string} [options.cwd]
 * @param {string|null} [options.taskId]
 * @returns {boolean} true if the event was persisted.
 */
function logEvent(eventType, worktreeName, options = {}) {
  const gitRoot = options.gitRoot || getGitRoot(options.cwd || process.cwd());
  if (!gitRoot) return false;
  try {
    fs.mkdirSync(path.join(gitRoot, WORKTREE_DIR_NAME), { recursive: true });
    const event = {
      type: eventType,
      worktree: worktreeName,
      taskId: options.taskId || null,
      ts: new Date().toISOString(),
    };
    fs.appendFileSync(_eventsPath(gitRoot), `${JSON.stringify(event)}\n`, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the worktree lifecycle audit log (oldest first).
 * @param {string} [cwd]
 * @returns {Array<{type:string, worktree:string, taskId:string|null, ts:string}>}
 */
function readEvents(cwd) {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return [];
  try {
    const raw = fs.readFileSync(_eventsPath(gitRoot), 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the absolute path a worktree name maps to, without creating anything.
 * Used by the teammate cwd-switch bridge (s18) to know where a claimed,
 * worktree-bound task should run.
 * @param {string} name
 * @param {string} [cwd]
 * @returns {string|null} absolute path, or null if not in a git repo / bad name.
 */
function worktreePathFor(name, cwd) {
  if (!validateName(name)) return null;
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return null;
  return path.join(gitRoot, WORKTREE_DIR_NAME, name);
}

/**
 * Get the git root directory.
 */
function getGitRoot(cwd) {
  const out = spawnGitOutput(['rev-parse', '--show-toplevel'], {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  });
  return out !== null ? out : null;
}

/**
 * Check if current directory is already inside a worktree.
 */
function isInsideWorktree(cwd) {
  const gitDir = spawnGitOutput(['rev-parse', '--git-dir'], {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  });
  return gitDir !== null && gitDir.includes('worktrees');
}

/**
 * Create a new worktree.
 *
 * @param {object} options
 * @param {string} [options.name] - Worktree name (auto-generated if not provided)
 * @param {string} [options.cwd] - Working directory (defaults to process.cwd())
 * @param {string} [options.taskId] - s18: bind this task to the worktree (writes
 *        the task's `worktree` field only; the task status is NOT changed).
 * @returns {{ path: string, branch: string, name: string }}
 */
function createWorktree(options = {}) {
  const cwd = options.cwd || process.cwd();
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) {
    throw new Error('Not inside a git repository');
  }

  if (isInsideWorktree(cwd)) {
    throw new Error('Already inside a git worktree');
  }

  const name = options.name || generateWorktreeName();
  if (!validateName(name)) {
    throw new Error(`Invalid worktree name: "${name}". Use letters, digits, dots, underscores, dashes; max 64 chars.`);
  }

  const worktreeBase = path.join(gitRoot, WORKTREE_DIR_NAME);
  const worktreePath = path.join(worktreeBase, name);
  const branchName = `khy-worktree/${name}`;

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree "${name}" already exists at ${worktreePath}`);
  }

  // Ensure base directory exists
  fs.mkdirSync(worktreeBase, { recursive: true });

  // Create worktree with a new branch based on HEAD
  const result = spawnGit(['worktree', 'add', '-b', branchName, worktreePath], {
    cwd: gitRoot,
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (result.status !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr || result.error}`);
  }

  // s18: bind the task to this worktree (writes the `worktree` field only; the
  // task status stays put). Best-effort and decoupled — a binding failure (or a
  // non-task caller such as AgentTool isolation) never undoes a created worktree.
  if (options.taskId) {
    try {
      require('../tools/_taskStore').bindWorktree(options.taskId, name);
    } catch { /* binding is best-effort; the worktree already exists */ }
  }
  logEvent('create', name, { gitRoot, taskId: options.taskId || null });

  return {
    path: worktreePath,
    branch: branchName,
    name,
    gitRoot,
  };
}

/**
 * Remove a worktree.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Force removal even with changes
 * @returns {{ removed: boolean, uncommittedChanges: string[]|null }}
 */
function removeWorktree(worktreePath, options = {}) {
  if (!fs.existsSync(worktreePath)) {
    return { removed: true, uncommittedChanges: null };
  }

  // Check for uncommitted changes
  if (!options.force) {
    const statusResult = spawnGit(['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    });

    if (statusResult.status === 0 && statusResult.stdout.trim()) {
      const changes = statusResult.stdout.trim().split('\n');
      return { removed: false, uncommittedChanges: changes };
    }
  }

  // Get the branch name before removing
  let branchName = null;
  {
    const out = spawnGitOutput(['branch', '--show-current'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    if (out !== null) branchName = out;
  }

  // Find git root from worktree
  let gitRoot = null;
  {
    // Navigate to the main working tree
    const commonDir = spawnGitOutput(['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    if (commonDir !== null) {
      gitRoot = path.resolve(worktreePath, commonDir, '..');
    }
  }

  // Remove the worktree
  const forceFlag = options.force ? '--force' : '';
  const removeResult = spawnGit(['worktree', 'remove', worktreePath, forceFlag].filter(Boolean), {
    cwd: gitRoot || path.dirname(worktreePath),
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (removeResult.status !== 0) {
    // Try force if normal removal fails
    if (!options.force) {
      const forceRemove = spawnGit(['worktree', 'remove', '--force', worktreePath], {
        cwd: gitRoot || path.dirname(worktreePath),
        encoding: 'utf-8',
        timeout: 30000,
      });
      if (forceRemove.status !== 0) {
        throw new Error(`Failed to remove worktree: ${forceRemove.stderr}`);
      }
    } else {
      throw new Error(`Failed to remove worktree: ${removeResult.stderr}`);
    }
  }

  // Delete the branch
  if (branchName && gitRoot) {
    try {
      spawnGit(['branch', '-D', branchName], {
        cwd: gitRoot,
        encoding: 'utf-8',
        timeout: 10000,
      });
    } catch { /* branch cleanup is best-effort */ }
  }

  logEvent('remove', path.basename(worktreePath), {
    gitRoot: gitRoot || undefined,
    cwd: gitRoot ? undefined : path.dirname(worktreePath),
  });

  return { removed: true, uncommittedChanges: null };
}

/**
 * Keep a worktree for manual review (s18 keep_worktree). Does not touch git —
 * the worktree and its branch are left intact for the user to inspect and merge.
 * Records a 'keep' audit event so the decision is traceable.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string|null} [options.taskId]
 * @returns {{ kept: boolean, name: string, branch: string, path: string|null }}
 */
function keepWorktree(name, options = {}) {
  if (!validateName(name)) {
    throw new Error(`Invalid worktree name: "${name}".`);
  }
  const cwd = options.cwd || process.cwd();
  const gitRoot = getGitRoot(cwd);
  logEvent('keep', name, { gitRoot: gitRoot || undefined, cwd, taskId: options.taskId || null });
  return {
    kept: true,
    name,
    branch: `khy-worktree/${name}`,
    path: gitRoot ? path.join(gitRoot, WORKTREE_DIR_NAME, name) : null,
  };
}

/**
 * List all active worktrees.
 *
 * @param {string} [cwd] - Working directory
 * @returns {{ path: string, branch: string, head: string }[]}
 */
function listWorktrees(cwd) {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return [];

  try {
    const result = spawnGitOutput(['worktree', 'list', '--porcelain'], {
      cwd: gitRoot,
      encoding: 'utf-8',
    });
    if (result === null) return [];

    const worktrees = [];
    let current = {};

    for (const line of result.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7);
      } else if (line === '') {
        if (current.path) worktrees.push(current);
        current = {};
      }
    }
    if (current.path) worktrees.push(current);

    // Filter to only .khy/worktrees/ entries
    return worktrees.filter(w => w.path.includes(WORKTREE_DIR_NAME));
  } catch {
    return [];
  }
}

module.exports = {
  createWorktree,
  removeWorktree,
  keepWorktree,
  listWorktrees,
  isInsideWorktree,
  getGitRoot,
  generateWorktreeName,
  validateName,
  worktreePathFor,
  logEvent,
  readEvents,
  WORKTREE_DIR_NAME,
};
