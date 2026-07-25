/**
 * Response Compressor — reduce token consumption in LLM responses.
 *
 * Strategies:
 *   1. Strip redundant whitespace / formatting
 *   2. Collapse repeated patterns
 *   3. Remove filler phrases
 *   4. Truncate excessively long tool outputs
 */

const FILLER_PATTERNS = [
  /^(Sure|Of course|Certainly|Absolutely|Great question)[,!.\s]*/i,
  /^(Let me|I'll|I will|I can|I'd be happy to)\s+/i,
  /^(Here(?:'s| is| are) (?:the|a|an|your|some))\s+/i,
  /\b(as (?:you can see|mentioned|noted|shown))[,.\s]*/gi,
  /\b(it(?:'s| is) (?:worth noting|important to note|worth mentioning) that)\s*/gi,
  /\b(please note that|keep in mind that|bear in mind that)\s*/gi,
];

const WHITESPACE_PATTERNS = [
  { pattern: /\n{3,}/g, replacement: '\n\n' },
  { pattern: /[ \t]{2,}/g, replacement: ' ' },
  { pattern: /^\s+$/gm, replacement: '' },
];

/**
 * Compress a text response to reduce tokens.
 * @param {string} text - The LLM response text
 * @param {Object} options
 * @param {boolean} options.stripFillers - Remove filler phrases (default: true)
 * @param {boolean} options.collapseWhitespace - Collapse excessive whitespace (default: true)
 * @param {number} options.maxLength - Truncate at this character count (0 = no limit)
 * @returns {{ text: string, stats: { original: number, compressed: number, savedPercent: number } }}
 */
function compressResponse(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { text: text || '', stats: { original: 0, compressed: 0, savedPercent: 0 } };
  }

  const {
    stripFillers = true,
    collapseWhitespace = true,
    maxLength = 0,
  } = options;

  const originalLength = text.length;
  let result = text;

  // Collapse whitespace
  if (collapseWhitespace) {
    for (const { pattern, replacement } of WHITESPACE_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
  }

  // Strip filler phrases
  if (stripFillers) {
    for (const pattern of FILLER_PATTERNS) {
      result = result.replace(pattern, '');
    }
    result = result.replace(/^\s+/, '');
  }

  // Collapse repeated lines (e.g., separator lines)
  result = result.replace(/(^.{1,40}$)\n(\1\n?){2,}/gm, '$1');

  // Truncate if needed
  if (maxLength > 0 && result.length > maxLength) {
    result = result.slice(0, maxLength) + '\n... [truncated]';
  }

  const compressedLength = result.length;

  return {
    text: result.trim(),
    stats: {
      original: originalLength,
      compressed: compressedLength,
      savedPercent: originalLength > 0
        ? Math.round((1 - compressedLength / originalLength) * 100)
        : 0,
    },
  };
}

/**
 * Compress a tool output for inclusion in conversation context.
 */
function compressToolOutput(output, maxChars = 4000) {
  if (!output || typeof output !== 'string') return output || '';
  if (output.length <= maxChars) return output;

  // Keep head and tail for context
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  const head = output.slice(0, headSize);
  const tail = output.slice(-tailSize);
  const omitted = output.length - headSize - tailSize;

  return `${head}\n\n... [${omitted} chars omitted] ...\n\n${tail}`;
}

module.exports = { compressResponse, compressToolOutput };
