'use strict';

/**
 * contextPruner.js — CJK-aware context pruning with token budget.
 *
 * Ported from OpenClaw's context-pruning/pruner.ts.
 * Reduces context size through:
 *   - Soft trim: head+tail taking with char budget
 *   - Hard clear: replace old tool results with placeholder
 *   - Image-aware: replaces images with marker instead of dropping entire result
 *   - CJK-aware token estimation: CJK chars ≈ 2 tokens vs ASCII ≈ 0.25 tokens
 *
 * Constants:
 *   CHARS_PER_TOKEN = 4 (ASCII), CJK_RATIO = 2.0
 *   IMAGE_CHAR_ESTIMATE = 8000
 *   SOFT_TRIM_RATIO = 0.3 (trigger at 30% context used)
 *   HARD_CLEAR_RATIO = 0.5 (trigger at 50% context used)
 */

const CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 2;
const IMAGE_CHAR_ESTIMATE = 8_000;
const PRUNED_IMAGE_MARKER = '[image removed during context pruning]';

const DEFAULT_SETTINGS = {
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: '[Old tool result content cleared]',
  },
  tools: {
    allow: [],  // glob patterns for prunable tools (empty = all)
    deny: [],   // glob patterns for non-prunable tools
  },
};

// CJK Unicode ranges
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u2E80-\u2EFF\u3000-\u303F\u31F0-\u31FF\uFF00-\uFFEF\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]/;

/**
 * Estimate chars weighted by CJK density.
 * CJK chars count as ~2 tokens each vs ASCII at ~0.25 tokens.
 *
 * @param {string} text
 * @returns {number} Weighted char count
 */
function estimateWeightedChars(text) {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    count += CJK_RE.test(text[i]) ? CJK_CHARS_PER_TOKEN : 1;
  }
  return count;
}

/**
 * Estimate tokens from weighted char count.
 */
function estimateTokensFromChars(weightedChars) {
  return Math.ceil(weightedChars / CHARS_PER_TOKEN);
}

/**
 * Take the head (first N chars) from joined text parts.
 *
 * @param {string[]} parts
 * @param {number} maxChars
 * @returns {string}
 */
function takeHead(parts, maxChars) {
  if (maxChars <= 0 || parts.length === 0) return '';
  let remaining = maxChars;
  let out = '';

  for (let i = 0; i < parts.length && remaining > 0; i++) {
    if (i > 0) { out += '\n'; remaining--; if (remaining <= 0) break; }
    const p = parts[i];
    if (p.length <= remaining) {
      out += p;
      remaining -= p.length;
    } else {
      out += p.slice(0, remaining);
      remaining = 0;
    }
  }
  return out;
}

/**
 * Take the tail (last N chars) from joined text parts.
 *
 * @param {string[]} parts
 * @param {number} maxChars
 * @returns {string}
 */
function takeTail(parts, maxChars) {
  if (maxChars <= 0 || parts.length === 0) return '';
  let remaining = maxChars;
  const out = [];

  for (let i = parts.length - 1; i >= 0 && remaining > 0; i--) {
    const p = parts[i];
    if (p.length <= remaining) {
      out.push(p);
      remaining -= p.length;
    } else {
      out.push(p.slice(p.length - remaining));
      remaining = 0;
      break;
    }
    if (remaining > 0 && i > 0) { out.push('\n'); remaining--; }
  }

  out.reverse();
  return out.join('');
}

/**
 * Soft-trim a tool result: keep head + tail, trim middle.
 *
 * @param {string} content - Tool result content
 * @param {object} [opts]
 * @param {number} [opts.maxChars=4000]
 * @param {number} [opts.headChars=1500]
 * @param {number} [opts.tailChars=1500]
 * @returns {{ trimmed: string, wasTrimmed: boolean }}
 */
function softTrimToolResult(content, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_SETTINGS.softTrim.maxChars;
  const headChars = opts.headChars || DEFAULT_SETTINGS.softTrim.headChars;
  const tailChars = opts.tailChars || DEFAULT_SETTINGS.softTrim.tailChars;

  if (!content || content.length <= maxChars) {
    return { trimmed: content || '', wasTrimmed: false };
  }

  const parts = content.split('\n');
  const rawLen = content.length;

  if (headChars + tailChars >= rawLen) {
    return { trimmed: content, wasTrimmed: false };
  }

  const head = takeHead(parts, headChars);
  const tail = takeTail(parts, tailChars);
  const note = `\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return {
    trimmed: `${head}\n...\n${tail}${note}`,
    wasTrimmed: true,
  };
}

/**
 * Prune context messages to fit within a token budget.
 *
 * Strategy:
 *   1. If usage < softTrimRatio: no pruning needed
 *   2. Soft trim: truncate old tool results (head+tail)
 *   3. Hard clear: replace old tool results with placeholder
 *   4. Never prune: system messages, last N assistant turns
 *
 * @param {Array<{role: string, content: string, toolName?: string}>} messages
 * @param {object} opts
 * @param {number} opts.contextWindowTokens - Total context budget in tokens
 * @param {object} [opts.settings] - Override default settings
 * @param {function} [opts.isToolPrunable] - (toolName) => boolean
 * @returns {Array} Pruned messages (same structure)
 */
function pruneContext(messages, opts) {
  const { contextWindowTokens } = opts;
  const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  if (!contextWindowTokens || contextWindowTokens <= 0) return messages;

  const charWindow = contextWindowTokens * CHARS_PER_TOKEN;
  if (charWindow <= 0) return messages;

  // Pre-pass: strip base64 data URLs before measuring chars
  let preStripped = null;
  try {
    const { stripBase64 } = require('./contextCompressor');
    for (let i = 0; i < messages.length; i++) {
      if (typeof messages[i].content !== 'string') continue;
      const { text, strippedCount } = stripBase64(messages[i].content);
      if (strippedCount > 0) {
        if (!preStripped) preStripped = messages.slice();
        preStripped[i] = { ...messages[i], content: text };
      }
    }
  } catch { /* contextCompressor not available */ }
  const workingMessages = preStripped || messages;

  // Find pruning boundaries
  const cutoffIndex = _findAssistantCutoff(workingMessages, settings.keepLastAssistants);
  if (cutoffIndex === null) return workingMessages;

  const firstUserIndex = workingMessages.findIndex(m => m.role === 'user');
  const pruneStart = firstUserIndex >= 0 ? firstUserIndex : workingMessages.length;

  const isToolPrunable = opts.isToolPrunable || (() => true);

  // Estimate total chars
  let totalChars = 0;
  const charCounts = workingMessages.map(m => {
    const c = estimateWeightedChars(m.content || '');
    totalChars += c;
    return c;
  });

  let ratio = totalChars / charWindow;
  if (ratio < settings.softTrimRatio) return workingMessages;

  // Identify prunable tool result indexes
  const prunableIndexes = [];
  for (let i = pruneStart; i < cutoffIndex; i++) {
    const msg = workingMessages[i];
    if (msg.role !== 'tool' || !isToolPrunable(msg.toolName || '')) continue;
    prunableIndexes.push(i);
  }

  // Phase 1: Soft trim
  let result = null;
  for (const i of prunableIndexes) {
    const msg = (result || workingMessages)[i];
    const { trimmed, wasTrimmed } = softTrimToolResult(msg.content, settings.softTrim);
    if (!wasTrimmed) continue;

    if (!result) result = workingMessages.slice();
    const beforeChars = charCounts[i];
    const afterChars = estimateWeightedChars(trimmed);
    result[i] = { ...msg, content: trimmed };
    totalChars += afterChars - beforeChars;
    charCounts[i] = afterChars;
  }

  ratio = totalChars / charWindow;
  if (ratio < settings.hardClearRatio || !settings.hardClear.enabled) {
    return result || workingMessages;
  }

  // Check if prunable chars are worth the effort
  let prunableChars = 0;
  for (const i of prunableIndexes) {
    prunableChars += charCounts[i];
  }
  if (prunableChars < settings.minPrunableToolChars) {
    return result || workingMessages;
  }

  // Phase 2: Hard clear
  for (const i of prunableIndexes) {
    if (ratio < settings.hardClearRatio) break;
    const msg = (result || workingMessages)[i];
    if (!result) result = workingMessages.slice();

    const beforeChars = charCounts[i];
    result[i] = { ...msg, content: settings.hardClear.placeholder };
    const afterChars = estimateWeightedChars(settings.hardClear.placeholder);
    totalChars += afterChars - beforeChars;
    charCounts[i] = afterChars;
    ratio = totalChars / charWindow;
  }

  return result || workingMessages;
}

function _findAssistantCutoff(messages, keepLast) {
  if (keepLast <= 0) return messages.length;
  let remaining = keepLast;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    remaining--;
    if (remaining === 0) return i;
  }
  return null;
}

module.exports = {
  pruneContext,
  softTrimToolResult,
  takeHead,
  takeTail,
  estimateWeightedChars,
  estimateTokensFromChars,
  DEFAULT_SETTINGS,
  CHARS_PER_TOKEN,
  CJK_CHARS_PER_TOKEN,
  IMAGE_CHAR_ESTIMATE,
  PRUNED_IMAGE_MARKER,
};
