/**
 * Command Rewriter — compress multi-turn conversation history to reduce tokens.
 *
 * Strategies:
 *   1. Summarize old turns into a single context block
 *   2. Deduplicate repeated instructions
 *   3. Strip already-executed tool calls from history
 *   4. Merge consecutive same-role messages
 */

/**
 * Rewrite conversation history to minimize token count.
 * Keeps the last N turns verbatim, summarizes older ones.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} options
 * @param {number} options.keepRecent - Number of recent turns to keep verbatim (default: 4)
 * @param {number} options.maxHistoryTokens - Approximate token budget for summarized history (default: 500)
 * @returns {{ messages: Array, stats: { originalCount: number, rewrittenCount: number, estimatedSaved: number } }}
 */
function rewriteHistory(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], stats: { originalCount: 0, rewrittenCount: 0, estimatedSaved: 0 } };
  }

  const { keepRecent = 4, maxHistoryTokens = 500 } = options;

  // Separate system message
  const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
  const conversation = systemMsg ? messages.slice(1) : [...messages];

  if (conversation.length <= keepRecent) {
    return {
      messages: [...messages],
      stats: { originalCount: messages.length, rewrittenCount: messages.length, estimatedSaved: 0 },
    };
  }

  // Split into old (to summarize) and recent (to keep). A gated guard fixes the
  // keepRecent<=0 case where `slice(0,-0)`/`slice(-0)` invert the split (see leaf).
  let oldTurns, recentTurns;
  let _split = null;
  try {
    _split = require('../recentTurnsSplit').splitRecent(conversation, keepRecent, process.env);
  } catch { /* fail-soft → legacy slice below */ }
  if (_split) {
    oldTurns = _split.oldTurns;
    recentTurns = _split.recentTurns;
  } else {
    oldTurns = conversation.slice(0, -keepRecent);
    recentTurns = conversation.slice(-keepRecent);
  }

  // Build summary of old turns
  const summary = _summarizeTurns(oldTurns, maxHistoryTokens);

  const rewritten = [];
  if (systemMsg) rewritten.push(systemMsg);
  if (summary) {
    rewritten.push({
      role: 'system',
      content: `[Previous conversation summary]\n${summary}`,
    });
  }
  rewritten.push(..._mergeSameRole(recentTurns));

  const originalTokens = _estimateTokens(messages);
  const rewrittenTokens = _estimateTokens(rewritten);

  return {
    messages: rewritten,
    stats: {
      originalCount: messages.length,
      rewrittenCount: rewritten.length,
      estimatedSaved: Math.max(0, originalTokens - rewrittenTokens),
    },
  };
}

/**
 * Summarize a list of conversation turns.
 */
function _summarizeTurns(turns, maxTokens) {
  const maxChars = maxTokens * 4;
  const points = [];

  for (const turn of turns) {
    const content = typeof turn.content === 'string' ? turn.content : JSON.stringify(turn.content);

    if (turn.role === 'user') {
      const truncated = content.slice(0, 200).replace(/\n/g, ' ').trim();
      points.push(`User asked: ${truncated}`);
    } else if (turn.role === 'assistant') {
      // Strip tool calls, keep only text decisions
      const cleaned = content
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/```[\s\S]*?```/g, '[code block]')
        .slice(0, 200)
        .replace(/\n/g, ' ')
        .trim();
      if (cleaned) points.push(`Assistant: ${cleaned}`);
    }
  }

  let summary = points.join('\n');
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars) + '...';
  }

  return summary;
}

/**
 * Merge consecutive same-role messages.
 */
function _mergeSameRole(messages) {
  const merged = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role && typeof last.content === 'string' && typeof msg.content === 'string') {
      last.content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

/**
 * Rough token estimate (~4 chars per token).
 */
function _estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += c.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Strip completed tool calls from messages to save context tokens.
 */
function stripCompletedToolCalls(messages) {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;

    const stripped = msg.content
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '[tool executed]')
      .replace(/```(?:bash|shell|sh)\n[\s\S]*?```/g, '[command executed]');

    return { ...msg, content: stripped };
  });
}

module.exports = { rewriteHistory, stripCompletedToolCalls };
