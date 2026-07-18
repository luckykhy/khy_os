/**
 * Task System — type-safe task lifecycle management.
 *
 * Mirrors Claude Code's Task.ts architecture:
 *   - Type-prefixed IDs for quick visual identification
 *   - Closed set of task types and statuses
 *   - Immutable task state factory
 *
 * Task types:
 *   local_bash  — shell command running on the host
 *   local_agent — sub-agent running in-process
 *   remote_agent — agent running on a remote node
 *   dream       — background memory distillation
 *
 * Task statuses:
 *   pending   — created, not yet started
 *   running   — actively executing
 *   completed — finished successfully
 *   failed    — finished with error
 *   killed    — terminated by user or system
 */
'use strict';

const crypto = require('crypto');
const { getTaskOutputPath } = require('./diskOutput');

// ── Constants ──────────────────────────────────────────────────────────

const TASK_TYPES = ['local_bash', 'local_agent', 'remote_agent', 'dream'];

const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'killed'];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed']);

/** Prefix map: first char of the task ID encodes the type. */
const TASK_ID_PREFIXES = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  dream: 'd',
};

/**
 * Case-insensitive-safe alphabet (digits + lowercase).
 * 36^8 ~ 2.8 trillion combinations — sufficient to resist brute-force
 * symlink attacks and to avoid collisions in any realistic session.
 */
const TASK_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const TASK_ID_RANDOM_LENGTH = 8;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Validate that a value is a known task type.
 * @param {string} type
 * @returns {boolean}
 */
function isValidTaskType(type) {
  return TASK_TYPES.includes(type);
}

/**
 * Validate that a value is a known task status.
 * @param {string} status
 * @returns {boolean}
 */
function isValidTaskStatus(status) {
  return TASK_STATUSES.includes(status);
}

/**
 * Check whether a task status is terminal (will not transition further).
 *
 * Used to guard against injecting messages into dead tasks, evicting
 * finished tasks from state, and orphan-cleanup paths.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// ── ID Generation ──────────────────────────────────────────────────────

/**
 * Generate a type-prefixed task ID.
 *
 * Format: <prefix><8 random alphanumeric chars>
 * Example: b3f7kq2m9 (bash task)
 *
 * @param {string} type - One of TASK_TYPES
 * @returns {string} Task ID
 */
function generateTaskId(type) {
  const prefix = TASK_ID_PREFIXES[type] || 'x';
  const bytes = crypto.randomBytes(TASK_ID_RANDOM_LENGTH);
  let id = prefix;
  for (let i = 0; i < TASK_ID_RANDOM_LENGTH; i++) {
    id += TASK_ID_ALPHABET[bytes[i] % TASK_ID_ALPHABET.length];
  }
  return id;
}

/**
 * Extract the task type from a task ID prefix.
 * @param {string} taskId
 * @returns {string|null} Task type or null if unknown
 */
function taskTypeFromId(taskId) {
  if (!taskId || taskId.length < 2) return null;
  const prefix = taskId[0];
  for (const [type, p] of Object.entries(TASK_ID_PREFIXES)) {
    if (p === prefix) return type;
  }
  return null;
}

// ── Task State Factory ─────────────────────────────────────────────────

/**
 * Create an immutable task state object.
 *
 * @param {string} id          - Generated task ID
 * @param {string} type        - Task type
 * @param {string} description - Human-readable description of what the task does
 * @param {object} [options]   - Optional fields
 * @param {string} [options.toolUseId]   - Originating tool-use ID
 * @param {string} [options.subject]     - Short imperative title
 * @param {string} [options.activeForm]  - Present continuous form for spinners
 * @returns {object} Task state
 */
function createTaskState(id, type, description, options = {}) {
  if (!isValidTaskType(type)) {
    throw new Error(`Invalid task type: ${type}. Valid: ${TASK_TYPES.join(', ')}`);
  }

  return {
    id,
    type,
    status: 'pending',
    description,
    subject: options.subject || description,
    activeForm: options.activeForm || null,
    toolUseId: options.toolUseId || null,
    startTime: Date.now(),
    endTime: null,
    totalPausedMs: 0,
    outputFile: getTaskOutputPath(id),
    outputOffset: 0,
    notified: false,
    // Dependency graph: which tasks this blocks / is blocked by
    blocks: [],
    blockedBy: [],
    // Owner agent (for multi-agent scenarios)
    owner: null,
    // Error message if failed
    error: null,
  };
}

module.exports = {
  TASK_TYPES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  TASK_ID_PREFIXES,
  isValidTaskType,
  isValidTaskStatus,
  isTerminalStatus,
  generateTaskId,
  taskTypeFromId,
  createTaskState,
};
