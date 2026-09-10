'use strict';

/**
 * Compression service — intelligent text compression for LLM context.
 * Reduces token usage while preserving key information.
 */

// ── Text Compression ──
function compressText(text, options = {}) {
  const ratio = options.ratio || 0.5;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim());

  if (sentences.length <= 1) {
    return text;
  }

  // Score sentences by importance
  const scored = sentences.map((sentence, index) => {
    let score = 0;
    const lower = sentence.toLowerCase();

    // Position bonus (first/last sentences are more important)
    if (index === 0) score += 3;
    if (index === sentences.length - 1) score += 2;

    // Length bonus (medium-length sentences are more informative)
    const words = sentence.split(/\s+/).length;
    if (words >= 5 && words <= 20) score += 1;

    // Keyword bonus
    const keywords = options.keywords || [];
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) score += 2;
    }

    return { sentence, score, index };
  });

  // Sort by score and take top N
  const targetCount = Math.max(1, Math.ceil(sentences.length * ratio));
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, targetCount);

  // Restore original order
  selected.sort((a, b) => a.index - b.index);

  return selected.map((s) => s.sentence.trim()).join('. ') + '.';
}

// ── Context Window Compression ──
function compressContext(messages, maxTokens = 4000) {
  const totalTokens = estimateTokens(JSON.stringify(messages));

  if (totalTokens <= maxTokens) {
    return messages;
  }

  const ratio = maxTokens / totalTokens;
  const compressed = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Keep system messages intact
      compressed.push(msg);
    } else if (msg.content && typeof msg.content === 'string') {
      const compressedContent = compressText(msg.content, { ratio });
      compressed.push({ ...msg, content: compressedContent });
    } else {
      compressed.push(msg);
    }
  }

  return compressed;
}

// ── Token Estimation ──
function estimateTokens(text) {
  // Rough estimation: ~4 characters per token
  return Math.ceil(text.length / 4);
}

// ── Truncation ──
function truncateText(text, maxTokens = 1000) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '...';
}

module.exports = {
  compressText,
  compressContext,
  estimateTokens,
  truncateText,
};
