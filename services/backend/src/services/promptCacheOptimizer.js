'use strict';

/**
 * promptCacheOptimizer.js — 4-tier watermark prompt compression system.
 *
 * Inspired by Y-code's memory_compressor.py 4-tier watermark architecture.
 * Optimizes prompt caching for AI models (especially DeepSeek prefix cache)
 * by separating stable/dynamic content and applying progressive compression.
 *
 * Architecture:
 *   - Tier 1 (60%): Snip — local rewrite, remove redundant content
 *   - Tier 2 (80%): Elide — local rewrite, truncate verbose sections
 *   - Tier 3 (95%): Summarize — LLM-based compression (expensive, deferred)
 *   - Tier 4 (99%+): Emergency — aggressive truncation with user notice
 *
 * Key capabilities:
 *   1. Stable/dynamic prompt separation for cache efficiency
 *   2. Progressive compression based on watermark thresholds
 *   3. Per-tool noise classification for smart truncation
 *   4. Head+tail preservation for truncated content
 *   5. Cache hit rate tracking and optimization
 *
 * @module promptCacheOptimizer
 */

const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────────────────

// Watermark thresholds (percentage of context window)
const WATERMARK = Object.freeze({
  SNIP: 0.60,      // Tier 1: Start local rewrite
  ELIDE: 0.80,     // Tier 2: Truncate verbose sections
  SUMMARIZE: 0.95, // Tier 3: LLM-based compression
  EMERGENCY: 0.99, // Tier 4: Aggressive truncation
});

// Compression ratios per tier
const COMPRESSION_RATIO = Object.freeze({
  SNIP: 0.70,      // Remove 30% of content
  ELIDE: 0.50,     // Remove 50% of content
  SUMMARIZE: 0.30,  // Reduce to 30% of original
  EMERGENCY: 0.10,  // Keep only 10% of content
});

// Tool result classification for smart truncation
const TOOL_NOISE_CLASS = Object.freeze({
  HIGH_VALUE: 'high_value',     // Keep: errors, summaries, key results
  REPETITIVE: 'repetitive',     // Snip: build logs, verbose output
  STRUCTURED: 'structured',     // Elide: large JSON, data dumps
  BINARY: 'binary',             // Truncate: base64, binary content
});

// Patterns for noise classification
const NOISE_PATTERNS = {
  BUILD_LOG: /^(npm|pnpm|yarn|node|gcc|clang|rustc|go|mvn|gradle|cargo)\s+/m,
  HTTP_LOG: /^\[\d{4}-\d{2}-\d{2}.*(GET|POST|PUT|DELETE|PATCH)/m,
  STACK_TRACE: /\s+at\s+.*\(.*:\d+:\d+\)/m,
  BASE64: /(?:^[A-Za-z0-9+/]{50,}={0,2}$)/m,
  JSON_DUMP: /^\s*[{[]/m,
  SUCCESS: /^(success|成功|完成|done|ok)/im,
  ERROR: /^(error|失败|错误|fail|exception)/im,
};

// ── Token Estimation ─────────────────────────────────────────────────────

/**
 * Estimate token count from text.
 * Uses a simple heuristic: ~4 characters per token for mixed content.
 * For production, replace with tiktoken or similar.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  // Mixed CJK/ASCII: CJK chars are ~1 token each, ASCII ~4 chars per token
  const cjkChars = (str.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const otherChars = str.length - cjkChars;
  return cjkChars + Math.ceil(otherChars / 3.5);
}

/**
 * Estimate tokens for a message array.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number}
 */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
    return sum + estimateTokens(content) + 4; // 4 tokens for message framing
  }, 0);
}

// ── Tool Result Classification ────────────────────────────────────────────

/**
 * Classify tool result content for compression strategy.
 * @param {string} toolName
 * @param {string} content
 * @returns {string} One of TOOL_NOISE_CLASS values
 */
function classifyToolResult(toolName, content) {
  if (!content || content.length < 100) return TOOL_NOISE_CLASS.HIGH_VALUE;

  // Check for high-value patterns first
  if (NOISE_PATTERNS.ERROR.test(content)) return TOOL_NOISE_CLASS.HIGH_VALUE;
  if (NOISE_PATTERNS.SUCCESS.test(content) && content.length < 500) return TOOL_NOISE_CLASS.HIGH_VALUE;

  // Check for stack traces (high value for debugging)
  if (NOISE_PATTERNS.STACK_TRACE.test(content)) return TOOL_NOISE_CLASS.HIGH_VALUE;

  // Check for repetitive logs
  if (NOISE_PATTERNS.BUILD_LOG.test(content)) return TOOL_NOISE_CLASS.REPETITIVE;
  if (NOISE_PATTERNS.HTTP_LOG.test(content)) return TOOL_NOISE_CLASS.REPETITIVE;

  // Check for binary/base64 content
  if (NOISE_PATTERNS.BASE64.test(content)) return TOOL_NOISE_CLASS.BINARY;

  // Check for structured data
  if (NOISE_PATTERNS.JSON_DUMP.test(content) && content.length > 2000) return TOOL_NOISE_CLASS.STRUCTURED;

  return TOOL_NOISE_CLASS.STRUCTURED;
}

// ── Compression Strategies ────────────────────────────────────────────────

/**
 * Tier 1: Snip — remove redundant whitespace and boilerplate.
 * @param {string} text
 * @returns {string}
 */
function snip(text) {
  if (!text) return text;
  return text
    .replace(/[ \t]+$/gm, '')          // Trim trailing whitespace first
    .replace(/\n{3,}/g, '\n\n')       // Collapse multiple blank lines
    .replace(/<!--[\s\S]*?-->/g, '')   // Remove HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove block comments
    .replace(/^\s*\/\/.*$/gm, '');     // Remove line comments
}

/**
 * Tier 2: Elide — truncate verbose middle sections, keep head and tail.
 * @param {string} text
 * @param {number} [ratio=0.5] - Target ratio of original to keep
 * @returns {string}
 */
function elide(text, ratio = COMPRESSION_RATIO.ELIDE) {
  if (!text) return text;
  const targetLen = Math.floor(text.length * ratio);
  if (text.length <= targetLen) return text;

  const headLen = Math.floor(targetLen * 0.7);
  const tailLen = targetLen - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  const omitted = text.length - headLen - tailLen;

  return `${head}\n... [已省略 ${omitted} 字符] ...\n${tail}`;
}

/**
 * Tier 3: Summarize placeholder — marks content for LLM-based compression.
 * Actual summarization is deferred to avoid blocking.
 * @param {string} text
 * @returns {string}
 */
function summarize(text) {
  if (!text) return text;
  // For now, apply aggressive elide as a placeholder
  // In production, this would trigger an LLM call
  return elide(text, COMPRESSION_RATIO.SUMMARIZE);
}

/**
 * Tier 4: Emergency — keep only the most critical content.
 * @param {string} text
 * @returns {string}
 */
function emergency(text) {
  if (!text) return text;
  const targetLen = Math.floor(text.length * COMPRESSION_RATIO.EMERGENCY);
  // Keep first 60% and last 40% of target
  const headLen = Math.floor(targetLen * 0.6);
  const tailLen = targetLen - headLen;
  return `${text.slice(0, headLen)}\n... [紧急压缩] ...\n${text.slice(text.length - tailLen)}`;
}

// ── Smart Truncation ──────────────────────────────────────────────────────

/**
 * Smart truncation based on tool result classification.
 * @param {string} toolName
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
function smartTruncate(toolName, content, maxChars) {
  if (!content || content.length <= maxChars) return content;

  const classification = classifyToolResult(toolName, content);

  switch (classification) {
    case TOOL_NOISE_CLASS.HIGH_VALUE:
      // Keep as much as possible, only truncate if way over
      if (content.length > maxChars * 2) {
        return elide(content, maxChars / content.length);
      }
      return content;

    case TOOL_NOISE_CLASS.REPETITIVE:
      // Aggressive elide — repetitive content compresses well
      return elide(content, Math.min(0.3, maxChars / content.length));

    case TOOL_NOISE_CLASS.STRUCTURED:
      // Keep structure, truncate values
      return elide(content, Math.min(0.5, maxChars / content.length));

    case TOOL_NOISE_CLASS.BINARY:
      // Truncate binary content heavily
      return `[二进制内容已省略: ${content.length} 字符]`;

    default:
      return elide(content, Math.min(0.5, maxChars / content.length));
  }
}

// ── Prompt Cache Optimizer Class ──────────────────────────────────────────

/**
 * Main optimizer class that manages prompt compression based on
 * watermark thresholds and context window budget.
 */
class PromptCacheOptimizer {
  /**
   * @param {object} [options]
   * @param {number} [options.contextWindow] - Model context window size
   * @param {number} [options.reservedTokens] - Tokens to reserve for response
   * @param {object} [options.watermark] - Custom watermark thresholds
   */
  constructor(options = {}) {
    this._contextWindow = options.contextWindow || 128000;
    this._reservedTokens = options.reservedTokens || 4096;
    this._watermark = { ...WATERMARK, ...(options.watermark || {}) };
    this._stats = {
      totalCalls: 0,
      snipCount: 0,
      elideCount: 0,
      summarizeCount: 0,
      emergencyCount: 0,
      tokensSaved: 0,
    };
  }

  // ── Properties ──────────────────────────────────────────────────────

  get contextWindow() { return this._contextWindow; }
  set contextWindow(value) { this._contextWindow = value; }

  get reservedTokens() { return this._reservedTokens; }
  set reservedTokens(value) { this._reservedTokens = value; }

  get stats() { return { ...this._stats }; }

  /**
   * Calculate the effective budget for prompt content.
   * @returns {number}
   */
  getBudget() {
    return this._contextWindow - this._reservedTokens;
  }

  /**
   * Calculate current watermark tier based on token usage.
   * @param {number} usedTokens
   * @returns {number} Watermark tier (0-4)
   */
  getWatermarkTier(usedTokens) {
    const ratio = usedTokens / this.getBudget();
    if (ratio >= this._watermark.EMERGENCY) return 4;
    if (ratio >= this._watermark.SUMMARIZE) return 3;
    if (ratio >= this._watermark.ELIDE) return 2;
    if (ratio >= this._watermark.SNIP) return 1;
    return 0;
  }

  // ── Core Optimization ────────────────────────────────────────────────

  /**
   * Optimize messages for prompt caching.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} systemPrompt
   * @returns {object} Optimized { messages, systemPrompt, stats }
   */
  optimize(messages, systemPrompt) {
    this._stats.totalCalls++;

    const msgTokens = estimateMessagesTokens(messages);
    const sysTokens = estimateTokens(systemPrompt);
    const totalTokens = msgTokens + sysTokens;
    const tier = this.getWatermarkTier(totalTokens);

    if (tier === 0) {
      return { messages, systemPrompt, stats: { tier: 0, tokensBefore: totalTokens, tokensAfter: totalTokens, saved: 0 } };
    }

    let optimizedMessages = messages;
    const optimizedSystem = systemPrompt;
    let tokensAfter = totalTokens;

    // Apply compression based on tier
    if (tier >= 1) {
      // Tier 1: Snip tool results
      optimizedMessages = this._snipToolResults(optimizedMessages);
      this._stats.snipCount++;
    }

    if (tier >= 2) {
      // Tier 2: Elide verbose tool results
      optimizedMessages = this._elideToolResults(optimizedMessages);
      this._stats.elideCount++;
    }

    if (tier >= 3) {
      // Tier 3: Summarize old messages
      optimizedMessages = this._summarizeOldMessages(optimizedMessages);
      this._stats.summarizeCount++;
    }

    if (tier >= 4) {
      // Tier 4: Emergency truncation
      optimizedMessages = this._emergencyTruncate(optimizedMessages);
      this._stats.emergencyCount++;
    }

    tokensAfter = estimateMessagesTokens(optimizedMessages) + estimateTokens(optimizedSystem);
    const saved = Math.max(0, totalTokens - tokensAfter);
    this._stats.tokensSaved += saved;

    return {
      messages: optimizedMessages,
      systemPrompt: optimizedSystem,
      stats: {
        tier,
        tokensBefore: totalTokens,
        tokensAfter,
        saved,
        ratio: tokensAfter / totalTokens,
      },
    };
  }

  // ── Tier Implementations ─────────────────────────────────────────────

  /**
   * Tier 1: Snip redundant content from tool results.
   * @param {Array} messages
   * @returns {Array}
   */
  _snipToolResults(messages) {
    return messages.map(msg => {
      if (msg.role !== 'tool' && msg.role !== 'function') return msg;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      const snipped = snip(content);
      if (snipped.length < content.length * 0.95) {
        return { ...msg, content: snipped };
      }
      return msg;
    });
  }

  /**
   * Tier 2: Elide verbose tool results.
   * @param {Array} messages
   * @returns {Array}
   */
  _elideToolResults(messages) {
    return messages.map(msg => {
      if (msg.role !== 'tool' && msg.role !== 'function') return msg;
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      const toolName = msg.name || msg.tool_name || 'unknown';
      const maxChars = 2000; // Max chars per tool result at this tier
      return { ...msg, content: smartTruncate(toolName, content, maxChars) };
    });
  }

  /**
   * Tier 3: Summarize old messages (keep recent ones intact).
   * @param {Array} messages
   * @returns {Array}
   */
  _summarizeOldMessages(messages) {
    // Keep last 10 messages intact, summarize older ones
    const KEEP_RECENT = 10;
    if (messages.length <= KEEP_RECENT) return messages;

    const toSummarize = messages.slice(0, messages.length - KEEP_RECENT);
    const recent = messages.slice(messages.length - KEEP_RECENT);

    // Simple summarization: keep only user messages and first 100 chars of tool results
    const summarized = toSummarize.map(msg => {
      if (msg.role === 'user') return msg;
      if (msg.role === 'assistant') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.length > 200) {
          return { ...msg, content: content.slice(0, 200) + '...[已摘要]' };
        }
        return msg;
      }
      // Tool/function results: keep minimal
      return { ...msg, content: '[历史工具结果已摘要]' };
    });

    return [...summarized, ...recent];
  }

  /**
   * Tier 4: Emergency truncation — keep only essential messages.
   * @param {Array} messages
   * @returns {Array}
   */
  _emergencyTruncate(messages) {
    // Keep only: system, last 5 user messages, and their immediate responses
    const KEEP_LAST = 5;
    const systemMsgs = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const recent = nonSystem.slice(-KEEP_LAST * 2); // Keep pairs

    return [...systemMsgs, ...recent];
  }

  // ── Stable/Dynamic Separation ────────────────────────────────────────

  /**
   * Split system prompt into stable prefix and dynamic suffix.
   * Stable prefix can be cached; dynamic suffix changes per request.
   *
   * @param {string} systemPrompt
   * @param {string} boundaryMarker
   * @returns {object} { stable, dynamic }
   */
  static splitSystemPrompt(systemPrompt, boundaryMarker = '__DYNAMIC_BOUNDARY__') {
    if (!systemPrompt) return { stable: '', dynamic: '' };
    const escapedMarker = boundaryMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markerRe = new RegExp(`\\n?${escapedMarker}\\n?`);
    const match = markerRe.exec(systemPrompt);
    if (!match) return { stable: systemPrompt, dynamic: '' };
    return {
      stable: systemPrompt.slice(0, match.index),
      dynamic: systemPrompt.slice(match.index + match[0].length),
    };
  }

  /**
   * Build a cache-optimized system prompt with boundary marker.
   * @param {string} stablePrefix
   * @param {string} dynamicSuffix
   * @param {string} [boundaryMarker]
   * @returns {string}
   */
  static buildSystemPrompt(stablePrefix, dynamicSuffix, boundaryMarker = '__DYNAMIC_BOUNDARY__') {
    if (!dynamicSuffix) return stablePrefix || '';
    return `${stablePrefix || ''}\n${boundaryMarker}\n${dynamicSuffix}`;
  }

  // ── Cache Key Generation ─────────────────────────────────────────────

  /**
   * Generate a cache key for prompt content.
   * @param {string} systemPrompt
   * @param {Array} tools
   * @param {string} model
   * @returns {string}
   */
  static computeCacheKey(systemPrompt, tools, model) {
    const data = JSON.stringify({
      system: systemPrompt.slice(0, 1000), // First 1000 chars of system
      tools: (tools || []).map(t => t.name || t.function?.name || '').sort(),
      model: model || '',
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // ── Statistics ───────────────────────────────────────────────────────

  /**
   * Get optimization statistics.
   * @returns {object}
   */
  getStats() {
    return {
      ...this._stats,
      avgSavings: this._stats.totalCalls > 0
        ? Math.round(this._stats.tokensSaved / this._stats.totalCalls)
        : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats() {
    this._stats = {
      totalCalls: 0,
      snipCount: 0,
      elideCount: 0,
      summarizeCount: 0,
      emergencyCount: 0,
      tokensSaved: 0,
    };
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  PromptCacheOptimizer,
  WATERMARK,
  COMPRESSION_RATIO,
  TOOL_NOISE_CLASS,
  estimateTokens,
  estimateMessagesTokens,
  classifyToolResult,
  snip,
  elide,
  summarize,
  emergency,
  smartTruncate,
};
