/**
 * Memory Directory (memdir) — persistent, file-based memory system.
 *
 * Mirrors Claude Code's four-type memory taxonomy:
 *
 *   user      — Who the user is, their role, preferences, expertise
 *   feedback  — How the user wants you to work (corrections + confirmations)
 *   project   — Non-derivable context about the project (deadlines, decisions)
 *   reference — Pointers to external systems (dashboards, ticket trackers)
 *
 * Memory files use YAML frontmatter for metadata:
 *   ---
 *   name: Memory Title
 *   description: One-line description for relevance matching
 *   type: user|feedback|project|reference
 *   ---
 *   (body content)
 *
 * The MEMORY.md index file is an index of pointers to individual memory
 * files. It is loaded into the system prompt at the start of each session.
 * Each entry should be one line, under ~150 characters.
 */
'use strict';

const memdir = require('./memdir');
const paths = require('./paths');

// ── Memory types ───────────────────────────────────────────────────────

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];

/**
 * Validate a memory type.
 * @param {string} type
 * @returns {boolean}
 */
function isValidMemoryType(type) {
  return MEMORY_TYPES.includes(type);
}

/**
 * Parse a raw frontmatter value into a memory type.
 * Returns null for invalid or missing values.
 * @param {*} raw
 * @returns {string|null}
 */
function parseMemoryType(raw) {
  if (typeof raw !== 'string') return null;
  return MEMORY_TYPES.includes(raw) ? raw : null;
}

// ── Frontmatter format ─────────────────────────────────────────────────

/**
 * Example frontmatter format (used in prompts).
 */
const MEMORY_FRONTMATTER_EXAMPLE = [
  '```markdown',
  '---',
  'name: {{memory name}}',
  'description: {{one-line description for relevance matching}}',
  `type: {{${MEMORY_TYPES.join(', ')}}}`,
  '---',
  '',
  '{{memory content}}',
  '```',
];

// ── What NOT to save ───────────────────────────────────────────────────

const WHAT_NOT_TO_SAVE = [
  '## What NOT to save in memory',
  '',
  '- Code patterns, conventions, architecture, file paths, or project structure — derivable from the codebase.',
  '- Git history, recent changes, or who-changed-what — git log / git blame are authoritative.',
  '- Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.',
  '- Anything already documented in project CLAUDE.md or khy.md files.',
  '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
  '',
  'These exclusions apply even when the user explicitly asks you to save.',
  'If they ask to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it.',
];

// ── When to access ─────────────────────────────────────────────────────

const WHEN_TO_ACCESS = [
  '## When to access memories',
  '- When memories seem relevant, or the user references prior-conversation work.',
  '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
  '- If the user says to *ignore* or *not use* memory: proceed as if MEMORY.md were empty.',
  '- Memory records can become stale. Verify against current state before acting on recalled information.',
];

module.exports = {
  MEMORY_TYPES,
  isValidMemoryType,
  parseMemoryType,
  MEMORY_FRONTMATTER_EXAMPLE,
  WHAT_NOT_TO_SAVE,
  WHEN_TO_ACCESS,
  // Re-exports
  ...memdir,
  ...paths,
};
