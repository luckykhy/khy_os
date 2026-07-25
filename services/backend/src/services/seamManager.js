'use strict';

/**
 * seamManager.js — Append-Only Context Seam Manager
 *
 * Aligned with DeepSeek-TUI's seam management for prefix cache preservation.
 *
 * Core principle: NEVER rewrite existing messages. Instead, append
 * <archived_context> summary blocks at graduated thresholds.
 * This preserves the prefix cache's 128-token granularity alignment.
 *
 * Seam Levels (scaled for khy's typical model context windows):
 *   L1  @  48K tokens — light summary (~800 tokens)
 *   L2  @  96K tokens — medium summary (~600 tokens)
 *   L3  @ 144K tokens — dense summary (~400 tokens)
 *   Cycle @ 192K tokens — full cycle boundary (≤1.5K carry-forward)
 *
 * Verbatim window: last 8 turns are never summarized.
 *
 * Usage:
 *   const seam = require('./seamManager');
 *   const result = seam.checkAndApply(messages, activeTokens, summarizeFn);
 */

// ── Seam Level Definitions ────────────────────────────────────────────

const SEAM_LEVELS = Object.freeze([
  { name: 'L1', threshold: 48_000,  summaryBudget: 800,  model: 'flash' },
  { name: 'L2', threshold: 96_000,  summaryBudget: 600,  model: 'flash' },
  { name: 'L3', threshold: 144_000, summaryBudget: 400,  model: 'flash' },
  { name: 'Cycle', threshold: 192_000, summaryBudget: 1500, model: 'main' },
]);

/** How many recent turns to never summarize (verbatim window). */
const VERBATIM_WINDOW = 8;

/** Minimum messages before any seam can trigger. */
const MIN_MESSAGES_FOR_SEAM = 12;

/** Env override: KHY_SEAM_DISABLED=true to disable entirely. */
const SEAM_DISABLED = ['true', '1', 'on'].includes(
  String(process.env.KHY_SEAM_DISABLED || '').toLowerCase()
);

// ── State Tracking ────────────────────────────────────────────────────

/**
 * Per-session state tracking which seam levels have already been applied.
 * Keyed by session context (or just a singleton for single-session usage).
 */
const _appliedSeams = new Map(); // sessionId → Set<seamLevel>

/**
 * Get or create the applied-seams set for a session.
 * @param {string} [sessionId='default']
 * @returns {Set<string>}
 */
function _getAppliedSeams(sessionId = 'default') {
  if (!_appliedSeams.has(sessionId)) {
    _appliedSeams.set(sessionId, new Set());
  }
  return _appliedSeams.get(sessionId);
}

// ── Core Functions ────────────────────────────────────────────────────

/**
 * Determine which seam level (if any) should trigger based on active token count.
 *
 * @param {number} activeTokens - Estimated active input tokens
 * @param {string} [sessionId='default']
 * @returns {{ level: object|null, needsSeam: boolean }}
 */
function checkSeam(activeTokens, sessionId = 'default') {
  if (SEAM_DISABLED || activeTokens <= 0) {
    return { level: null, needsSeam: false };
  }

  const applied = _getAppliedSeams(sessionId);

  // Find highest applicable seam that hasn't been applied yet
  // Process from highest to lowest so we always apply the most relevant
  for (let i = SEAM_LEVELS.length - 1; i >= 0; i--) {
    const level = SEAM_LEVELS[i];
    if (activeTokens >= level.threshold && !applied.has(level.name)) {
      return { level, needsSeam: true };
    }
  }

  return { level: null, needsSeam: false };
}

/**
 * Identify which messages should be archived (summarized) for a seam.
 * Protects:
 *   - System messages (role === 'system')
 *   - Existing <archived_context> blocks
 *   - Verbatim window (last N turns)
 *
 * @param {Array} messages - Conversation messages
 * @param {object} level   - Seam level definition
 * @returns {{ archiveRange: {start: number, end: number}, archiveMessages: Array }}
 */
function identifyArchiveRange(messages, level) {
  if (!messages || messages.length < MIN_MESSAGES_FOR_SEAM) {
    return { archiveRange: null, archiveMessages: [] };
  }

  // Count turns (user+assistant pairs) from the end for verbatim window
  let turnCount = 0;
  let verbatimBoundary = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      turnCount++;
      if (turnCount >= VERBATIM_WINDOW) {
        verbatimBoundary = i;
        break;
      }
    }
  }

  // Find archivable range: skip system messages and existing archives at the start
  let archiveStart = -1;
  for (let i = 0; i < verbatimBoundary; i++) {
    const msg = messages[i];
    if (msg.role === 'system') continue;
    if (typeof msg.content === 'string' && msg.content.includes('<archived_context>')) continue;
    if (archiveStart < 0) archiveStart = i;
  }

  if (archiveStart < 0 || archiveStart >= verbatimBoundary) {
    return { archiveRange: null, archiveMessages: [] };
  }

  const archiveEnd = verbatimBoundary;
  const archiveMessages = messages.slice(archiveStart, archiveEnd);

  return { archiveRange: { start: archiveStart, end: archiveEnd }, archiveMessages };
}

/**
 * Build an <archived_context> block from messages.
 * If a summarize function is provided, uses it; otherwise builds a manual extract.
 *
 * @param {Array} archiveMessages - Messages to archive
 * @param {object} level          - Seam level
 * @param {function} [summarizeFn] - async (messages, budget) => summary string
 * @returns {Promise<string>} The archive block content
 */
async function buildArchiveBlock(archiveMessages, level, summarizeFn) {
  const budgetChars = level.summaryBudget * 4; // ~4 chars per token

  if (typeof summarizeFn === 'function') {
    try {
      const summary = await summarizeFn(archiveMessages, level.summaryBudget);
      if (summary && summary.length > 0) {
        return _wrapArchiveBlock(summary, level);
      }
    } catch { /* fallback to manual extract */ }
  }

  // Manual extract: take key content from each message
  const parts = [];
  let charCount = 0;
  for (const msg of archiveMessages) {
    if (charCount >= budgetChars) break;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    const snippet = content.slice(0, Math.min(200, budgetChars - charCount));
    if (snippet.length > 20) {
      parts.push(`[${msg.role}] ${snippet}${content.length > 200 ? '...' : ''}`);
      charCount += snippet.length + 10;
    }
  }

  return _wrapArchiveBlock(parts.join('\n'), level);
}

/**
 * Wrap content in <archived_context> XML tags.
 */
function _wrapArchiveBlock(content, level) {
  return `<archived_context level="${level.name}" density="${level.summaryBudget}" timestamp="${Date.now()}">\n${content}\n</archived_context>`;
}

/**
 * Apply a seam: replace archivable messages with an archived_context block.
 * Returns the new message array (append-only: original messages before archive
 * range are kept, archive range is replaced with summary block).
 *
 * @param {Array} messages      - Current conversation messages
 * @param {number} activeTokens - Current active token estimate
 * @param {function} [summarizeFn] - async (messages, budget) => summary
 * @param {string} [sessionId='default']
 * @returns {Promise<{ messages: Array, applied: boolean, level: object|null }>}
 */
async function checkAndApply(messages, activeTokens, summarizeFn, sessionId = 'default') {
  const { level, needsSeam } = checkSeam(activeTokens, sessionId);

  if (!needsSeam || !level) {
    return { messages, applied: false, level: null };
  }

  const { archiveRange, archiveMessages } = identifyArchiveRange(messages, level);

  if (!archiveRange || archiveMessages.length === 0) {
    return { messages, applied: false, level: null };
  }

  const archiveBlock = await buildArchiveBlock(archiveMessages, level, summarizeFn);

  // Build new message array: keep everything before archive, insert block, keep verbatim
  const before = messages.slice(0, archiveRange.start);
  const after = messages.slice(archiveRange.end);
  const archiveMessage = {
    role: 'system',
    content: archiveBlock,
  };

  const newMessages = [...before, archiveMessage, ...after];

  // Mark this seam level as applied
  _getAppliedSeams(sessionId).add(level.name);

  return { messages: newMessages, applied: true, level };
}

// ── Session Lifecycle ─────────────────────────────────────────────────

/**
 * Reset seam tracking for a session (e.g., on new conversation).
 * @param {string} [sessionId='default']
 */
function resetSession(sessionId = 'default') {
  _appliedSeams.delete(sessionId);
}

/**
 * Get current seam status for a session.
 * @param {string} [sessionId='default']
 * @returns {{ appliedLevels: string[], nextLevel: object|null }}
 */
function getStatus(sessionId = 'default') {
  const applied = _getAppliedSeams(sessionId);
  const appliedLevels = [...applied];

  // Find next unapplied level
  const nextLevel = SEAM_LEVELS.find(l => !applied.has(l.name)) || null;

  return { appliedLevels, nextLevel };
}

module.exports = {
  SEAM_LEVELS,
  VERBATIM_WINDOW,
  MIN_MESSAGES_FOR_SEAM,
  checkSeam,
  identifyArchiveRange,
  buildArchiveBlock,
  checkAndApply,
  resetSession,
  getStatus,
};
