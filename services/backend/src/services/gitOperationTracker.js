'use strict';

/**
 * Git Operation Tracker — detect and record git operations from shell output.
 *
 * After every shell command execution, the tracker analyzes stdout/stderr
 * to detect git operations (commit, push, merge, PR creation, rebase, etc.)
 * and records them for session context.
 *
 * Inspired by Claude Code's git operation tracking from shell output.
 *
 * @module gitOperationTracker
 */

const log = require('../utils/logger');

// ── Operation patterns ─────────────────────────────────────────────

const GIT_PATTERNS = [
  {
    type: 'commit',
    patterns: [
      /\[(\S+)\s+([a-f0-9]{7,})\]\s+(.+)/,           // [branch abc1234] message
      /create mode \d+ (.+)/,                           // create mode 100644 file
    ],
    extract: (match) => ({
      branch: match[1],
      hash: match[2],
      message: match[3],
    }),
  },
  {
    type: 'push',
    patterns: [
      /([a-f0-9]+)\.\.([a-f0-9]+)\s+(\S+)\s+->\s+(\S+)/, // abc..def branch -> remote/branch
      /\* \[new branch\]\s+(\S+)\s+->\s+(\S+)/,            // * [new branch] branch -> remote
      /\* \[new tag\]\s+(\S+)\s+->\s+(\S+)/,               // * [new tag] tag -> remote
    ],
    extract: (match) => ({
      from: match[1],
      to: match[2],
      localRef: match[3] || '',
      remoteRef: match[4] || '',
    }),
  },
  {
    type: 'merge',
    patterns: [
      /Merge made by the '(\S+)' strategy/,
      /Already up to date/,
      /Fast-forward/,
      /Merge branch '([^']+)'/,
    ],
    extract: (match) => ({
      strategy: match[1] || 'fast-forward',
    }),
  },
  {
    type: 'pr_create',
    patterns: [
      /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/,
      /https:\/\/gitlab\.[^/]+\/[^/]+\/[^/]+\/-\/merge_requests\/(\d+)/,
    ],
    extract: (match) => ({
      url: match[0],
      number: match[1],
    }),
  },
  {
    type: 'checkout',
    patterns: [
      /Switched to (?:a new )?branch '([^']+)'/,
      /Already on '([^']+)'/,
      /HEAD is now at ([a-f0-9]+)/,
    ],
    extract: (match) => ({
      branch: match[1],
    }),
  },
  {
    type: 'rebase',
    patterns: [
      /Successfully rebased and updated (\S+)/,
      /Current branch (\S+) is up to date/,
    ],
    extract: (match) => ({
      ref: match[1],
    }),
  },
  {
    type: 'stash',
    patterns: [
      /Saved working directory and index state/,
      /Dropped refs\/stash@\{(\d+)\}/,
    ],
    extract: () => ({}),
  },
  {
    type: 'tag',
    patterns: [
      /tag '([^']+)'/,
    ],
    extract: (match) => ({
      tag: match[1],
    }),
  },
  {
    type: 'reset',
    patterns: [
      /HEAD is now at ([a-f0-9]+)\s+(.*)/,
      /Unstaged changes after reset/,
    ],
    extract: (match) => ({
      hash: match[1] || '',
      message: match[2] || '',
    }),
  },
];

// ── Session state ──────────────────────────────────────────────────

let _operations = [];
const MAX_OPERATIONS = 100;

/**
 * Analyze shell command output for git operations.
 *
 * @param {string} command - The shell command that was run
 * @param {string} output - stdout + stderr combined
 * @returns {Array<{ type: string, command: string, details: object, timestamp: number }>}
 */
function detectOperations(command, output) {
  if (!output || typeof output !== 'string') return [];

  // Quick check: skip if no git-related content
  const isGitCommand = /\bgit\b/i.test(command || '');
  const hasGitOutput = /\b(commit|push|merge|branch|rebase|tag|stash)\b/i.test(output);
  const hasGitUrl = /github\.com|gitlab\./i.test(output);

  if (!isGitCommand && !hasGitOutput && !hasGitUrl) return [];

  const detected = [];
  const lines = output.split('\n');

  for (const patternDef of GIT_PATTERNS) {
    for (const pattern of patternDef.patterns) {
      for (const line of lines) {
        const match = line.match(pattern);
        if (match) {
          const op = {
            type: patternDef.type,
            command: (command || '').slice(0, 200),
            details: patternDef.extract(match),
            timestamp: Date.now(),
          };
          detected.push(op);
          break; // One match per pattern is enough
        }
      }
    }
  }

  return detected;
}

/**
 * Track detected operations in session state.
 *
 * @param {string} command
 * @param {string} output
 * @returns {Array} Newly detected operations
 */
function trackFromShellOutput(command, output) {
  const ops = detectOperations(command, output);
  for (const op of ops) {
    _operations.push(op);
    if (_operations.length > MAX_OPERATIONS) {
      _operations.shift();
    }
  }
  return ops;
}

/**
 * Get all tracked operations.
 * @returns {Array}
 */
function getOperations() {
  return [..._operations];
}

/**
 * Get operations by type.
 * @param {string} type
 * @returns {Array}
 */
function getOperationsByType(type) {
  return _operations.filter(op => op.type === type);
}

/**
 * Get a summary of recent operations.
 * @param {number} [limit=10]
 * @returns {string}
 */
function summarize(limit = 10) {
  const recent = _operations.slice(-limit);
  if (recent.length === 0) return 'No git operations detected.';

  return recent.map(op => {
    const ts = new Date(op.timestamp).toLocaleTimeString();
    switch (op.type) {
      case 'commit':
        return `[${ts}] commit ${op.details.hash || ''} on ${op.details.branch || ''}: ${op.details.message || ''}`;
      case 'push':
        return `[${ts}] push ${op.details.localRef || ''} -> ${op.details.remoteRef || ''}`;
      case 'merge':
        return `[${ts}] merge (${op.details.strategy || ''})`;
      case 'pr_create':
        return `[${ts}] PR created: ${op.details.url || ''}`;
      case 'checkout':
        return `[${ts}] checkout ${op.details.branch || ''}`;
      case 'rebase':
        return `[${ts}] rebase ${op.details.ref || ''}`;
      default:
        return `[${ts}] ${op.type}`;
    }
  }).join('\n');
}

/**
 * Check if a destructive git operation was detected recently.
 * @param {number} [withinMs=60000] - Time window
 * @returns {boolean}
 */
function hasRecentDestructiveOp(withinMs = 60000) {
  const cutoff = Date.now() - withinMs;
  return _operations.some(op =>
    op.timestamp > cutoff && (op.type === 'reset' || op.type === 'rebase')
  );
}

/**
 * Reset tracker state (new session).
 */
function reset() {
  _operations = [];
}

module.exports = {
  detectOperations,
  trackFromShellOutput,
  getOperations,
  getOperationsByType,
  summarize,
  hasRecentDestructiveOp,
  reset,
  GIT_PATTERNS,
};
