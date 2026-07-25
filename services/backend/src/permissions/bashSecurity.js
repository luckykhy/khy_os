/**
 * Bash Security — command classification and validation.
 *
 * Classifies shell commands into four safety categories:
 *
 *   safe               — Read-only or benign commands (ls, cat, git status)
 *   needs_confirmation  — Mutating but recoverable (git commit, npm install)
 *   dangerous           — Potentially destructive (rm -rf, git push --force)
 *   blocked             — Never allowed (format, dd if=/dev/zero, fork bombs)
 *
 * Also provides plan-mode validation: in plan mode only read-only commands
 * are permitted — all mutations require exiting plan mode first.
 */
'use strict';

// ── Dangerous command patterns ─────────────────────────────────────────

/**
 * Patterns that match dangerous commands. Each entry:
 *   { pattern: RegExp, reason: string, category: 'dangerous'|'blocked' }
 */
const DANGEROUS_PATTERNS = [
  // === BLOCKED (never allowed) ===
  {
    pattern: /\b(mkfs|mkswap|fdisk|parted|wipefs)\b/,
    reason: 'Filesystem/partition manipulation is blocked',
    category: 'blocked',
  },
  {
    pattern: /\bdd\s+.*\bif=\/dev\/(zero|random|urandom)\b/,
    reason: 'Writing device data is blocked',
    category: 'blocked',
  },
  {
    pattern: /:\(\)\s*\{.*\|.*&\s*\}\s*;/,
    reason: 'Fork bomb detected',
    category: 'blocked',
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    reason: 'Writing to raw block device is blocked',
    category: 'blocked',
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,
    reason: 'Deleting root filesystem is blocked',
    category: 'blocked',
  },
  {
    pattern: /\bchmod\s+(-R\s+)?777\s+\//,
    reason: 'Recursive chmod 777 on root is blocked',
    category: 'blocked',
  },
  {
    pattern: /\bcurl\s.*\|\s*(sudo\s+)?(ba)?sh\b/,
    reason: 'Piping curl to shell is blocked without review',
    category: 'blocked',
  },
  {
    pattern: /\beval\s*\$\(/,
    reason: 'eval with command substitution is blocked',
    category: 'blocked',
  },

  // === DANGEROUS (needs strong confirmation) ===
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+).*(\*|\.\.)/,
    reason: 'Recursive/force delete with wildcard or parent reference',
    category: 'dangerous',
  },
  {
    pattern: /\brm\s+-rf?\s/,
    reason: 'Force removal (rm -rf)',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+push\s+.*--force\b/,
    reason: 'Force push can overwrite remote history',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+push\s+.*-f\b/,
    reason: 'Force push can overwrite remote history',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'Hard reset discards uncommitted changes',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+clean\s+.*-f/,
    reason: 'git clean -f removes untracked files permanently',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+checkout\s+.*\.\s*$/,
    reason: 'git checkout . discards all unstaged changes',
    category: 'dangerous',
  },
  {
    pattern: /\bgit\s+branch\s+-D\b/,
    reason: 'Force-delete branch',
    category: 'dangerous',
  },
  {
    pattern: /\bsudo\s/,
    reason: 'Running with elevated privileges',
    category: 'dangerous',
  },
  {
    pattern: /\bchmod\s+(-R\s+)?[0-7]{3}\b/,
    reason: 'Changing file permissions',
    category: 'dangerous',
  },
  {
    pattern: /\bchown\b/,
    reason: 'Changing file ownership',
    category: 'dangerous',
  },
  {
    pattern: /\bkill\s+-9\b/,
    reason: 'Force killing a process',
    category: 'dangerous',
  },
  {
    pattern: /\bpkill\b|\bkillall\b/,
    reason: 'Killing processes by name',
    category: 'dangerous',
  },
  {
    pattern: />\s*\/etc\//,
    reason: 'Writing to system config directory',
    category: 'dangerous',
  },
  {
    pattern: /\bdocker\s+rm\b|\bdocker\s+system\s+prune\b/,
    reason: 'Docker container/image removal',
    category: 'dangerous',
  },
  {
    pattern: /\bdrop\s+database\b/i,
    reason: 'Dropping database',
    category: 'dangerous',
  },
  {
    pattern: /\bdrop\s+table\b/i,
    reason: 'Dropping database table',
    category: 'dangerous',
  },
  {
    pattern: /\btruncate\s+table\b/i,
    reason: 'Truncating database table',
    category: 'dangerous',
  },
];

// ── Safe command patterns ──────────────────────────────────────────────

/**
 * Commands that are always safe (read-only or benign).
 */
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'which',
  'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
  'pwd', 'env', 'printenv', 'id', 'groups', 'file', 'stat',
  'df', 'du', 'free', 'uptime', 'top', 'htop', 'ps',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'git remote', 'git tag', 'git stash list', 'git blame',
  'node --version', 'npm --version', 'pnpm --version', 'yarn --version',
  'python --version', 'python3 --version', 'pip --version',
  'man', 'help', 'type', 'command',
  'true', 'false', 'test',
]);

/**
 * Prefixes of read-only commands.
 */
const SAFE_PREFIXES = [
  'ls ', 'cat ', 'head ', 'tail ', 'wc ', 'grep ', 'rg ',
  'find ', 'which ', 'echo ', 'printf ', 'file ', 'stat ',
  'git status', 'git log ', 'git diff ', 'git show ', 'git blame ',
  'git branch -', 'git remote -v', 'git tag -l',
  'node -e ', 'node --eval ',
  'jq ', 'yq ', 'sed -n ', 'awk ',
];

// ── Needs confirmation patterns ────────────────────────────────────────

/**
 * Commands that mutate state but are generally recoverable.
 */
const CONFIRMATION_PATTERNS = [
  /\bgit\s+(commit|add|stash|merge|rebase|cherry-pick)\b/,
  /\bgit\s+push\b(?!.*--force)(?!.*-f)/,
  /\bnpm\s+(install|uninstall|update|publish)\b/,
  /\bpnpm\s+(install|add|remove|update|publish)\b/,
  /\byarn\s+(add|remove|upgrade|publish)\b/,
  /\bpip\s+install\b/,
  /\bmkdir\b/,
  /\bmv\b/,
  /\bcp\s+-r\b/,
  /\btouch\b/,
  /\bnpx\b/,
  /\bdocker\s+(build|run|compose)\b/,
  /\bcurl\s.*-X\s*(POST|PUT|PATCH|DELETE)\b/i,
  /\bwget\b/,
];

// ── Classification ─────────────────────────────────────────────────────

/**
 * Classify a bash command into a safety category.
 *
 * @param {string} command - The shell command to classify
 * @returns {{ safe: boolean, reason: string, category: 'safe'|'needs_confirmation'|'dangerous'|'blocked' }}
 */
function classifyBashCommand(command) {
  if (!command || typeof command !== 'string') {
    return { safe: false, reason: 'Empty or invalid command', category: 'blocked' };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Empty command', category: 'blocked' };
  }

  // Check dangerous/blocked patterns first (highest priority)
  for (const { pattern, reason, category } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason, category };
    }
  }

  // Check if it's a known-safe command
  if (SAFE_COMMANDS.has(trimmed)) {
    return { safe: true, reason: 'Known safe command', category: 'safe' };
  }

  // Check safe prefixes
  for (const prefix of SAFE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { safe: true, reason: 'Read-only command', category: 'safe' };
    }
  }

  // Check confirmation-needed patterns
  for (const pattern of CONFIRMATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: 'Mutating command requires confirmation', category: 'needs_confirmation' };
    }
  }

  // Pipe chains — scan each segment
  if (trimmed.includes('|')) {
    const segments = trimmed.split('|').map(s => s.trim());
    for (const seg of segments) {
      const segResult = classifyBashCommand(seg);
      if (segResult.category === 'blocked' || segResult.category === 'dangerous') {
        return segResult;
      }
    }
    // If all segments are safe, the pipeline is safe
    const allSafe = segments.every(seg => classifyBashCommand(seg).safe);
    if (allSafe) {
      return { safe: true, reason: 'All pipeline segments are safe', category: 'safe' };
    }
  }

  // Command substitution — conservative
  if (/\$\(/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
    return { safe: false, reason: 'Command substitution requires review', category: 'needs_confirmation' };
  }

  // Redirect to file — conservative
  if (/>\s*[^&]/.test(trimmed)) {
    return { safe: false, reason: 'Output redirect to file', category: 'needs_confirmation' };
  }

  // Default: unknown commands need confirmation
  return { safe: false, reason: 'Unknown command — confirmation required', category: 'needs_confirmation' };
}

// ── Plan mode validation ───────────────────────────────────────────────

/**
 * Validate whether a command is allowed in plan mode (read-only).
 *
 * In plan mode, only read-only commands are permitted. All mutations
 * require exiting plan mode first.
 *
 * @param {string} command
 * @returns {{ allowed: boolean, reason: string }}
 */
function validateForPlanMode(command) {
  const classification = classifyBashCommand(command);

  if (classification.category === 'safe') {
    return { allowed: true, reason: 'Read-only command allowed in plan mode' };
  }

  return {
    allowed: false,
    reason: `Command blocked in plan mode: ${classification.reason}. Exit plan mode to execute mutations.`,
  };
}

/**
 * Get a summary of all dangerous patterns (for documentation/display).
 * @returns {Array<{ pattern: string, reason: string, category: string }>}
 */
function getDangerousPatternSummary() {
  return DANGEROUS_PATTERNS.map(({ pattern, reason, category }) => ({
    pattern: pattern.source,
    reason,
    category,
  }));
}

module.exports = {
  classifyBashCommand,
  validateForPlanMode,
  getDangerousPatternSummary,
  DANGEROUS_PATTERNS,
  SAFE_COMMANDS,
};
