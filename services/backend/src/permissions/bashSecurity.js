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

const { DANGEROUS_PATTERNS, SAFE_COMMANDS, SAFE_PREFIXES, CONFIRMATION_PATTERNS } = require('./bashSecurityPatterns');

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
      return {
        safe: false,
        reason: 'Mutating command requires confirmation',
        category: 'needs_confirmation',
      };
    }
  }

  // Pipe chains — scan each segment
  if (trimmed.includes('|')) {
    const segments = trimmed.split('|').map((s) => s.trim());
    for (const seg of segments) {
      const segResult = classifyBashCommand(seg);
      if (segResult.category === 'blocked' || segResult.category === 'dangerous') {
        return segResult;
      }
    }
    // If all segments are safe, the pipeline is safe
    const allSafe = segments.every((seg) => classifyBashCommand(seg).safe);
    if (allSafe) {
      return { safe: true, reason: 'All pipeline segments are safe', category: 'safe' };
    }
  }

  // Command substitution — conservative
  if (/\$\(/.test(trimmed) || /`[^`]+`/.test(trimmed)) {
    return {
      safe: false,
      reason: 'Command substitution requires review',
      category: 'needs_confirmation',
    };
  }

  // Redirect to file — conservative
  if (/>\s*[^&]/.test(trimmed)) {
    return { safe: false, reason: 'Output redirect to file', category: 'needs_confirmation' };
  }

  // Default: unknown commands need confirmation
  return {
    safe: false,
    reason: 'Unknown command — confirmation required',
    category: 'needs_confirmation',
  };
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
