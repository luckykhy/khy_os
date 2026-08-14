'use strict';

/**
 * toolResultCompressor — pre-send compression for tool results.
 *
 * Before tool results enter the LLM conversation history, we truncate and
 * compress them to save tokens. This follows Y-code's pattern of:
 * 1. Pre-truncating large results before sending to LLM
 * 2. Keeping head + tail with a placeholder in the middle
 * 3. Replacing very large results with a preview summary
 *
 * @module toolResultCompressor
 */

const compressText = require('../utils/sourceTextCompressor');

// ── Constants ──

/** Results larger than this get truncated with head+tail+placeholder */
const LARGE_RESULT_CHARS = 10_000;

/** For truncated results, keep this many chars from the start */
const HEAD_CHARS = 3_000;

/** For truncated results, keep this many chars from the end */
const TAIL_CHARS = 3_000;

/** Max chars to keep for tool results without truncation */
const DEFAULT_MAX_CHARS = 8_000;

/** For very large results, show this much as a preview */
const PREVIEW_CHARS = 1_500;

/**
 * Truncate a tool result for inclusion in conversation history.
 *
 * Strategy:
 * - Small results (< DEFAULT_MAX_CHARS): pass through (optionally compress whitespace)
 * - Medium results (DEFAULT_MAX_CHARS — LARGE_RESULT_CHARS): compress + truncate to DEFAULT_MAX_CHARS
 * - Large results (> LARGE_RESULT_CHARS): keep head + tail, insert placeholder
 * - Very large results (> 100K chars): replace with preview summary + instruction to re-run with limit
 *
 * @param {string} content - Raw tool result content
 * @param {object} [opts] - Override options
 * @param {number} [opts.maxChars] - Max chars to keep (default: DEFAULT_MAX_CHARS)
 * @returns {{ content: string, wasTruncated: boolean, originalChars: number, compressedChars: number }}
 */
function truncateForContext(content, opts = {}) {
  if (!content || typeof content !== 'string') {
    return { content: '', wasTruncated: false, originalChars: 0, compressedChars: 0 };
  }

  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const originalChars = content.length;

  // Pass-through if already small enough
  if (originalChars <= maxChars) {
    // Still compress whitespace if it's >500 chars
    if (originalChars > 500) {
      const { compressed, stats } = compressText.compress(content);
      return {
        content: compressed,
        wasTruncated: false,
        wasCompressed: stats.savedPercent > 3,
        originalChars,
        compressedChars: Buffer.byteLength(compressed, 'utf8'),
        savedPercent: stats.savedPercent,
      };
    }
    return { content, wasTruncated: false, originalChars, compressedChars: originalChars };
  }

  // Very large: replace with preview + re-run instruction
  if (originalChars > 100_000) {
    const preview = content.slice(0, PREVIEW_CHARS);
    const truncated = `${preview}\n\n[... 输出过长 (${originalChars.toLocaleString()} 字符)，已截断。如需完整内容请增加 limit 参数重新读取。]`;
    return {
      content: truncated,
      wasTruncated: true,
      truncationReason: 'very_large',
      originalChars,
      compressedChars: Buffer.byteLength(truncated, 'utf8'),
    };
  }

  // Large: head + tail with placeholder
  if (originalChars > LARGE_RESULT_CHARS) {
    const head = content.slice(0, HEAD_CHARS);
    const tail = content.slice(-TAIL_CHARS);
    const omitted = originalChars - HEAD_CHARS - TAIL_CHARS;
    const truncated = `${head}\n\n[... 中间省略 ${omitted.toLocaleString()} 字符 ...]\n\n${tail}`;
    return {
      content: truncated,
      wasTruncated: true,
      truncationReason: 'head_tail_omitted',
      originalChars,
      compressedChars: Buffer.byteLength(truncated, 'utf8'),
      omittedChars: omitted,
    };
  }

  // Medium: truncate to maxChars
  const truncated =
    content.slice(0, maxChars) +
    `\n\n[... 已截断，共 ${originalChars.toLocaleString()} 字符，显示前 ${maxChars.toLocaleString()} 字符 ...]`;
  const compressed = compressText.wouldCompress(truncated)
    ? compressText.compress(truncated).compressed
    : truncated;

  return {
    content: compressed,
    wasTruncated: true,
    truncationReason: 'exceeded_max',
    originalChars,
    compressedChars: Buffer.byteLength(compressed, 'utf8'),
  };
}

/**
 * Truncate tool results in a conversation history array.
 * Modifies messages in place (creates shallow copies of tool result messages).
 *
 * @param {Array} messages - Conversation messages
 * @param {object} [opts] - Override options
 * @returns {Array} Modified messages
 */
function truncateToolResultsInHistory(messages, opts = {}) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const truncated = truncateForContext(msg.content, opts);
      result.push({
        ...msg,
        content: truncated.content,
        _truncated: truncated.wasTruncated,
        _originalChars: truncated.originalChars,
      });
    } else {
      result.push(msg);
    }
  }
  return result;
}

module.exports = {
  truncateForContext,
  truncateToolResultsInHistory,
  LARGE_RESULT_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  DEFAULT_MAX_CHARS,
  PREVIEW_CHARS,
};
