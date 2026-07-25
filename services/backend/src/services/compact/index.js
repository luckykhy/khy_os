/**
 * Compaction Orchestrator — conversation context management.
 *
 * When a conversation grows too long for the context window, compaction
 * summarizes the older portion into a structured summary while preserving
 * recent messages verbatim. This lets the model continue working without
 * losing critical context.
 *
 * Two compaction modes:
 *
 *   sessionMemoryCompact  — Full conversation compaction. Replaces the
 *                           entire message history with a summary + recent
 *                           messages. Used when approaching the context limit.
 *
 *   microCompact          — Incremental compaction of a recent window.
 *                           Summarizes only the oldest N messages, keeping
 *                           the rest intact. Used for gradual pruning.
 *
 * The orchestrator does NOT call the AI itself — it builds prompts and
 * formats results. The caller is responsible for sending the prompt to
 * the model and passing the result back through formatCompactSummary().
 */
'use strict';

const {
  getCompactPrompt,
  getPartialCompactPrompt,
  formatCompactSummary,
  getCompactUserMessage,
} = require('./prompt');

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Default number of recent messages to preserve during full compaction.
 * These messages are kept verbatim and appended after the summary.
 */
const DEFAULT_PRESERVE_RECENT = 10;

/**
 * Minimum number of messages before compaction is worthwhile.
 * Below this threshold, the overhead of summarization exceeds the savings.
 */
const MIN_MESSAGES_FOR_COMPACTION = 20;

/**
 * Default token budget estimate per message (for rough context math).
 */
const ESTIMATED_TOKENS_PER_MESSAGE = 500;

// ── Session compaction ─────────────────────────────────────────────────

/**
 * Prepare a full session compaction.
 *
 * Splits the message array into two parts:
 *   - toSummarize: older messages that will be compacted
 *   - toPreserve: recent messages that will be kept verbatim
 *
 * Returns the compaction prompt (to send to the model) and metadata
 * needed to reconstruct the message array after compaction.
 *
 * @param {Array<object>} messages - Full conversation message array
 * @param {object} [options]
 * @param {number} [options.preserveRecent]    - Messages to keep verbatim
 * @param {string} [options.customInstructions] - Extra summarization instructions
 * @param {string} [options.transcriptPath]     - Path to save full transcript
 * @returns {{
 *   prompt: string,
 *   toSummarize: Array<object>,
 *   toPreserve: Array<object>,
 *   metadata: object
 * }}
 */
function sessionMemoryCompact(messages, options = {}) {
  const preserveCount = options.preserveRecent || DEFAULT_PRESERVE_RECENT;

  if (!messages || messages.length < MIN_MESSAGES_FOR_COMPACTION) {
    return {
      prompt: null,
      toSummarize: [],
      toPreserve: messages || [],
      metadata: { skipped: true, reason: 'Too few messages for compaction' },
    };
  }

  const splitPoint = Math.max(0, messages.length - preserveCount);
  const toSummarize = messages.slice(0, splitPoint);
  const toPreserve = messages.slice(splitPoint);

  const prompt = getCompactPrompt(options.customInstructions);

  return {
    prompt,
    toSummarize,
    toPreserve,
    metadata: {
      skipped: false,
      originalCount: messages.length,
      summarizedCount: toSummarize.length,
      preservedCount: toPreserve.length,
      timestamp: Date.now(),
    },
  };
}

/**
 * Prepare an incremental (micro) compaction.
 *
 * Summarizes only a window of older messages, keeping the rest intact.
 * Useful for gradual context management without a full compaction event.
 *
 * @param {Array<object>} messages - Full conversation message array
 * @param {object} [options]
 * @param {number} [options.windowSize]         - Messages to summarize (default: 10)
 * @param {string} [options.customInstructions] - Extra summarization instructions
 * @returns {{
 *   prompt: string,
 *   windowMessages: Array<object>,
 *   remainingMessages: Array<object>,
 *   metadata: object
 * }}
 */
function microCompact(messages, options = {}) {
  const windowSize = options.windowSize || 10;

  if (!messages || messages.length < windowSize + 5) {
    return {
      prompt: null,
      windowMessages: [],
      remainingMessages: messages || [],
      metadata: { skipped: true, reason: 'Too few messages for micro-compaction' },
    };
  }

  const windowMessages = messages.slice(0, windowSize);
  const remainingMessages = messages.slice(windowSize);

  const prompt = getPartialCompactPrompt(options.customInstructions);

  return {
    prompt,
    windowMessages,
    remainingMessages,
    metadata: {
      skipped: false,
      originalCount: messages.length,
      windowSize: windowMessages.length,
      remainingCount: remainingMessages.length,
      timestamp: Date.now(),
    },
  };
}

/**
 * Apply a compaction result to reconstruct the message array.
 *
 * Takes the model's summary output and the preserved messages,
 * and returns a new message array that starts with the summary
 * followed by the preserved recent messages.
 *
 * @param {string} rawSummary      - Raw model output with <analysis>/<summary> tags
 * @param {Array<object>} preserved - Messages to keep after the summary
 * @param {object} [options]
 * @param {boolean} [options.suppressFollowUp] - Skip follow-up questions
 * @param {string}  [options.transcriptPath]   - Path to full transcript
 * @returns {Array<object>} New message array
 */
function applyCompaction(rawSummary, preserved, options = {}) {
  const summaryMessage = getCompactUserMessage(rawSummary, {
    suppressFollowUp: options.suppressFollowUp,
    transcriptPath: options.transcriptPath,
    recentPreserved: preserved.length > 0,
  });

  const newMessages = [
    {
      role: 'user',
      content: summaryMessage,
      _meta: {
        type: 'compaction_summary',
        timestamp: Date.now(),
      },
    },
    ...preserved,
  ];

  return newMessages;
}

/**
 * Build the compaction prompt for a given variant.
 *
 * @param {Array<object>} messages  - Messages to include in the prompt context
 * @param {'full'|'partial'} variant - Prompt variant
 * @param {object} [options]
 * @param {string} [options.customInstructions]
 * @returns {string}
 */
function getCompactionPrompt(messages, variant = 'full', options = {}) {
  if (variant === 'partial') {
    return getPartialCompactPrompt(options.customInstructions);
  }
  return getCompactPrompt(options.customInstructions);
}

/**
 * Estimate whether compaction is needed based on message count and estimated tokens.
 *
 * @param {Array<object>} messages       - Current message array
 * @param {number} contextWindowTokens   - Model's context window size in tokens
 * @param {number} [reserveTokens=4096]  - Tokens to reserve for the response
 * @returns {{ needed: boolean, urgency: 'none'|'soon'|'now', estimatedTokens: number }}
 */
function shouldCompact(messages, contextWindowTokens, reserveTokens = 4096) {
  if (!messages || messages.length === 0) {
    return { needed: false, urgency: 'none', estimatedTokens: 0 };
  }

  // Rough token estimate
  let estimatedTokens = 0;
  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content || '');
    // ~4 chars per token is a rough heuristic
    estimatedTokens += Math.ceil(content.length / 4);
  }

  // Clamp the output reserve to the window. On a small window the fixed 4096
  // default would reserve half the context and compaction would never fire at
  // the right point; contextProfile lowers it proportionally (and leaves large
  // windows untouched, where 4096 is well under the cap).
  let reserve = reserveTokens;
  try {
    reserve = require('../contextProfile').deriveReserveTokens(contextWindowTokens, reserveTokens);
  } catch { /* contextProfile optional — fall back to the raw reserve */ }

  const available = Math.max(1, contextWindowTokens - reserve);
  const usage = estimatedTokens / available;

  if (usage >= 0.9) {
    return { needed: true, urgency: 'now', estimatedTokens };
  }
  if (usage >= 0.7) {
    return { needed: true, urgency: 'soon', estimatedTokens };
  }

  return { needed: false, urgency: 'none', estimatedTokens };
}

module.exports = {
  sessionMemoryCompact,
  microCompact,
  applyCompaction,
  getCompactionPrompt,
  shouldCompact,
  formatCompactSummary,
  getCompactUserMessage,
  DEFAULT_PRESERVE_RECENT,
  MIN_MESSAGES_FOR_COMPACTION,
};
