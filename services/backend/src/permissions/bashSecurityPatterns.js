/**
 * bashSecurityPatterns.js — pure-literal bash command-pattern tables (single source).
 * Extracted verbatim from bashSecurity.js. No logic, zero requires.
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
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'which',
  'echo',
  'printf',
  'date',
  'whoami',
  'hostname',
  'uname',
  'pwd',
  'env',
  'printenv',
  'id',
  'groups',
  'file',
  'stat',
  'df',
  'du',
  'free',
  'uptime',
  'top',
  'htop',
  'ps',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git tag',
  'git stash list',
  'git blame',
  'node --version',
  'npm --version',
  'pnpm --version',
  'yarn --version',
  'python --version',
  'python3 --version',
  'pip --version',
  'man',
  'help',
  'type',
  'command',
  'true',
  'false',
  'test',
]);

/**
 * Prefixes of read-only commands.
 */
const SAFE_PREFIXES = [
  'ls ',
  'cat ',
  'head ',
  'tail ',
  'wc ',
  'grep ',
  'rg ',
  'find ',
  'which ',
  'echo ',
  'printf ',
  'file ',
  'stat ',
  'git status',
  'git log ',
  'git diff ',
  'git show ',
  'git blame ',
  'git branch -',
  'git remote -v',
  'git tag -l',
  'node -e ',
  'node --eval ',
  'jq ',
  'yq ',
  'sed -n ',
  'awk ',
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

module.exports = {
  DANGEROUS_PATTERNS,
  SAFE_COMMANDS,
  SAFE_PREFIXES,
  CONFIRMATION_PATTERNS,
};
